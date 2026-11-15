# Deployment recovery, 15 November 2026

## Confirmed cause

The deployed Caddyfile sent every path to Next.js. A request to the app's `/auth/v1/settings` returned `307` to `/auth/login?next=%2Fauth%2Fv1%2Fsettings`. The login page fetched that same public auth URL and followed redirects, causing further login renders. This explains the repeated login logs and CPU consumption without assuming a separate Next.js hot loop.

Restoring a dedicated Caddy `handle /auth/v1/*` to `127.0.0.1:8000` changed the unauthenticated auth-settings result to the expected `401`. Subsequent direct login renders measured 102, 17, 20 and 18 ms. The app CPU-time counter remained at 20:07 across an idle sample. Before the fix, the same probe measured 584 ms, 5.28 s and 5.28 s.

The previous handoff's recommendation to restore `.bak-3` was stale: that backup also lacked the auth route. A timestamped backup of the live Caddyfile was made, the candidate validated, and Caddy reloaded. No listener-wrapper experiments were applied. Only the auth service was exposed through this route; this recovery did not add public PostgREST or storage routes.

## Application repairs

- Server auth requests use `SUPABASE_INTERNAL_URL=http://127.0.0.1:8000` through a fetch adapter. The public Supabase URL remains unchanged for cookie names and browser/OAuth behavior. Redirects from auth APIs fail instead of recursively rendering login; calls have a bounded timeout.
- Cookie writes land directly on the selected response. Copying a response's live headers back onto itself duplicates middleware headers and hangs when Set-Cookie entries keep growing. The new regression initially hung and was terminated, then passed with the fix.
- SDK serialization replaces the handwritten cookie formatter, which missed camel-case options and formatted boolean attributes incorrectly.
- Proxy updates the forwarded request cookie jar after refresh.
- OAuth callback cookie writes are collected before the response exists, avoiding access to an uninitialized response variable during code exchange.
- Temporary diagnostics that printed auth/header information were removed from the modified auth paths.
- Private pages and APIs verify identity with GoTrue. The streamed document route enforces the same identity check inside its handler, without reintroducing Proxy body cloning.
- `HOSTED_PILOT_EMAIL` admits exactly one verified email account until owner-scoped persistence exists. Missing configuration denies access. This is a temporary single-account boundary, not multi-user isolation.

## Validation and deployment

Targeted checks cover auth route matching, cookie forwarding, invite admission, anonymous API/upload refusal, internal auth transport and the existing document body-cloning regression. TypeScript and changed-file ESLint checks pass. An inherited temporary probe required an explicit missing-password guard to typecheck; its credentials were not read locally.

Deployment preserves source and environment backups plus the previous `.next` build in a timestamped `/srv/learn-rollback-*` directory. The build script restores the previous build and files if compilation fails. Existing learner data is untouched.

The final production build succeeded and `learn.service` is active. The final rollback directory is `/srv/learn-rollback-1794742108`. Live anonymous checks after restart returned login `200`, home `307`, chats API `401`, models API `401`, and streamed document endpoint `401`.

After explicit user authorization, the live password form passed through public HTTPS: `303` to home with session cookies, followed by `200` for home, new chat, chats API and models API. The settings URL correctly redirects to new chat. Credentials and cookies remained on the server and were omitted from logs. No model invocation was performed.

Public API testing exposed the missing host allowlist. Added `LH_ALLOWED_HOSTS=learn.upsolve.study` to the server environment and restarted the service, preserving the old environment at `/srv/learn-rollback-1794742108/env.before-host-fix`. Authenticated public API requests now return `200`; anonymous requests return `401`.

## Remaining work

Follow-up browser crash repair: the anonymous login inherited all authenticated
providers from the root layout. Sidebar fetch stored `undefined` from a 401 body,
then crashed reading `.length`. A fresh headless browser reproduced the exact
error. The approved fix gates the app providers on verified owner identity in
hosted mode and validates chat responses before replacing sidebar state.
The same deployed-browser check passed through an SSH tunnel at 1280×900 and
390×844: login stayed visible, with no page errors or API requests. The real
password form and authenticated page/API HTTP checks passed again. Public HTTPS
browser navigation from the workstation failed with `ERR_CONNECTION_CLOSED`,
so that network path remains unverified in this follow-up. Production build,
TypeScript and changed-file lint passed. Rollback is preserved at
`/srv/learn-rollback-1794747383`.

The application still has shared filesystem stores. Keep admission limited to the existing operator account. Supabase per-owner persistence, jobs/events/plugin isolation and fixed default-provider behavior must be completed and tested before inviting other learners. The intermittent loopback TLS issue is not claimed fixed; internal auth no longer depends on that path.
