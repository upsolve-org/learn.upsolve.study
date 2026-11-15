# Supabase accounts and hosted model for the LearnHarness fork

Revision 3, 15 November 2026. Status: **proposed for approval** under AGENTS.md. Supersedes revisions 1 and 2 (same file) and the Vite-era RUNNING_PLAN.md. No application change and no migration has run yet; the only fleet changes so far are disk recoveries on the target server (see "Target server").

Revision 1 was reviewed against the code and against the server. Ten gaps were found and were folded into revision 2: the synchronous storage ports, the `strong`-slot sharing that makes the hosted default a data-egress decision, the unanswered `vision` slot, the missing hosted-mode switch, per-object identity for runtimes, timezone, the shared GPU, the list of Supabase objects, the `waterfalls` model-list dependency and the job-delivery ownership bug.

Revision 3 records the owner's instruction to route every user through the owner's gateway (`https://llmrouter.boyemma.com/v1`, models `auto` / `flash`), probed directly for capability before being planned. Checking it against the code surfaced two things: the custom route's implicit image support, which this endpoint genuinely satisfies, and the empty model record that makes a fresh copy start with a refusal on every turn.

## Confirmed requirements

- Keep the newly imported LearnHarness application and its existing learning UI.
- Google sign-in, chosen by the user, through Supabase Auth.
- Supabase PostgreSQL for persistent account-owned learning data.
- The model hosted on the operator's server is the default route.
- Optional personal API keys and custom endpoints remain reachable, from the approved product direction.
- Multiple users without sharing progress, credentials or conversations.

## Decisions taken for revision 2

These were open in revision 1. They are recommendations put to the owner and are shown here as decided only so the rest of the plan can be written; each is marked so it can be overturned cheaply.

| # | Question | Decision |
|---|---|---|
| D0 | Which route every user gets | The owner's gateway `https://llmrouter.boyemma.com/v1`, served from a fixed operator section — not a new provider. One served model id, `auto` (1 M context, no rate limit, spend not a constraint). Revision 3; details in step 4. |
| D1 | `vision` slot under the hosted default | `vision` routes to `auto` as an **image-capable** route: the gateway accepts image blocks and answers them correctly (probed 15 Nov). Visual maker and PDF reader keep their image path. |
| D2 | Per-owner model overrides in v1 | None. The custom route is the only model route for everyone in v1; personal keys, subscription providers and other endpoints are read-only display until the post-v1 model-connections step. Every picker description stays short because it cannot vary per student. |
| D3 | Is extraction hosted? | Yes. The tutor is worthless without the graph, so `extractor` and `auditor` ride the hosted default and are **required**: if the gateway is down, extraction refuses honestly with the existing `ModelsNotConfiguredError` / `ProviderKeyMissingError` envelopes and says so in the activity dock. Consequence: learner text leaves Supabase for the gateway. |
| D4 | Deployment shape | No fourth process. Hosted mode is an environment switch inside the existing Next server. No local model server in v1, so the GPU guard and the T4 stay idle. |
| D5 | Storage interface shape | Keep every port method **synchronous** and implement the adapters over a long-lived Postgres connection with blocking calls. Rationale in step 2. |

## Findings that shape the implementation

| Location | Current behavior | Required adaptation |
|---|---|---|
| `src/core/ports.ts` | 100 % synchronous interfaces | Keep synchronous; new adapters are blocking SQL. No call-site sweep. |
| `src/server/chats.ts:25` | Re-exports the **bare** `createChat` from the fs store | Agent tools call `ctx.chatId`/`createChat` without a store handle; the hosted adapter must reach the owner from the request scope (step 2.2). |
| `src/server/stores.ts` | One module-level singleton composition root | Still one root, but owner-parameterized: `forOwner(owner)` builds the views once per turn. |
| `src/core/settings-resolution.ts` | Unset slots resolve to `null` → honest refusal | Hosted default inserted **beneath** unset only, and only when hosted mode is on. Every role maps to `strong` or `cheap`, so the default fills both. |
| `src/core/settings.ts:326` | `prober`, `teacher`, `sideQuestion` **and** `extractor`, `auditor` all map to `strong` | One hosted pin fills all five at once — this *is* the D3 egress. |
| `src/subagents/extraction.ts:810` | Stage readiness refuses before any batch | Works unchanged once hosted fills the slot; keep the refusal honest, never silently skip a stage. |
| `src/agent/models.ts:139` | Custom routes are **always** given `input: ["text", "image"]`, regardless of metadata | Right for this endpoint, but implicit; make it a configurable `image` flag (step 4.2). |
| `src/server/settings-body.ts:377` / `app/api/settings/[section]` | The picker writes `models` as a whole-section replace, and every pin wins for that user | In fixed mode store `models: {}` and keep only level/retention riders (step 4.4). |
| Model record | `data/settings.json` in this copy is `{version, claudeCode, appearance}`: no models, no `customProvider` | The endpoint coordinates are not in the repository; the hosted fixed section is part of the deploy (step 4.3). |
| `src/server/jobs.ts` | Delivery registry keyed by `chatId` only | Per-owner key (step 3). |
| `src/server/turn-runs.ts`, `turn-liveness.ts` | Live registry keyed by `chatId` only | Per-owner key; TTL recovery already survives a restart. |
| `src/server/custom-provider.ts:36` | One module-global source with a private fingerprint, keyed by the constant `CUSTOM_PROVIDER.id` | Leave the plumbing; the hosted deployment serves the same provider from a fixed section (step 4). |
| `src/agent/models.ts:64` | `configureProviderSource` retires routes of the previous source | Unchanged: one source remains a valid configuration. |
| `src/core/auth-keys.ts:199` (`keys.ts`) | Built-in providers gate on env key presence | Unknown provider falls through to `true` (`keys.ts:206`) already; `custom` gates on `customProviderAvailable()`. |
| `src/core/events.ts`, `src/server/events-stream.ts` | One unfiltered process-wide bus | Owner tag on every event; stream filters by owner. |
| `src/store/plugin-data-paths.ts` | One directory per plugin (`data/plugins/<id>`, core: `data/core-plugin-data/<id>`) | Owner segment inserted in the path. |
| `plugins/flashcards/src/store.cjs:52` | `openStore(directory)`, `flashcards.json` + `sources/<id>.md` | The backend already receives a directory; the hosted backend registry passes the owner-scoped one. |
| `plugins/flashcards/src/scheduler.cjs:24,41` | `dayBounds`/`studyDay` use process-local `Date#setHours` | App server runs UTC: a 04:00 study day would tick at 04:00 UTC = 07:00 in Türkiye. |
| `app/layout.tsx` | Shared appearance and app providers before any check | Split public sign-in/callback from authenticated providers. |
| `src/server/desktop-access.ts:7` | `browserOnlyMode()` is true whenever `LH_DESKTOP_API_SECRET` is unset | A server deployment silently runs loopback trust: anyone reaching the port reads every chat. |
| `proxy.ts` | Covers `/api` except the streamed document route | Adds session refresh and coarse redirects; the document route needs its own identity check. |

There are 46 API route files. Authorization must cover reads, writes, streams, uploads, exports, plugin routes and cancellation.

## Target server

`66.181.46.15` (`Pandev`, root over SSH). Ubuntu 22.04.5, 4 vCPU, 15 GiB RAM, **no swap**, 99 GiB disk, one idle Tesla T4.

With the gateway remote the T4 is idle for this work. The box still hosts the web app, Postgres and the model calls' egress.

- An unrelated Node app already owns `0.0.0.0:8100` and answers `/api/health`; it must not be disturbed. The web app binds `127.0.0.1:8300` behind Caddy on 443.
- Node v26.9.0 with full ICU 78.3 is installed and matches CI. `en_UTF-8` is the only locale; `tr_TR` may stay absent (no code path needs it).
- No model weights are needed here unless the gateway is ever self-hosted. llama.cpp is still compiled at `/root/llama.cpp/build/bin` and `/root/models/` is empty.
- `/root/gpu_guard.sh` still toggles the LLM against an unloaded `dual-render` unit and fails as written — only relevant if the app ever serves its own model again.
- `/tmp/herdr_tty.log` was truncated in place once (4.4 G). No rotation exists and it regrows at roughly 18 KB/s, so a logrotate rule belongs to this deploy.
- Free space was 38 G of 99 G before the Supabase images; 27 G remains after them (the stack itself is ~20 G of pulled layers). Budget: `node_modules` ≈ 1.5 G, Postgres growth and build output.
- RAM is the tighter resource: 6.2 GiB available with the stack idle. Every Supabase service runs `restart: unless-stopped` and there is no swap, so Caddy and the app must not be pushed into an OOM contest.

### 0.1 Supabase stack, as deployed (15 Nov)

Self-hosted from the pinned `self-hosted/v0.8.4` release template, at `/srv/supabase/supabase-project`. The image pull, the `db` start failure and every wiring check below were done on the box; this section records what exists so the code work rests on verified facts rather than assumptions.

| Item | State |
|---|---|
| Containers | 11, all healthy: `db`, `auth`, `rest`, `storage`, `realtime`, `functions`, `meta`, `studio`, `imgproxy`, `envoy`, `pooler` |
| Bindings | `127.0.0.1` only — gateway `8000`, pooler session `5432` and transaction `6543`. Nothing listens on a public interface |
| Keys | `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` generated by the release's `add-new-auth-keys.sh`; asymmetric ES256 JWT signing, opaque API-key translation live in envoy |
| Signup | `DISABLE_SIGNUP=true` (verified: `422 signup_disabled`), email confirmation auto-enabled |
| Accounts | Admin creation via `POST /auth/v1/admin/users` with the secret key (verified), password grant returns a valid ES256 token with the account's `sub` (verified) |
| Google | Env and compose lines in place, `GOOGLE_ENABLED=false` until credentials exist (open item) |
| Data path | admin SQL → `pg_meta`, table → PostgREST read via `anon` (verified); `storage/v1` 200; `/auth/v1/health` 200 |
| Redis | absent, so GoTrue keeps sessions and rate-limit state in memory. Correct for one instance; a restart drops them |

**Port wrinkle worth keeping.** `POSTGRES_PORT` is used both as the host-side port publish and as the in-container `PGPORT`. It must therefore stay a bare `5432`, and every loopback binding is written into `docker-compose.yml` itself (`127.0.0.1:${POSTGRES_PORT}:5432`). The `.env` port variables hold bare numbers only. Setting `POSTGRES_PORT=127.0.0.1:5432` makes `initdb` die with `invalid value for parameter "port"`. A `docker-compose.override.yml` cannot fix this either: short-syntax `ports` entries are not merged per service, and a stale `.env` prefix produced `127.0.0.1:127.0.0.1:5432`, so the override was removed again.

**PostgREST profiles.** `PGRST_DB_SCHEMAS=auth,public,graphql_public` makes `auth` the default profile (so a bare `GET /rest/v1/users` reaches `auth.users`) and `PGRST_DB_EXTRA_SEARCH_PATH=public,auth` keeps unqualified `public.*` names resolvable. Grants on the auth schema had to be issued as `supabase_admin`, which owns it — `postgres` on this image is not a superuser, so its `GRANT` on `auth` silently applied nothing.

### 0.2 Public ingress, as deployed (15 Nov)

| Item | State |
|---|---|
| DNS | `learn.upsolve.study` A `66.181.46.15`, DNS-only at the registrar (Vercel). Confirmed from Cloudflare, Google and the box; apex and `www` stay on Vercel |
| Firewall | `80/tcp` and `443/tcp` opened in `ufw`; everything else unchanged |
| Caddy | v2.11.9 from the official apt repo, `/etc/caddy/Caddyfile`, Let's Encrypt certificate issued and verified (valid to 13 Feb, HTTP `308` → HTTPS) |
| Upstream | `reverse_proxy 127.0.0.1:8300`, `flush_interval -1` for chat streams; the app never binds the public interface |
| Log | `/var/log/caddy/learn.log`, 20 MB × 5 rotation |

**`/var/log/caddy` must be owned by `caddy:caddy`.** The service runs as `caddy`; a root-owned directory fails the start with `permission denied` while `caddy validate` still passes, so the failure only shows in `journalctl`.

## Proposed implementation

### 1. Identity and hosted mode

`HOSTED_MODE=off|on` is a server-only switch. `off` is today's behaviour for desktop and local work. `on` changes four things together and none of them alone:

- `apiRequestRefusal` accepts the Supabase session cookie as the capability instead of the desktop secret; in hosted mode a missing session is a `401` JSON instead of a `403`, and private pages redirect through Proxy.
- `browserHostAllowed` is skipped (public hostnames are the point) while the same-origin write check is retained alongside `APP_ORIGIN`.
- every authenticated request carries an owner (step 2).
- model resolution gains the hosted default (step 4).

Missing Supabase configuration in `on` fails closed at boot with one clear error rather than degrading to loopback trust.

Supabase clients: `@supabase/ssr` browser and server clients with cookie sessions. A `/auth/login` page (email + password) calls `signInWithPassword`; the callback at `/auth/callback` exchanges a code for a cookie session (used by Google and by email links); a sign-out action. Return paths are validated against a same-origin allowlist. Sign-out clears per-user client caches and live subscriptions.

Email/password is live now because `Pandev` needs nothing external for it. Google is wired the same way but stays hidden until a client id and secret exist (`GOOGLE_ENABLED=false` today, and the `providers` array from `/auth/v1/settings` drives the button): the redirect URI is `http://localhost:8000/auth/v1/callback`, the flow is `signInWithOAuth({ provider: 'google' })`, and the code lands on the same callback.

Signups stay closed (`DISABLE_SIGNUP=true`), so accounts are created by the operator through `POST /auth/v1/admin/users` with the secret key. Hosted admin routes can reuse that key server-side later; nothing about it reaches the browser.

Supabase's own email sending is not usable out of the box (the stack has no SMTP container), which is why email confirmation is auto-enabled rather than waiting on mail delivery.

The owner is only ever the verified `auth.uid()`. A submitted user id is never trusted, including in the service-credential paths of step 2.

Admission stays an invited pilot for now: the server checks the address against an admins-inserted allowlist *before* provisioning a learner workspace, so a successful login alone does not grant access. The allowlist rows carry the same `owner_id` as everything else.

### 2. Storage

#### 2.1 Sync ports over a blocking driver

The tests contain roughly 1 120 `chatStore.` / `graphStore.` / `jobStore.` / `stores.` call sites and several suites import the store singletons directly; the chat tools reach `createChat` through the re-export at `src/server/chats.ts:25`. Converting 46 routes, the services, the tools and that many assertions to `await` buys nothing the runtime needs, because each blocked host is idle for the whole call anyway.

So the ports stay synchronous and the adapters run on `postgres.js` with one pooled connection per process and its blocking RPC through a dedicated worker thread. Round trips are sub-millisecond on loopback; the fs stores use blocking `fs` calls today with the same consequences.

The cost is honest and stated: a slow query blocks that process for its duration. Mitigations: statement timeout of 5 s, bounded pool, and index everything the sidebar and extraction read paths touch. If profiling later shows starvation, the ports move to `Promise<T>` as one deliberate sweep; the SQL and the owner threading do not change.

#### 2.2 Owner threading without argument churn

`forOwner(owner)` returns the store set. It is called at the request boundary (`withOwner` wrapper for route handlers and the Proxy-refreshed page load), so `ctx.chatStore` holds the owner. The four cases that have no `ctx` get explicit support:

| Case | Mechanism |
|---|---|
| Agent tools calling the bare `createChat` re-export | Create (and persist) the chat bound to the request owner from an `AsyncLocalStorage` scope set by `withOwner`; resolve the owner from it inside the adapter. |
| Background jobs, extraction, wakes | The job row carries `owner_id`; the worker calls `forOwner(job.ownerId)` and scopes the ALS when it runs the job. |
| Plugin host processes | Owner travels in the plugin runtime context; the backend factory gets the owner-scoped data directory. |
| Server view rendering | Owner read once from the session in the page and passed down. |

#### 2.3 Schema

| Table | Purpose |
|---|---|
| `profiles` | Display name, avatar, UTC offset |
| `pilot_admissions` | Invited Google addresses |
| `learner_profiles` | Learner preferences |
| `settings` | `UserSettings` (JSONB plus `owner_id`, version) |
| `model_connections` | Personal keys and custom endpoints, encrypted (post-v1) |
| `chats` | `ChatRecord` and `ChatSummary` columns; messages and trees stay JSONB |
| `graph_nodes`, `graph_chains`, `session_checkpoints`, `coverage` | Extraction ledgers, append-only |
| `positions` | Per-owner layout ledger |
| `sources`, `source_organization` | Imported-note provenance |
| `jobs` | Background job records with `owner_id` |
| `extraction_runs` | Extraction-run state with `owner_id` |
| `plugin_records` | Plugin agent/task records |
| `plugin_flashcards`, `plugin_flashcard_sources` | Flashcard state JSONB and source markdown |
| `themes` | Per-owner theme files |
| `turn_usage`, `extraction_usage` | Money channel, unique per turn or `startedAt`, as the fs adapters already enforce |
| `attachments` | Bytea ≤1 MiB, with MIME type; Storage for larger files |

Every table carries `owner_id uuid not null references auth.users` and RLS with `owner_id = auth.uid()` for all four verbs; polymorphic children get an `owner_id` of their own so policies never join.

**Not ported:** `plugins-state.json`. Plugin installation stays operator-owned on the server.

**Postgres access:** the app connects as one role that is *not* the table owner, via `SUPABASE_DB_URL` on `127.0.0.1:5432` inside the Compose network. That gives real RLS enforcement in production and not just in tests. Each request sets `request.jwt.claims` with the verified `sub`/`role`, so the policies evaluate honestly. Background work sets the job owner for its own transactions instead of a service credential; nothing bypasses RLS.

The role `learn_webapp` is deployed already: login, `rollsuper = f`, `CREATE`/`USAGE` on `public`, `SELECT` on `auth.users`, and owner-scoped default privileges so tables it creates stay in its own reach. Verified end to end: create/insert/select/drop over the loopback pooler all succeed, and `auth.users` reads. Its password is on the box at `/root/learn-webapp-db.txt` and goes into `SUPABASE_DB_URL` only.

**Owner identity comes from the verified token, never from a trusted header.** The app already holds the session cookie, and it can verify the access token locally against the JWKS at `GET /auth/v1/.well-known/jwks.json` (ES256) instead of a network round-trip per request. The verified `sub` is the owner and `auth.uid()` under RLS; role `authenticated`.

`sanitize` as written is insufficient. ``, `,`, `:`, `..` can leave `/` standing, so a crafted `sub` could still escape the `data/hosted/<owner>/` jail. The path segment is the canonical UUID in lowercase (from the verified token, not from the request) and an assertion guarantees it is one.

**Concurrency:** chats are read-modify-write today. `saveMessages`, `appendTurnUsage`, `appendExtractionUsage` and `updateSideChats` become row-locked transactions so a wake cannot clobber a concurrent turn; graph appends and chain assertions are `INSERT`s and stay so.

**Leave alone:** `customAuthState`'s file snapshot on the sync path (step 4) and the theme files until step 2 ships.

### 3. Liveness, events, plugins

- `turn-runs`, `turn-liveness` and job delivery switch to composite `owner:chatId` keys. Without this, two users' chats collide in the same process — including job results delivered into the wrong chat when ids repeat after an import.
- Every `emit` payload gains `owner`; `eventsResponse` filters on it so one student's sidebar never sees another's `chats-changed`.
- Plugin directories gain the owner: `data/hosted/<owner>/plugins/<id>/` for community plugins and `data/hosted/<owner>/core-plugin-data/<id>/` for core. The flashcard backend receives that directory unchanged; no plugin code fork.
- Hosted path jail: learner file access (`fileAccess` folders) resolves under `data/hosted/<owner>/uploads/`. The desktop-only tools (arbitrary local paths, process management, Claude Code subscription) are hidden on the hosted build's tool surface until isolation is proven.

### 4. The owner's gateway (D0)

Everyone is routed to the owner's endpoint, an OpenAI-compatible gateway at `https://llmrouter.boyemma.com/v1`. It is not this repository copy's record — the settings here hold no `models` and no `customProvider` — so the coordinates come from the owner and are set as deployment config at step 4:

```dotenv
HOSTED_MODE=on
FIXED_CUSTOM_PROVIDER=on
FIXED_CUSTOM_BASE_URL=https://llmrouter.boyemma.com/v1
FIXED_CUSTOM_MODELS=auto
FIXED_CUSTOM_AUTH_MODE=apiKey
FIXED_CUSTOM_API_KEY=sk-...
FIXED_CUSTOM_IMAGE=true
FIXED_CUSTOM_CONTEXT_WINDOW=1000000
FIXED_CUSTOM_MAX_TOKENS=1000000
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:8000
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_DB_URL=postgresql://learn_webapp:...@127.0.0.1:5432/postgres
APP_ORIGIN=
GPU_GUARD_URL=http://127.0.0.1:8390
```

The model id is `auto`. No server of ours sits in the model path any more, so the GPU guard and the T4 are idle for this work (`GPU_GUARD_URL` stays in the env only for the desktop path).

**The `auto`/`flash` split does not survive a fresh look** (details under the probe table below), so `FIXED_CUSTOM_MODELS` lists `auto` alone.

Endpoint facts established by direct probing on 15 November 2026 — each is a capability the code depends on, not an assumption:

| Probe | Result |
|---|---|
| `GET /v1/models` with the key | 200, lists `auto` and `flash` only |
| Chat completion, non-streaming | 200, usage present (`prompt_tokens`, `completion_tokens`, `total_tokens`) |
| Chat completion, streaming with `stream_options.include_usage` | 200, chunks in event-stream order, final chunk carries usage, `[DONE]` |
| Tool call with a JSON-schema function | 200, well-formed `tool_calls` with id, name and arguments |
| 44 k-token prompt | 200, and `prompt_tokens_details.cached_tokens` reports cache hits |
| Image block (`image_url` with a `data:` PNG/BMP) | 200 and correct answer; `completion_tokens_details.image_tokens` reported |
| `response_format: json_object` | 200, valid JSON |
| `reasoning_effort: low` | accepted, no `reasoning_content` returned and `reasoning_tokens` 0 |
| `max_tokens: 26000` | accepted, no cap error |

Base URL and model ids are on record. The owner also states `auto` has **no rate limit and a 1 M-token context**, no output-token cap, that spend does not matter yet, reasoning stays **off** and cache retention is **not** set.

**The `auto`/`flash` split does not survive a fresh look.** The picker's slot compositions only produce `{provider: "custom", id` (both ids are discovered models of that one provider), so any model entry the code pins itself is, at build time, a model id the operator's endpoint has not seen yet. `buildOpenAiCompatibleProvider` would serve that entry under `custom`, and `piEngineForSpec` looks it up by `(provider, id)` — the hard-coded id would therefore miss the discovered catalog, including its `baseUrl`. The simplest robust fix is **one served model id, `auto`**, for every slot: the record stays `{}`, nothing is pinned, the picker is read-mostly and `waterfalls` is moot. `flash` is a one-line env change later. (The alternative — synthesising `auto` and `flash` into the fixed model list from env — is only worth it if `flash` must actually differ.)

#### 4.1 Credential stays server-side

The custom helper already reads `process.env[CUSTOM_PROVIDER.envVar]` and reflects file keys into `env`; the fixed section is used with the same precedence so the secret never reaches the browser or the database. The key-presence gate keeps working because `providerKeyPresent("custom")` asks `customProviderAvailable()`.

#### 4.2 The image flag, now true

`piEngineForSpec` wraps every custom model with `input: ["text", "image"]` (`src/agent/models.ts:139`), and custom discovery only treats a model as image-capable when the endpoint's metadata says so. The gateway accepts real PNG/BMP data URLs and answers them, so this is *correct* for this endpoint — record it explicitly instead of relying on the wrapper. Keep the implicit wrapper for the desktop, add `image` to `CustomProviderSettings` (default false) read in `toPiModel`, and set `FIXED_CUSTOM_IMAGE=true`; D1's `vision` slot then genuinely is an image-capable route, so visual maker and PDF reader keep their image path.

#### 4.3 Server-enforced fixed section

When `FIXED_CUSTOM_PROVIDER=on`, the read-side settings resolution overlays `customProvider` from those env values, so every learner sees the endpoint even with an empty record — the rebuilt container carries no `data/`. The models section is seeded unset, so the hosted default below applies to all three slots immediately.

#### 4.4 The record stays empty

The picker writes the `models` section (`PUT /api/settings/[section]` with `section = models`, via `composeSlotModel`) as a **whole-section** replace: `composeSlotModel` spreads the current models and writes the composed slot objects. Any pin anyone saves lands verbatim in that user's record and wins for that user from then on — including for a later `auto` → `flash` a/b decision the deployment makes.

Because there is exactly one served id and ordinary slots cannot express a model the endpoint does not yet know (4.5), the section is **locked** in the same write seam: after `parseModelsSettingsBody`, a successful write stores `models: {}` and keeps only the level / retention riders. Nothing is pinned, so the picker is read-mostly, `waterfalls` cannot fire, and swapping the served model stays an env change. Per-chat session overrides remain free.

#### 4.5 Slots and picker

| Slot | Roles | Served id |
|---|---|---|
| `strong` | prober, teacher, sideQuestion, extractor, auditor | `auto` (D3 egress applies) |
| `cheap` | researcher, demoBuilder | `auto` |
| `vision` | visualMaker, pdfReader | `auto`, image-capable (D1) |

Every slot resolves to the same discovered entry, with `contextWindow: 1000000` and `maxTokens: 1000000` from the fixed section, so neither the `8 192` / `4 096` custom defaults nor a reply cap apply.

**Reasoning stays off and no cache retention is set** (owner, 15 Nov): neither `reasoning` nor `cacheRetention` goes into the fixed slot objects, so pi resolves every engine at the `off` level and pi-ai sends no `cacheRetention` field. The picker shows the single hosted entry (D2).

Extraction stays required: with the endpoint down the existing `ModelsNotConfiguredError` / `ProviderKeyMissingError` refusals surface in the activity dock rather than a silent skip.

Note how the empty record interacts with roles: `effectiveSettings().models` only feeds background roles, and the conversation chain falls back to `effective.models.strong`, which the hosted default fills — both resolve without a pin.

#### 4.6 Probe

A startup probe resolves the base URL, confirms the served id is advertised and that a minimal completion returns usage. The deep hosted probe (`probeModelUpstream` re-requests without the endpoint override) is dropped as unreachable. Add the fixed section to the "all built-ins unreachable" suite.

#### 4.7 Only the deployment is affected

The desktop run still reads `data/settings.json` and its own `auth.json`; fixed mode is an env switch, so an existing personal custom endpoint is neither migrated nor broken.

### 5. No local model server

The model path is remote, so nothing has to be built on `Pandev` for the gateway: no weights, no llama.cpp run, no GPU guard. The guard-based exclusive-GPU design applies only if the fleet ever serves its own model with `--jinja` again.

What remains on `Pandev` is the web app, Postgres and egress. One shared route (`auto`, no rate limit, 1 M context) serves every learner at once; spend is not a constraint yet.

### 6. Flashcard civil calendar

`dayBounds`, `studyDay` and `ordinal` take an explicit offset instead of `Date#setHours`. `profiles.utc_offset_min` (default +180) and the existing `dayStart` hour come from the backend context. A study day "04:00" then means 04:00 in the learner's zone. Add the owner scope to the card table in the same step.

### 7. Import and validation

- Existing `data/` and credential files stay untouched. One live agent exists to carry over; **after independent Supabase backups, restore `pg_dump` locally and diff row counts** against the files before that agent is invited. Whatever this copy's settings record holds for models or `customProvider` is **not** migrated — fixed mode supplies both.
- Personal credentials are not part of the import.
- Two-account suites over chats, graph, flashcards, sources, preferences, jobs, streams and abort. Forged ids, expired sessions, open-redirect attempts, sign-out clearing, concurrent turn plus wake, extraction versus graph read, and a mid-turn upstream failure.
- RLS checked against the disposable Supabase project, not mocked.
- With hosted mode on and no Supabase env: boot refuses. With hosted mode off: the entire desktop suite passes.
- **Proxy body clone (measured 15 Nov, still open upstream).** Any request through the Proxy loses the epilogue of a part that declares no `Content-Length` of its own — every browser multipart, both file uploads. Two 64 KiB chunks vanish (27,328,695 sent, 27,197,623 delivered, deterministic) yet the body still parses, so it is silent. `proxyClientMaxBodySize` only bounds the buffering; it is not a gate. Mitigation in place: both upload paths use `readProxyBoundedFormData`, which bounds the live stream so an oversized upload is a real `413` before the truncation matters, and the 25 MiB file checks stay authoritative. Uploads comfortably below 26 MiB still lose their trailing epilogue harmlessly.
- Targeted upstream suites, then `tsc --noEmit`, `eslint .`, then a production build. **The full `npm test` is not a gate in this local environment** until the inherited failures are separated from regressions.
- A two-student concurrency run against the gateway before opening the pilot: does `auto` hold under simultaneous turns (streaming latency, 429s, context)?

## Delivery order

1. Identity, hosted mode, owner threading, schema.
2. Account-scoped chats, graph, settings.
3. Jobs, events, plugin isolation, path jail.
4. Fixed endpoint section, image flag, slot lock.
5. Flashcards, import, full validation.
6. OAuth and the live run on `Pandev`.

The app stays private throughout; a login-only intermediate state is not the finished multi-user application.

## Open — the only blockers left

All model questions are settled: one id (`auto`), 1 M context, no output cap, reasoning off, no cache retention, spend and rate limits not a constraint.

1. **Public hostname.** `learn.upsolve.study` is assumed. It decides the redirects and Caddy config.
2. **Google OAuth client.** Needs your project's client id and secret; everything else about that path is ready.
3. **Reachability and egress consent.** Never checked from `Pandev`; step 4 sends every learner's text through a third-party host.

## Completion

Two Google accounts learn, refresh, sign out and resume independently; a new account gets the hosted endpoint with no key entered; personal connections stay isolated; the two-account suites and RLS checks pass with only documented exceptions.

## Configuration needed for live verification

- The public app hostname and its `/auth/callback` origin for `ADDITIONAL_REDIRECT_URLS`. `learn.upsolve.study` is still an assumption; only the local `http://localhost:8300/auth/callback` is registered today.
- A Google OAuth client id and secret. Until then `GOOGLE_ENABLED=false` and only email/password accepts logins.
- `FIXED_CUSTOM_API_KEY` for the deployment dotenv (the key lives in this plan only as a placeholder).
- The pilot admission list.

Known values, already generated on `Pandev` and never committed: the gateway URL and keys, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, the `learn_webapp` database password.

Approval should cover the conversion, the invited pilot, the synchronous port decision and serving every learner from the operator's endpoint. Google sign-in itself is already confirmed; only its credentials are outstanding.

## Sources

Next.js guides at `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md` and `01-app/02-guides/authentication.md`; Supabase [SSR](https://supabase.com/docs/guides/auth/server-side/creating-a-client) and [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security); `supabase db pull` for committing migrations. The stack facts in 0.1 come from the live deployment. AGENTS.md requires investigation and approval before implementation; approval of this revision is that approval.