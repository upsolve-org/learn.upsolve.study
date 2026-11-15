# UPsolve Learn

**Learning harness for UPB students**, served at [`learn.upsolve.study`](https://learn.upsolve.study).

UPsolve Learn is a hosted Next.js fork of [LearnHarness](https://github.com/amosblomqvist/learnharness) adapted for UPB students: adaptive diagnostic probing, step-by-step teaching, spaced practice, and a persistent knowledge graph.

---

## Current Status

- **Deployment:** Self-hosted Next.js server (`next start`) behind Caddy with Supabase GoTrue authentication.
- **Access boundary:** Currently gated to a single verified operator account via `HOSTED_PILOT_EMAIL` while backend stores remain filesystem-backed.
- **Active roadmap:**
  - Multi-user Supabase PostgreSQL per-owner persistence (chats, knowledge graph, plugin data, jobs, and live events)
  - Fixed hosted model routing for all learners
  - Assessment validation and pilot rollout

See [HANDOFF.md](HANDOFF.md), [docs/deployment-recovery-2026-11-15.md](docs/deployment-recovery-2026-11-15.md), and [docs/supabase-webapp-plan.md](docs/supabase-webapp-plan.md) for current operational state and architecture plans.

---

## Development

```bash
npm ci
npm run plugins:setup
npm run dev          # http://localhost:3000
```

### Verification

```bash
npm test             # unit & integration tests (fixtures and fake providers)
npm run typecheck    # TypeScript check (tsc --noEmit)
npm run lint         # ESLint
npm run build        # builds core/authoring plugins + Next.js production bundle
```

---

## Hosted Configuration

Hosted deployments rely on environment variables including:

- `HOSTED_PILOT_EMAIL` — restricts hosted access to the configured verified account while single-store mode is active
- `LH_ALLOWED_HOSTS` — allowed hostnames (e.g. `learn.upsolve.study`)
- `SUPABASE_INTERNAL_URL` — internal GoTrue/Supabase URL for server-side auth calls (e.g. `http://127.0.0.1:8000`) alongside the public Supabase URL/anon key

Refer to [docs/deployment-recovery-2026-11-15.md](docs/deployment-recovery-2026-11-15.md) for reverse-proxy (`/auth/v1/*`) and cookie-handling notes.

---

## Documentation & Project Files

- [HANDOFF.md](HANDOFF.md) — latest deployment and recovery handoff
- [docs/README.md](docs/README.md) — inherited LearnHarness documentation index (architecture, plugins, themes, shortcuts)
- [docs/supabase-webapp-plan.md](docs/supabase-webapp-plan.md) — multi-user Supabase and hosted model plan
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution guidelines
- [SECURITY.md](SECURITY.md) — security reporting policy

---

## Attribution & License

Forked from [amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness).

Licensed under [AGPL-3.0](LICENSE).
