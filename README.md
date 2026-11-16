# UPsolve Learn

**Learning harness for UPB students**, served at [`learn.upsolve.study`](https://learn.upsolve.study).

UPsolve Learn is a hosted Next.js fork of [LearnHarness](https://github.com/amosblomqvist/learnharness) adapted for UPB students: adaptive diagnostic probing, step-by-step teaching, spaced practice, and a persistent knowledge graph.

This README is the setup guide for a developer working on it. For the runtime design, read
[docs/architecture.md](docs/architecture.md) first, then [docs/tenancy.md](docs/tenancy.md)
for the access model.

---

## What you are actually running

Two modes share one codebase. The mode is decided by `HOSTED_MODE`:

| | `HOSTED_MODE` unset/off | `HOSTED_MODE=on` |
|---|---|---|
| Accounts | none — anyone reaching the port has full access | Supabase login, invite-only |
| Data | repo `data/` | `data/hosted/<owner-uuid>/` per learner |
| Models | your own keys in `auth.json` | the operator's default endpoint, plus optional BYOK |

**Local development normally runs with hosted mode OFF.** That skips Supabase
entirely — no accounts, no containers, no email. Turn it on only when you are
working on authentication, admission, or tenancy.

> Hosted mode fails closed at boot. If it is `on` and any required Supabase
> variable is missing, the server refuses to start and names what is missing.

---

## Prerequisites

- **Node 26** (`nvm use 26`, or install it). CI and release builds use 26; the
  lockfile and native modules depend on it.
- A build toolchain for native modules (`@napi-rs/canvas`, `@resvg/resvg-js`,
  `@silvia-odwyer/photon-node`). On Windows install the Visual Studio Build Tools;
  on macOS the Xcode command line tools.
- Git.

Optional, per feature:

- **Chrome/Chromium** — demo verification only. Set `CHROME_PATH` if it is not
  found automatically.
- **A Deepgram key** — dictation.
- **A search key** (Tavily / Brave / Exa / Firecrawl) — research.

---

## Setup (hosted mode off)

```bash
git clone <this repo>
cd learn.upsolve.study
npm ci
npm run plugins:setup     # installs each plugin's locked deps + SDK
npm run dev               # http://localhost:3000
```

`plugins:setup` is required once on a fresh checkout. `dev` and `build` then stage
the four core plugins into `core-plugins/` automatically — **do not run raw
`next dev`**, or the plugin directory stays empty.

### Configure a model

Nothing works until a model is configured; there are no factory defaults. Open
**Settings → Providers** and either:

- paste a provider API key (OpenRouter, OpenAI, Anthropic, …), or
- connect one OpenAI-compatible endpoint under **Custom endpoint**, or
- sign in to a subscription (ChatGPT / Copilot / Grok).

Then pick **Strong**, **Cheap** and **Vision** models. Keys are stored in
`auth.json` at the repo root (gitignored, `0600`); environment variables override
them.

### Where local data lives

`data/` and `auth.json` are gitignored. To keep experiments off your real records,
point both somewhere disposable:

```bash
LH_DATA_DIR=/abs/path/scratch/data \
LH_AUTH_FILE=/abs/path/scratch/auth.json \
npm run dev
```

`npm run dev:fresh` does this for you in `.fresh-data/` with zero keys, for
first-run testing. It is a bash script, so on Windows run it from Git Bash or WSL
— otherwise use the two variables above.

---

## Setup (hosted mode on)

You need a Supabase stack (self-hosted or hosted) with GoTrue. The full deployment
shape is in [docs/supabase-webapp-plan.md](docs/supabase-webapp-plan.md); the
minimum is below.

### 1. Create `.env.local`

`.env.local` is gitignored. Create it at the repo root:

```dotenv
# --- required ---
HOSTED_MODE=on
NEXT_PUBLIC_SUPABASE_URL=https://learn.upsolve.study
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_DB_URL=postgresql://learn_webapp:...@127.0.0.1:5432/postgres

# --- strongly recommended locally ---
# Server-side auth calls bypass the public origin. Without this, auth requests
# go back out through your proxy and can recurse into the login page.
SUPABASE_INTERNAL_URL=http://127.0.0.1:8000
APP_ORIGIN=http://localhost:3000
LH_ALLOWED_HOSTS=localhost

# --- operator ---
ADMIN_EMAIL=you@example.com
# Lets approving a request create the account and show you its password.
# From your Supabase stack's .env, never committed.
SUPABASE_SECRET_KEY=sb_secret_...
```

`SUPABASE_DB_URL` is **required at boot but not yet used** — no Postgres adapter
ships. Any syntactically valid DSN satisfies it.

### 2. Create the operator account

Signups are closed inside GoTrue, so accounts are made by hand:

```bash
curl -X POST "$SUPABASE_INTERNAL_URL/auth/v1/admin/users" \
  -H "apikey: $SUPABASE_SECRET_KEY" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"...","email_confirm":true}'
```

The secret key comes from your Supabase stack's `.env`; it never goes in
`.env.local`.

### 3. Admit yourself

Admission is a separate allowlist from having an account. Either set
`HOSTED_PILOT_EMAIL=you@example.com`, or write `data/admissions.json`:

```json
{ "version": 1, "emails": ["you@example.com"] }
```

Files must be readable by the server user (`0644`). A `0600` file owned by
another account makes admission fail closed with no visible error.

### 4. Optional: a default model for everyone

```dotenv
HOSTED_DEFAULT_BASE_URL=https://your-gateway/v1
HOSTED_DEFAULT_MODEL=auto
HOSTED_DEFAULT_API_KEY=sk-...
```

The key stays server-side — never in a learner record, never sent to the browser.
It is a default, not a pin: a learner's own choice still wins. Without it, every
learner must configure their own model.

### 5. Run

```bash
npm run dev
```

Sign in at `/auth/login`. `/admin` (operator only) lists signup requests.

---

## Signup and approval

`/auth/signup` is public and only **queues** an address into `data/signups.json` —
it creates no account. You approve on `/admin` (reachable from the **Requests**
row at the bottom of the sidebar, operator only).

Approving does two things: it admits the address, and — when `SUPABASE_SECRET_KEY`
is set — it creates the GoTrue account with a generated password and lists that
password on the page. Send it, then press **Done**. Supabase keeps only a hash, so
the page is the only place a password can be read; **Reset** issues a new one.

A verified but unadmitted account lands on `/auth/denied` rather than looping back
to sign-in.

---

## Verification

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint (import-law errors are real failures)
npm test             # unit + integration tests
npm run build        # core plugins + production bundle
```

`npm test` runs `tsx --test`. If `tsx` cannot spawn its esbuild worker (seen on
some sandboxed Windows setups), run files directly:

```bash
node --experimental-transform-types tests/tenancy.test.ts
```

### Known local failures (not regressions)

On Windows these fail on a clean checkout: POSIX mode-bit assertions
(`0o700`/`0o600`), path separators in `appearance-chrome`, `symlink` EPERM in
`source-access`, and a few prompt-composition pins. Compare against a baseline
before blaming your change.

---

## Architecture rules you must not break

`eslint.config.mjs` enforces the layering as errors:

- `components/**` may import **only** `@/src/core`.
- `app/**` may import only `@/src/core` and `@/src/server`.
- `src/core/**` never imports `src/agent`, `src/server`, `src/store`.
- `src/agent/**` never imports `src/server`, `src/store`.

Storage ports are synchronous; the active owner is request state carried by
`AsyncLocalStorage`, not an argument. See [docs/tenancy.md](docs/tenancy.md).

`AGENTS.md` adds one process rule: **do not guess design decisions** — ask.

---

## Deployment

Production is a `next start` process on loopback behind Caddy, with the Supabase
stack bound to loopback too. Operational history and pitfalls are in
[HANDOFF.md](HANDOFF.md) and
[docs/deployment-recovery-2026-11-15.md](docs/deployment-recovery-2026-11-15.md).

Two deployment traps worth knowing:

- **Turbopack can serve a stale bundle** after an interrupted build. Verify the
  built output contains your change (e.g. grep the middleware chunk) before
  trusting a deploy; if not, `rm -rf .next` and rebuild.
- The Caddyfile needs its own `handle /auth/v1/*` route to GoTrue. Without it,
  login fetches auth settings, which redirect back to login, and the app burns CPU.

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — runtime flows, storage, boundaries
- [docs/tenancy.md](docs/tenancy.md) — owner scoping, admission, default model
- [docs/development.md](docs/development.md) — inherited upstream dev guide
- [docs/plugin-authoring.md](docs/plugin-authoring.md) — plugin API
- [docs/supabase-webapp-plan.md](docs/supabase-webapp-plan.md) — deployment plan
- [docs/codebase-briefing.md](docs/codebase-briefing.md) — orientation and known gaps
- [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md)

---

## Attribution & License

Forked from [amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness).

Licensed under [AGPL-3.0](LICENSE).