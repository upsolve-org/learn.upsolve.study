# Codebase briefing — UPsolve Learn fork

Written 16 Nov 2026 from a read-only survey of this checkout. Purpose: give a new
engineer the map, the invariants, and the fork's actual deltas — without having to
rediscover them. Not a specification; the source and `docs/architecture.md` win.

Repository: `C:\Users\narch\Documents\ChatGPT\learn.upsolve.study`
Remote: `github.com/upsolve-org/learn.upsolve.study`. Two commits: the upstream
import, then a README rewrite. Working tree clean; `main` only.

---

## 1. What this is

A **fork of LearnHarness** (`amosblomqvist/learnharness`, AGPL-3.0), an AI tutoring
harness. Upstream is a **desktop-first Electron app**: a private Next.js child
process on loopback, BYOK model keys, all state in JSON files under `LH_DATA_DIR`.

This fork turns it into a **hosted web app** at `learn.upsolve.study` for UPB
students, and changes plugin defaults so the shipped plugins come up on their own.
Two things are true at once and must not be conflated:

| | Upstream intent | This fork |
|---|---|---|
| Access | loopback trust, no login | Supabase GoTrue login, invite-only, one pilot email |
| Plugins | discovered disabled, user enables | core plugins auto-enabled at boot |
| Storage | filesystem | **still filesystem** — shared, not per-user |
| Models | BYOK, no factory default | still BYOK; the "fixed gateway" plan is **not implemented** |

The README's "Current Status" is accurate about the deployment and the access
boundary. It is optimistic about the roadmap: multi-user persistence and fixed
model routing are *plans* (`docs/supabase-webapp-plan.md`), not code.

---

## 2. Stack and layout

Next.js **16.4.3** (App Router, Turbopack, `output: "standalone"`), React 19.2,
TypeScript, Tailwind 4. Note `AGENTS.md`: this is not the Next.js in the model's
training data — read `node_modules/next/dist/docs/` first. In Next 16, middleware
is named **Proxy** (`proxy.ts` at the root).

```
app/          58 files — pages + 46 API route handlers (thin wrappers)
components/   180 files — all browser UI (chat.tsx is 162 KB, graph-view 78 KB)
src/core/     pure, browser-safe: contracts, projections, domain algorithms
src/agent/    agent construction, tools, prompts, provider streams, subagents
src/server/   composition, admission, liveness, HTTP-facing services
src/store/    filesystem adapters (chats, graph, jobs, settings, auth, themes)
electron/     desktop shell (main.cjs, preload, updater, credential transport)
plugins/      4 core plugin *sources* + ui-showcase example
core-plugins/ generated build output (gitignored) — what the host actually loads
```

`src/core/index.ts` and `src/server/index.ts` are the **only** barrels `app/` and
`components/` may import. `eslint.config.mjs` enforces this as hard errors and also
forbids core→IO and agent→server/store imports. It is the single most important
architectural rule in the repo; a "fix" that crosses a zone will fail `npm run lint`.

### Commands

`npm ci` → `npm run plugins:setup` (installs per-plugin deps and SDKs) → `npm run dev`.
`dev` and `build` both run `plugins:build-core` and `plugins:build-authoring` first;
raw `next dev` without them leaves `core-plugins/` empty. Checks: `npm run typecheck`,
`npm run lint`, `npm test`, `npm run build`.

`npm test` is `NODE_ENV=test tsx --test tests/*.test.ts tests/*.test.tsx` — 423 test
files, 89 of them plugin-related. On this Windows box `tsx` currently dies with
`spawn EPERM` (esbuild service worker, sandboxed stdio). Workaround that works:
`node --experimental-strip-types tests/<file>.test.ts`. `npm run typecheck` passes
clean; `.next/` holds only `dev/`, so there is no production build in the tree.

---

## 3. The turn pipeline (the core of the app)

`POST /api/chat` → `handleChatRequest` (`src/server/chat-handler.ts:184`) →
`handleChatInput` (`:214`), which is the **turn composition root** and also the
background-wake entry.

Order matters and is deliberate: plugin-question reconcile → input validation →
retry prevalidation → **model-chain gate** (503 `models_not_configured` when the
resolved chain is empty) → key-presence gate → compaction gate → model-change check
(412) → sibling-question short-circuit → **`beginTurn(chatId)` 409 liveness claim**
(`src/server/turn-liveness.ts:59`) → write-ahead `saveMessages` → agent branch
(`hasProbeDone` → teacher, `kind === "practice"` → practitioner, else prober) →
`runPiTurn` → POST returns `{ok:true}` and closes.

The browser then **reattaches** on `GET /api/chats/:id/stream`, which replays the
event log and continues live until `[DONE]`. A disconnect detaches a view; it never
aborts the agent. Explicit abort is `POST /api/activity/abort`.

Settlement is `onFinish` (`chat-handler.ts:860`): persist → usage → extraction kick →
dismissal → `endTurn` → unregister → steer reconciliation → compaction kick.
`endTurn` runs only *after* persist, so "no running turn" always means durable truth.

Two registries (`turn-liveness.ts`, `turn-runs.ts`) and the event bus
(`src/core/events.ts`) are **globalThis-anchored** on purpose: Next compiles each
route as its own module instance, so module-level singletons would be different
objects in the page render and the POST handler. Same reason the plugin host lives
on `globalThis.__lhPlugins`.

### Agents and tools

Three agents over one history: **prober** (`probe`/`recall`, `ask_user_question`,
`probe_done`), **teacher** (`quiz`/`explain`, `plan_init`, job dispatch, `show_image`),
**practitioner** (`problem`, `conclude`). Composition in `src/agent/teacher-agent.ts`
and `src/agent/tools.ts`; `TOGGLEABLE_TOOLS` in `src/core/pending.ts:87` gates the
optional ones. Question tools are client-answered and terminate the turn via a
synthetic placeholder.

Prompts compose from `src/agent/prompts/` — `system-prompt.md` base + numbered
fragments + a shared appendix, joined by `composeInstructions`. User overrides need
both an override file *and* an explicit settings switch.

### Models

No factory default anywhere. `resolveRoleSpec` walks role override → `ROLE_SLOT`
(`prober`/`teacher`/`sideQuestion` → strong; `researcher`/`demoBuilder`/`extractor`/
`auditor` → cheap; `visualMaker`/`pdfReader` → vision) → nothing, and empty refuses
with an honest 503. `piEngineFor` throws rather than substituting.

---

## 4. The fork's actual deltas

### 4.1 Hosted mode (web-first access)

`HOSTED_MODE=on|1|true` is a server-only env switch, never a header
(`src/core/hosted.ts`). It **fails closed at boot** (`instrumentation.ts:14`) naming
every missing variable. With it on:

- `proxy.ts` gains a `sessionGate`: refresh Supabase cookies, verify against GoTrue,
  redirect signed-out page traffic to `/auth/login?next=…`.
- `/api/*` gets `apiGate` → desktop/browser checks **plus** `hostedRequestRefusal`.
- `app/layout.tsx:35` mounts the app providers only for a verified owner, so the
  anonymous login page renders without sidebar/plugins/events.
- `src/core/hosted-admission.ts:7` `pilotUserAllowed` admits exactly one verified
  email (`HOSTED_PILOT_EMAIL`). Missing config denies.

Auth surfaces: `app/auth/login` (email+password server action), `app/auth/callback`
(PKCE exchange), `app/auth/actions.ts` (`signOutAction`). `src/server/supabase.ts`
builds request-scoped `@supabase/ssr` clients; `hostedFetch` rewrites the public
Supabase origin to `SUPABASE_INTERNAL_URL` and sets `redirect: "error"` + a 10 s
timeout so a misrouted ingress can't recurse into login. `hosted-cookies.ts` collects
SDK cookie writes and lands them on the *final* response — copying them onto the
upstream response instead duplicates headers and hangs.

`src/core/owner.ts` verifies the access token locally against the GoTrue JWKS
(ES256) and canonicalises `sub` to a lowercase UUID because it is meant to become a
path segment.

**Gaps worth knowing:**

- `verifyAccessToken` is **not called by any request path.** `currentOwner()` uses
  `supabase.auth.getUser()`, a network round trip per request. The JWKS verifier is
  currently test-only surface.
- `hostedConfig().dbUrl` (`SUPABASE_DB_URL`) is **required at boot but unused** —
  nothing opens Postgres. Stores are still `src/store/*` over `data/`.
- **No sign-out UI.** `signOutAction` exists with zero references from any component.
- **The Google button is dead.** `login-form.tsx:71` posts `intent=google` to
  `/auth/login`, but there is no `route.ts` there and `googleSignInAction` is never
  imported. `loginProviders()` correctly gates the button on GoTrue's
  `external.google`, so once credentials exist the button appears and then fails.
- `pilotUserAllowed` is the whole tenancy model. Every learner shares one `data/`.

### 4.2 Plugin auto-install / auto-enable

`core-plugins.json` names four ids: `flashcards`, `coding-questions`, `drawing-pad`,
`rich-code-blocks`. `scripts/build-core-plugins.mjs` builds each `plugins/<id>` into
`core-plugins/<id>/` through a mkdtemp staging dir with validation before and after,
a `safeTree` content allowlist, and rename-with-rollback. `npm run dev`/`build` run
it automatically, so **plugins arrive without the user doing anything**.

The enablement change is `src/server/plugins.ts:100-122`: at boot it reads
`data/plugins-state.json` and writes `state.enabled[id] = true` for every core id
whose key is `undefined`. Consequences:

- Core plugins are **on by default** — `data/plugins-state.json` here shows all four
  `true` and `data/core-plugin-data/` has all four directories.
- It also silently re-enables a core plugin the user explicitly turned off *if* the
  key is ever absent (e.g. state file deleted).
- Community plugins are untouched: `plugin-host.ts:383` still reads
  `state.enabled[id] === true`, so they stay disabled-by-default.

**Documentation is now stale on this point**, and so is a test:
`docs/plugin-architecture.md:52`, `docs/plugin-authoring.md:145,155`,
`components/settings/plugins-section.tsx:23` ("New plugins are disabled by default"),
and `scripts/smoke-core-plugins.mjs:31-34` (asserts `enabled === false` and that no
`core-plugin-data` exists). There is no test covering the bootstrap itself.

### 4.3 Branding

`app/layout.tsx` metadata, `src/agent/system-prompt.md`, `practice/00-base.md`,
`app/globals.css` (green/crimson top rule, dark radial wash, flashcards action
styling), `components/lh-mark.tsx` → `/logo-mark.png`, login copy. `package.json`
name/author/homepage, `electron-builder.yml` appId/productName, `SECURITY.md`,
`CONTRIBUTING.md`, and the `skills/` guides are **still upstream**.

---

## 5. Plugin system

Trusted local code, no sandbox. Host owns identity, compatibility, enable state,
lifetimes; plugins own their data and policy.

- Manifest `apiVersion: 1`; `parsePluginManifest` (`src/core/plugins.ts:376`) enforces
  id==folder, `x.y.z` versions, root-level `.js/.cjs/.css` entries, `main||backend`.
- Origin is host-owned: core ids load from flat `core-plugins/<id>/`, community from
  `plugins/<id>/dist/`. Reserved core ids shadow community copies with a visible
  conflict and never touch their files.
- Writable data is origin-aware (`src/store/plugin-data-paths.ts`): core →
  `core-plugin-data/<id>/`, community → `plugins/<id>/data/`, both symlink-checked.
- Backends load through the native `scripts/plugin-loader.cjs` sidecar so Next never
  bundles user code. Frontends load as real browser modules via
  `public/plugin-loader.js` (`window.__lhImportPlugin`), not chunks.
- `PluginHostError` is branded with `Symbol.for(...)` so status survives Next's
  duplicated module instances. `asset()` allowlists only `manifest.main`/`styles` and
  `assets/**`; backend modules and `data/` are never served.
- Lifecycle: `setEnabled` is serialized through one `enqueue`, re-reads state before
  writing, and discovers before reactivation. Code changes need a restart — there is
  no hot reload.

API groups live in `src/core/plugin-*.ts` and are documented in `docs/plugin-api/`
(generated): learning data, inference, managed agents, workers/background tools,
questions, problems, submissions, view context, UI widgets, trees, shortcuts.

The four core plugins: **flashcards** (graph-derived cues, FSRS-6 scheduling),
**coding-questions** (question + problem types, runs local tests), **drawing-pad**
(annotation over question references, submission interceptor), **rich-code-blocks**
(SMILES/ABC/TikZ fences).

---

## 6. Storage, events, safety

`config.ts` is the data-location seam: `LH_DATA_DIR` relocates every mutable record;
unset means repo `data/`. `LH_AUTH_FILE` holds the key store, outside `data/`.
`PATHS`/`LEDGER_FILES`/`SETTINGS_FILE`/`AUTH_FILE` are all derived there.

Everything is synchronous `fs`. Chats are one JSON file each with a version stamp and
a write choke point; graph is append-only JSONL ledgers with a format stamp; some
writes are temp-file-rename, most are not. **One server owner per data directory** —
this is not cross-process locking.

`/api/events` is a process-local SSE bus with notify-then-fetch semantics and no
replay. `chats-changed` fires only on list-shape mutations (the "silence law",
`src/store/chats.ts:28`).

Safety layers: `desktop-access.ts` (loopback trust in browser-only mode, host
allowlist via `LH_ALLOWED_HOSTS`, same-origin write check), the sensitive-path guard
in `src/agent/tools/fs-shared.ts`, and the Proxy's `apiGate`. The streamed document
route is exempt from the Proxy (Next's body clone truncates it) and therefore
re-enforces the identical policy inside its own handler.

---

## 7. Known rough edges

1. **Tenancy exists; plugin data is still shared.** Chats, graph, settings, jobs and
   themes are per-owner under `data/hosted/<owner-uuid>/`. Plugin backends capture
   their `dataDirectory` once at activation, and activation happens at boot before any
   owner exists, so `core-plugin-data/` remains global. Two learners share flashcard
   decks until that is reworked.
2. **`SUPABASE_DB_URL` required but unused** — boot fails without a DSN nothing reads.
3. **Sign-out and Google sign-in are unwired** (§4.1).
4. **Docs contradict the plugin code** on default-enablement (§4.2); one smoke script
   asserts the old behaviour.
5. **`npm test` cannot run under this sandbox** (`spawn EPERM` in tsx/esbuild). Use
   `node --experimental-transform-types <file>` or `npx tsx --test <file>`.
6. `HANDOFF.md` documents an intermittent loopback-TLS fault and a `307`-on-`/`
   investigation; the recovery doc supersedes parts of it. Treat `HANDOFF.md` as
   history, `docs/deployment-recovery-2026-11-15.md` as the current operational record.
7. Branding is half-migrated; `electron-builder.yml`, `package.json`, `SECURITY.md`,
   `CONTRIBUTING.md` and `skills/` still say LearnHarness.
8. `data/`, `core-plugins/`, `dist/` and `auth.json` are gitignored, so a fresh clone
   has no plugins until `plugins:setup` + a dev/build run.
9. **Pre-existing test failures on Windows** (present on a clean tree): directory mode
   bits (`0o700` vs `0o676`), path separators in `appearance-chrome`, `symlink` EPERM in
   `source-access`, and prompt-composition pins that no longer match the fragments.
   Compare against a baseline before blaming a change.