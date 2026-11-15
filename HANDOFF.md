# Handoff: deployment recovery update

## Current state — 15 November 2026

Model follow-up: configured the supplied gateway key through the authenticated
custom-provider API, with `auto` in strong/cheap/vision slots. The key is in the
server auth store, never this document. Initial tutoring stopped after one token:
the 8192-context fallback minus Pi's 4096-token safety reserve and the tutor prompt
clamped output to 1. User explicitly approved context/maxTokens of 1,000,000;
these are now custom overrides with reasoning false. Browser continuation of
`chat_mwhuzkic_6ce81975` reached a complete diagnostic question awaiting input.
Settings backup: `/srv/learn-model-backup-1794748588417/settings.before-limits.json`.

Public connection diagnosis: DNS answers disagree. At the latest check,
`connie.ns.cloudflare.com` returned `66.181.46.15` with TTL 300; 1.1.1.1 returned
`216.198.79.1`/`216.198.79.65` with about 1035 seconds remaining, and 8.8.8.8
returned `64.29.17.1`/`216.198.79.1` with TTL 1800. Curl using those other answers
failed TLS; `--resolve learn.upsolve.study:443:66.181.46.15` returned 200.
Do not treat this as an application restart problem or change TLS blindly.

Latest fix: login hydration crash repaired and deployed after user approval.
The root layout mounted authenticated providers on anonymous login; the sidebar
read a 401 error body as a chat list and crashed on `.length`. Root layout now
mounts the app providers only for a verified invited owner in hosted mode, and
sidebar refresh checks response status and array shape. Desktop mode is unchanged.
Browser regression reproduced the original error, then passed at desktop and
mobile viewport sizes through an SSH tunnel to the deployed app: login visible,
zero API requests, zero page errors after hydration. Script:
`scripts/smoke-login-browser.mjs`. TypeScript, changed-file lint and production
build passed. Real password form plus authenticated home/new-chat/chats/models
HTTP checks passed. Public HTTPS browser verification from this workstation
failed with `ERR_CONNECTION_CLOSED`; it is not claimed verified by that test.
Latest rollback: `/srv/learn-rollback-1794747383`.

The recovery below supersedes the historical diagnosis that follows. The service
is active after a successful production build. Anonymous live checks return:
login `200`, home `307`, chats/models APIs `401`, and streamed document route
`401`. The real password form and authenticated home, new-chat, chats API and
models API passed through public HTTPS after explicit permission to use the
test account. Model invocation remains unverified.

The CPU/render loop was caused by the live Caddyfile missing its dedicated
`/auth/v1/*` route: login fetched auth settings, which redirected to login again.
Restoring the route to `127.0.0.1:8000` stopped the recursion. Do not restore
`.bak-3`; it also lacks the route. Server auth now uses an internal HTTP transport
while preserving the public SDK URL. Cookie response handling and callback
initialization were repaired, and auth fetches reject redirects and time out.

Private pages and APIs now verify identity, including the streamed document
handler that bypasses Proxy. `HOSTED_PILOT_EMAIL` restricts access to the existing
invited account while stores remain shared. This is not per-user persistence.

Deployment rollback: `/srv/learn-rollback-1794742108` (source, environment and
previous build). Caddy backup: `/etc/caddy/Caddyfile.before-auth-1794741597`.
See `docs/deployment-recovery-2026-11-15.md` for evidence and remaining work.

The user explicitly authorized `/root/account.txt` solely for sign-in testing.
Credentials stayed on the server and were omitted from logs. Public API testing
also found a missing host allowlist; `.env.local` now contains
`LH_ALLOWED_HOSTS=learn.upsolve.study`. Its previous state is saved in
`/srv/learn-rollback-1794742108/env.before-host-fix`. After restart, authenticated
API requests return `200` and anonymous requests return `401`.
The loopback TLS issue is not claimed fixed. Multi-user Supabase persistence and
fixed-provider behavior remain work.

## Historical handoff (superseded diagnosis)

Written 15 Nov 2026. Read this first. Facts below are from measurements on
`root@66.181.46.15` (`Pandev`) this session.

## Goal

Get the LearnHarness fork actually serving at `https://learn.upsolve.study` for
one invited account (`narch@upsolve.study`), then continue the multi-user build
(Supabase accounts, per-owner data). Self-hosted on `Pandev`.

## Bottom line

Two independent faults block the site:

1. **The app server (`next start`, `127.0.0.1:8300`) has an undiscovered hot
   loop.** It burns CPU permanently (`app=1274` jiffies / 10 s ≈ 130 % of one
   core while idle) and pages take 5–130 s or time out entirely. Static files
   still answer in 15 ms, which hides the problem from quick checks.
2. **`127.0.0.1:443` kills a share of connections right after the TCP connect**
   (0.5 s, `000`) unless the client waits before writing. Only loopback is
   affected; eth0 connections are fine.

The signed-in → `/` redirect (`307`) is explained by a third, smaller fault:

3. `proxy.ts` `sessionGate` throws or falls through before deciding. No `DIAG
   session` line ever appears in the journal (17665 lines, all `DIAG page` from
   login page renders), while `/auth/login` returns `200` and the page renders,
   so the `307` comes from the project Proxy, not from the page's own
   `redirect()`.

## What was ruled out

- Reverse-proxy buffering / health checks / retries: HTTP `:80` Caddy
  `handle { … }` probes reached the app and returned the expected `308`.
  `/auth/v1/*` is its own `handle` without retry.
- Stale build: `.next` fresh, `DIAG` strings present in
  `.next/server/chunks/[root-of-the-server]__0u9ul385t94-z._.js` (which also
  holds the `parseCookie` implementation), service running from the same tree.
- DNS / conntrack: `learn.upsolve.study` → `66.181.46.15`, no netns, conntrack
  105 / 262144.
- Cookie handling: `NextRequest.cookies` parses the 2.5 KiB jar exactly
  (`perm-probe.sh` prints `exact true`), `getSession()` on it returns a session
  in 2–4 ms from a Node probe on the box, four times in a row.
- `accept()`: EPA / pktinfo / conntrack timeouts / long keepalive does not
  change a thing.

## Exactly what :443 does

| probe (loopback `127.0.0.1`) | result |
| --- | --- |
| plain HTTP `:80` | 0 / 30 fail |
| TCP connect to `:443` | always OK |
| TLS handshake, no request | 0 / 12 fail |
| handshake, request written ~300 ms later | 3 / 10 fail |
| `curl` (writes request right after the handshake) | 2–5 / 10–20 fail, `000` at ~0.55 s |
| Node `fetch`, default options | 0 / 12 |
| Node `fetch`, `connect.timeout` 20 s | ECONNRESET at ~560 ms, then fine |

So: the first reply byte ~0.5 s after the handshake gets lost if the client has
already written. Clients with short connect timeouts report a failed
connection. Only loopback shows it. The success/failure ratio has stayed at
roughly "a third fail" for hours; it is **not** the older "near-100 % black
hole" from the previous handoff. Nothing in `/var/log/caddy/learn.log` or
`journalctl -u caddy` explains it (no errors, 2–3 ms durations for the
successes).

### What happened with server options

- `/etc/caddy/Caddyfile.bak-3` is the **known-good** site block. Restore it if
  the listener is broken.
- `.bak-4` kept the rejected experiment: global `servers { keepalive 10s;
  backlog 8192 }` plus a loopback-only `proxy_protocol` wrapper on `:443`.
  Result: **TLS dropped to 0 / 10 and `curl` reported `unexpected eof` /`
  tlsv1 alert internal error`**, so the wrapper is the more likely culprit.
  `keepalive 10s` and `backlog` were also rejected by the Caddyfile adapter
  (`unrecognized servers option`; the option names are `keepalive_idle`,
  `keepalive_interval`, `keepalive_count`).
- `.bak-5` is a copy of the broken state, made by the revert script that then
  aborted because `bak-4` did not validate.
- `{ servers { keepalive_idle 10s } }` **does** adapt correctly when it is the
  only line (verified with a minimal config). Expect `srv0.keepalive_idle`
  10000000000 to check it. The `[root-of-the-server]` chunk name is
  **not** the problem — a test with `name probe` was aborted when the temp
  file went missing and was never rerun.
- `proxy_protocol` with `timeout 300ms` + `allow 127.0.0.1/32` did adapt, but
  drove `:443` read-completion to zero even for clients that pause. Drop it.

## Reasons for the `307`

- `.env.local` has no `LH_DIAG`, so the gate's log lines never print.
  Setting it in the dotenv file does reach the server (the login page reads
  `NEXT_PUBLIC_*` from the same file), so it will work once retried.
- Signed-in request: `307` in 3–12 ms.
- `/auth/login`: `200`, full page render, `DIAG page env` fires
  (`currentOwner()` returns null, as it should when signed out).
- Concern worth testing: `.env.local` sets
  `NEXT_PUBLIC_SUPABASE_URL=https://learn.upsolve.study` and
  `src/core/hosted.ts` has no loopback exception. The app's auth calls go back
  *out through Caddy on :443* and meet fault 2. Server-side code should use
  `http://127.0.0.1:8000`.

## Where the app hot loop is proven

- `next-server` pid 3807802: 103 % CPU over 16 minutes, 1.5 GB RSS, 11 threads.
- `curl /auth/login` after a cold start: `200` in **127 s**, `59 s`, `88 s`,
  `28 s`, `14 s`; `000` at a 90 s timeout once.
- `journalctl` shows the service logging `DIAG page env` back-to-back, tens of
  thousands of lines, straight after start.
- `/logo-mark.png` (static) always answers in 15 ms, so the socket server is
  healthy and the work is per-request.

## Files and state

- Code: `C:\Users\narch\Documents\ChatGPT\learn.upsolve.study` (`proxy.ts` with
  the temporary `DIAG` logging, `src/core/hosted.ts`, `src/core/hosted-cookies.ts`,
  `src/core/auth-routes.ts`, `app/auth/*`, `tests/plugin-document-proxy.test.ts`).
- Deployed tree: `/srv/learn` (`.env.local` mode 600, `.probe/` scratch
  scripts that resolve local modules).
- Unit: `learn.service`, `/usr/local/bin/library-node ./node_modules/next/dist/bin/next start -H 127.0.0.1 -p 8300`.
- Credentials: `/root/account.txt` (email line 1, password line 2). DB password
  `/root/learn-webapp-db.txt`, Supabase env `/root/env.json`.
- Probe scripts in `%TEMP%\opencode` (copy to the box before running):
  `diag-run4.sh` (signed-in request + DIAG scan), `perm-probe.sh` (jar through
  `NextRequest` and `getSession`), `p443.sh` (immediate vs gapped request, app
  and caddy CPU), `stage-probe.py`, `tls-stage.sh`, `test-forms.sh`,
  `caddy-keepalive.sh`, `caddy-revert.sh`, `home-probe.sh`, `bridge.py`.
- Logs: `/var/log/caddy/learn.log` (JSON).

### Journal and caddy access-log caveats (nearly cost an hour)

- `journalctl --since <time>` on this box matches **nothing** for recent
  entries; count lines (`journalctl -u learn.service --no-pager | wc -l`) or
  vacuum first (`journalctl -u learn.service --vacuum-time=1s`, then wait ~40 s
  for the checkpointer).
- Caddy's access log is buffered and lags; it is not a live trace.

## Suggested next steps

1. Restore `/etc/caddy/Caddyfile.bak-3`, reload, and add only
   `{ servers { keepalive_idle 10s } }`; confirm with
   `caddy adapt ... | python3 -c ...keepalive_idle` before reloading. Test with
   `p443.sh`.
2. Crash the app on purpose: stop it, `read .env.local`, then
   `100 % CPU` under `node --cpu-prof node_modules/next/dist/bin/next start
   -H 127.0.0.1 -p 8300` and request `/` once with a curl at `-m 300`. Read the
   CPU profile. Compare `journalctl` output under `NODE_OPTIONS=--trace-warnings`
   or after setting `LH_DIAG=1`, so the DIAG lines that make up the flood are
   there to count.
3. Once the app is at sub-second latency, retry `diag-run4.sh` and read the
   first real `DIAG session` / error. Fix the gate or, preferably, move the app's
   `NEXT_PUBLIC_SUPABASE_URL` to `http://127.0.0.1:8000`.
4. Fix the failing test "hosted session gate copies refreshed cookies onto one
   response, not one rebuild per cookie" in
   `tests/plugin-document-proxy.test.ts` (the signed-out `307` writes no
   `Set-Cookie`, so the shallow mock never fills; it needs a signed-in case).
5. Rebuild, redeploy, remove the `DIAG` logging.
6. Report the URL and account, then resume plan steps 1–2: `withOwner`/
   `forOwner`, `postgres.js` adapters, schema + RLS, owner in the proxy. Today
   every route still reads the shared `data/*.json`.

## Constraints

- Service binds loopback only; Caddy is the only public listener.
- Server-side Supabase calls use `http://127.0.0.1:8000`.
- Streaming routes (`*/documents/*`, `/api/chat/api/jobs/*/events`) are exempt
  from retry.
- No local model; gateway `https://llmrouter.boyemma.com/v1`, model `auto`.
- Invite-only, email + password; no public signup.
- Not committed: all repo work is untracked, `master` has zero commits.
