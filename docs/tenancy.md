# Tenancy and admission

Implemented 16 Nov 2026. This is the maintainer map for per-learner isolation and the
signup/approval flow. See [architecture.md](architecture.md) for the surrounding system.

## The rule

**The owner is always the verified session subject, never a submitted id.** It is
canonicalised to a lowercase UUID because it becomes a path segment.

## How the owner reaches the storage layer

1. `proxy.ts` verifies the session against GoTrue and forwards the verified id as the
   internal header `x-lh-owner`, overwriting any client-supplied value
   (`NextResponse.next({ request: { headers } })`).
2. `src/server/request-owner.ts` is the ONE consumer. `ownerScoped(handler)` wraps every
   route handler; `asRequestOwner(fn)` does the same for server components, which have
   no Request argument.
3. The wrapper enters an `AsyncLocalStorage` scope (`src/core/owner-scope.ts`).
4. `config.ownerPaths()` resolves against that scope. Store adapters call it per
   operation — never at module load, because the active owner is request state.

Outside a scope (desktop, plain `npm run dev`, operator-level work) the same names
resolve against the legacy data root, so the desktop path is unchanged.

## Why AsyncLocalStorage rather than an argument

The storage ports are synchronous and roughly 1 125 test call sites plus the agent
tools reach the store singletons with no request context to thread. An async-local
association gives per-request isolation without changing a port signature. The scope is
globalThis-anchored for the same reason the other registries are: Next compiles each
route as its own module instance.

## What is owner-scoped

`data/hosted/<owner-uuid>/` holds chats, graph ledgers, settings, prompt overrides,
themes, jobs and debug captures.

**Not scoped, deliberately:** `data/admissions.json`, `data/signups.json`, the auth/key
store, and the plugin catalog + plugin data. Plugins are the known gap — backends
capture their data directory at activation, which happens at boot before any owner
exists.

## Registry keys

Turn liveness, running turns, compaction, parked dismissals and job delivery key on
`owner:chatId`. Chat ids are random so a bare id rarely collides, but the composite key
makes isolation structural. The job pump re-enters the owner scope from the queue entry
(captured at enqueue), because it outlives the request that queued it.

## The hosted default model

Every learner gets the operator's endpoint as a default, so a new account can
start a session with nothing configured. Three server-side variables:

```dotenv
HOSTED_DEFAULT_BASE_URL=https://llmrouter.boyemma.com/v1
HOSTED_DEFAULT_MODEL=auto
HOSTED_DEFAULT_API_KEY=sk-...
```

**The key never leaves the server.** It is read from the environment and baked into
the provider at publication. It is never written into a learner's settings record and
never sent to the browser — `GET /api/custom-provider` reports only `keyPresent: true`
and `hostedDefault: true`.

It is a **default, not a pin**: `resolveSlot` fills an empty slot, so an explicit
learner choice or a per-role override still wins. `slotsConfigured` returns true while
a default exists, so the setup CTA does not ride.

Off unless hosted mode is on and all three values are set — desktop and plain dev are
unchanged.

## Admission

Two operator files, both outside any owner root:

- `data/admissions.json` — `{ version: 1, emails: [...] }`, the allowlist
- `data/signups.json` — `{ version: 1, requests: [{ email, requestedAt }] }`, the queue

`/auth/signup` only queues an address; it creates no account. `/admin` (gated by
`ADMIN_EMAIL`, 404 for anyone else) approves or denies.

**Approving provisions the account.** With `SUPABASE_SECRET_KEY` set, the approve
action creates the GoTrue user with a generated 14-character password, marks the
address confirmed, and sends the saved password and login link through Resend.
`RESEND_API_KEY` stays in server environment configuration; `RESEND_FROM` is
`UPsolve <noreply@upsolve.study>`. The domain must be verified in Resend.
The credential record stores the send result. Admin shows Resend acceptance or
a sending error, with **Retry email** to reuse the same password. Acceptance is
not an inbox-delivery confirmation. Requests carry an idempotency key for Resend's
24-hour deduplication window, and recorded acceptance suppresses later retries.
Press **Done** to drop the saved credential. **Reset** issues a new password;
use **Send email** afterwards. Deploying does not send existing credentials.

The plaintext lives in `data/issued-credentials.json` (operator-level, `0600`) because
this is the only place it can survive. Without the secret key, approving admits the
address only and the page says so.

**Where requests appear:** the operator opens `/admin` — reachable from the **Requests**
row pinned at the bottom of the sidebar, which renders only for the operator (it asks
`GET /api/admin/status`). The page lists pending addresses with Approve/Deny, the
credentials to send, and the current allowlist. Pending requests also sit in
`data/signups.json` if you prefer the file.

A verified but unadmitted account is sent to `/auth/denied` rather than back to
sign-in, which would loop because the session is valid.

`HOSTED_PILOT_EMAIL` remains honoured as an implicit allowlist entry.

Both files are written `0644`, not `0600`. The operator approves as root over SSH
while the server reads them as its own user; `0600` made admission fail closed with no
visible error. A regression test pins this.

## Deployment lessons (2026-11-16)

- **The API gate must forward the owner too.** Most routes only ever see `apiGate`,
  never `sessionGate`. Forwarding the header solely in the page gate left every API
  call unscoped — pages read the owner's root while APIs read the shared one. Both
  gates now share `ownerHeaders()`.
- **Turbopack served a stale proxy bundle** after an interrupted build. `grep` the
  built middleware chunk for a marker (`x-lh-owner`) before trusting a deploy; if it
  is missing, `rm -rf .next` and rebuild.
- `next start` warns about `output: standalone` but works; the standalone tree is only
  used by the desktop packaging path.

## Verification

`tests/tenancy.test.ts` (paths, scope, store isolation), `tests/request-owner.test.ts`
(header handling, sync passthrough, no scope leak), `tests/proxy-owner.test.ts`
(forwarding, spoof rejection, denied redirect), `tests/hosted-admission.test.ts`
(allowlist, queue, operator).
