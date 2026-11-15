# Plan to get learn.upsolve.study running

Inspected 14 November 2026. This plan distinguishes the existing runnable demo, a real private tutor, and the assessed student pilot. The current request authorizes this implementation plan; earlier debate documents remain historical records. No deployment or model-quality gate has passed.

## What works today

The React/Vite frontend compiles and passes lint. On this machine, `npm.cmd run build` and `npm.cmd run lint` both passed with Node v24.18.0 and npm 11.16.0. The production build contains about 308 kB of JavaScript before compression. These checks establish compilation, not browser usability or tutor correctness.

Run the existing demo in PowerShell:

```powershell
Set-Location 'C:\Users\narch\Documents\ChatGPT\learn.upsolve.study'
npm.cmd run dev -- --host 127.0.0.1
```

Open the local address Vite prints. Dependencies are already installed here. On a fresh checkout, install the Node version recorded above and run `npm.cmd ci` first. To inspect the production build, run `npm.cmd run build`, then `npm.cmd run preview -- --host 127.0.0.1`.

The demo supports session navigation, pasted notes, a graph, editable flashcards and browser-local persistence. It does not yet provide the hosted tutor described in the debate. `vercel.json` can publish the static frontend, but cannot supply the missing database, worker or GPU service.

## Findings that determine the work

| Evidence | Current behavior | Required change |
|---|---|---|
| `src/lib/chatTutorEngine.ts`, `createSessionFromPromptOrNotes` | Generates generic source text for a topic and marks sessions without notes as reviewed banks | Separate open-topic tutoring from uploaded sources. Only explicitly reviewed assessment items may qualify for verified progress. |
| `src/lib/chatTutorEngine.ts`, `generateSocraticChatReply` | Seven words count as a strong answer; this can increment verified progress | Replace length checks with an application-owned assessment process and recorded evidence. |
| Same function | Model route selection is not used; optional personal requests omit the source text and conversation history | Implement explicit server-side routing and bounded, source-grounded context. |
| Same function | Provider failures silently fall back to canned replies; requests have no explicit timeout | Return visible, retryable failures and support cancellation. |
| `src/components/SettingsAndAgentsDialog.tsx` | Connection test validates configuration but performs no network request | Test actual compatibility and show measured success or failure. |
| `src/App.tsx` | Saves the full personal model configuration, including API key, in localStorage | Move secrets to encrypted, owner-scoped server storage; migrate existing state without retaining browser keys. |
| `src/lib/flashcardGenerator.ts` | PDF parsing scans a partial byte buffer with regex, guesses page counts and fabricates text when extraction fails | Use a PDF parser, actual page references and explicit unsupported-file errors. |
| `src/components/FlashcardsSection.tsx` | Review buttons update labels but store no real due dates; imported cards can lose their source association when merged into an existing session | Persist review events and scheduling; attach every card to material and passage IDs. |
| `src/App.tsx` and seed data | Agent activity, token counts and dictation include simulated behavior | Remove or label demonstrations. Render only actual jobs and usage in the live product. |
| Repository structure | No application server, database migrations, authentication, deployment stack or test script | Add these before inviting multiple learners. |

The active entry path is `src/main.tsx` -> `src/App.tsx`. Older `HomeView`, `TutorWorkspaceView`, `ImportMaterialModal` and `ModelGatewayModal` components are outside that active path. Inventory reusable behavior before migrating anything; avoid maintaining two competing tutor implementations. All project files were untracked at inspection. Review and create a baseline commit before implementation, without including secrets, dependencies or generated builds.

## Proposed implementation decisions

Keep React, Vite and TypeScript. Add a TypeScript application service, PostgreSQL, a separate worker process and private file storage on the deployment host. Use a PostgreSQL jobs table initially so a second queue service is unnecessary. Serve the built frontend and `/api` through one HTTPS origin. Deploy these processes with Docker Compose on the application host; connect inference over a private network if the T4 is on another host.

The first inference candidate remains Qwen3-4B-Instruct-2507 from the existing debate. Start the compatibility experiment with a pinned llama.cpp CUDA build and a verified compatible GGUF artifact. Select the artifact, quantization and runtime only after target-T4 quality and latency checks. llama.cpp documents a CUDA server and compatible chat endpoints in its [server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md). This does not establish that a particular artifact meets this product's requirements.

Use PDF.js for selectable-text PDF ingestion, preserving page boundaries and an extraction preview. Its [official examples](https://mozilla.github.io/pdf.js/examples/) provide the loading and page-processing starting point. Reject scanned, encrypted or broken-text documents with an explanation. OCR, diagrams and equation-heavy assessment remain deferred.

Begin retrieval with owner-filtered passages from the selected section and PostgreSQL text search. Add embeddings only if evaluation shows missed relevant passages. Keep inference private; only the application service may invoke the hosted model. Personal providers remain optional, with explicit routing and no silent cross-provider fallback.

## Delivery sequence

Estimates are engineering days for one experienced developer, not measured delivery promises. Infrastructure access and review turnaround are additional calendar dependencies.

### 1. Establish an honest demo and baseline, 1-2 days

- Record the Node version, add a README and `.env.example`, and establish repeatable build/lint checks in CI.
- Put seeded sessions and simulated activity behind an explicit demo mode. Disable fake dictation and fake connection success in live mode.
- Remove fabricated extraction fallbacks, generic text presented as a source and automatic reviewed-bank classification.
- Stop awarding verified progress from answer length or supplied quick-reply answers.
- Add visible async error handling and `try/finally` cleanup around sending and importing.

Done when a failed import or model call shows an honest error, and arbitrary text cannot earn a verified badge. Keep the existing visual interface.

### 2. Build one real tutoring path, 4-6 days

Add `server/`, `shared/` request schemas and a typed `src/lib/apiClient.ts`. Implement `/api/health`, session creation, pasted-material storage and `/api/sessions/:id/turns`. Start with an operator-only local workspace bound to loopback until authentication is implemented.

Send actual selected source passages, recent conversation, active skill and tutoring phase to the model. Bound input and output tokens. Return streamed text plus a validated final result; expose errors, cancellation and retry. Persist messages and material in PostgreSQL from the start. Do not let model output directly update progress or execute tools.

Replace the active calls into `chatTutorEngine.ts` with the API. Preserve deterministic tutor sequencing in application code: diagnostic, question, hint or explanation, fresh check, review. Open-topic sessions must clearly distinguish general model knowledge from supplied material.

Done when a user can paste a real excerpt, ask a question, receive an answer grounded in that excerpt, inspect its citation, refresh and resume. A failed provider must not produce a fabricated successful turn. This is the first useful private milestone, roughly 5-8 engineering days from starting.

### 3. Add accounts and private model settings, 4-6 days

Use an established authentication implementation with invited accounts and secure server sessions. Choose the identity integration after checking the operator's existing infrastructure. Enforce ownership in every query and file operation. Add session expiry, request validation, request size limits and rate limits.

Persist per-workspace model routes. Store optional personal credentials encrypted with a separate operator-managed encryption key; return only masked metadata. Implement a real test request through the same adapter used for tutoring. Support replacing and removing credentials. Validate custom destinations, resolved addresses and redirects; reserve private inference destinations for operator configuration. Do not expose a general outbound proxy.

Offer an explicit import of existing local sessions, validate them, and treat old progress as unverified. Never upload browser-stored keys automatically; request re-entry through the new settings flow and clear the legacy key after migration.

Done when two accounts cannot access each other's sessions, files or model settings, and provider failures are handled without changing the selected destination.

### 4. Implement actual imports, jobs and review, 4-6 days

Unify the notes and flashcard upload paths. Store originals privately, extract actual text and page counts, show a preview, and let the learner select a short starting section. Persist passages with stable source references.

Implement durable import jobs with states, retries, leases and cancellation. Prepare the selected section first. Generate flashcards and skill proposals from actual passages, validate their source IDs, and retain their material association when adding to an existing session. Store real `due_at` timestamps and review history. Self-rated recall remains separate from verified mastery.

Initial limits inherited from the debate: 25 MB per file, 30 selected pages, one active import per account, at most 3,000 source tokens for initial preparation and 1,500 generated preparation tokens. Treat these as starting limits to validate, not capacity claims.

Done when supported PDFs produce inspectable citations, unsupported PDFs never generate substitute content, worker restarts recover queued work, and reviews become due according to stored timestamps.

### 5. Prove assessment correctness, 5-8 days plus subject review

Begin the assessment feasibility check during step 2 so it can block expansion early. Select one material family and secure a qualified reviewer or a verified answer-checker route. Budget one engineer-day and up to 12 reviewer-hours for that initial feasibility check, as proposed in the debate.

Create versioned skills, questions, rubrics and attempts. Record assistance, model version, verdict and supporting evidence. Use idempotency keys and transactions so retries cannot award progress twice. Assisted answers and immediately revealed solutions are ineligible for unaided promotion. Only eligible reviewed items can update verified levels.

Freeze 200 held-out cases before tuning, including 100 wrong or materially incomplete answers. The inherited release gate requires at least 190 correct verdicts, at most two wrong-answer passes and at least 95% factual source support. Define the support metric and evaluation slices before running it. Record raw outputs and reviewer decisions.

Done when these gates pass on the exact deployed model artifact and progress invariants pass automated tests. If they fail, narrow assessed content or revisit the mastery promise. Provisional tutoring is an intermediate milestone, not completion of the assessed product.

### 6. Validate T4 capacity and deploy privately, 3-5 days

Start hardware discovery during step 2. Record OS, GPU, driver, CPU, RAM, free disk, network topology and model artifact checksum. Build a reproducible Compose stack, migrations, health checks, persistent volumes, TLS configuration and backup/restore instructions. Keep database and model ports private.

Start with one pending generation per learner and a fair queue provisionally capped at eight. Interactive requests take precedence; import work yields between bounded chunks. Test 1, 2 and 4 simultaneous requests with imports and bursts. Select admission limits from measurement rather than assuming four-way concurrency works.

Inherited latency targets at admitted load are p95 first meaningful content within 3 seconds and completed short turns within 15 seconds, including queue delay. Require no memory failures or lost requests. Show explicit busy/retry states when full. Run a longer soak before broader release.

Deploy to a private staging hostname first, run the complete upload-to-review flow, restore a backup into a separate database, and verify rollback to the prior application image. Publish `learn.upsolve.study` only once domain access and the target environment are available.

### 7. Run the invited pilot, 3-5 days preparation plus two weeks observation

Check the active UI on phones, including sidebar collapse, dialogs, keyboard, long content and citation navigation. Five students should try their own supported samples; at least four should reach a useful teaching exchange within five minutes without coaching.

Before inviting school students, the operator must define ages, jurisdictions, onboarding responsibility, retention, export/deletion and incident handling. These are unresolved product decisions in the existing debate.

Invite 10-15 learners first. Track extraction errors, unsupported questions, grading errors, latency, provider failures and delayed unaided recall. Review results after two weeks before expanding to 100 registered accounts. Registered accounts are not simultaneous generations.

## Backend records and API contract

Minimum records: users, workspaces, materials, passages, sessions, messages, skills, assessment items, attempts, progress events, flashcards, reviews, jobs and model connections. Owner IDs and source/version references must be explicit. Use database transactions for attempts and progress, and unique request IDs for retry safety.

Planned routes include authentication/session management; material upload and passage reads; learning session creation/resume; streamed tutoring turns; flashcard reviews; job status; masked model settings and connection tests; account export and deletion. The server derives ownership from authentication, never from a trusted client-supplied owner ID. Use `/api/health` for process health and a separate readiness check for required dependencies.

Proposed configuration names: `DATABASE_URL`, `APP_ORIGIN`, `SESSION_SECRET`, `MODEL_SECRET_ENCRYPTION_KEY`, `HOSTED_MODEL_BASE_URL`, `HOSTED_MODEL_NAME`, `UPLOAD_DIR`, `MAX_ACTIVE_GENERATIONS` and `MAX_QUEUED_GENERATIONS`. These are planned variables, not currently implemented configuration. Never place credentials in `VITE_*` variables.

## Verification and operations

Add tests for the failures found here: long wrong answers, assisted quick replies, fabricated citation IDs, missing source context, failed extraction, provider timeout, duplicate submissions and cross-account access. Add browser tests for paste -> tutor -> citation -> refresh, PDF -> flashcards -> due review, and invalid provider configuration. Build and lint remain required, but cannot replace these checks.

Record request ID, selected model/version, queue delay, time to first content, completion time, token use and failure category. Avoid recording credentials or full student text in operational logs. Monitor disk usage and failed jobs. Take encrypted daily database/file backups and demonstrate restoration before the pilot. Document secret rotation, migration rollback limits and model rollback.

## Schedule and outstanding inputs

The steps total roughly 24-38 engineering days, plus review, infrastructure setup and the two-week pilot. Allow about 8-12 calendar weeks for the assessed pilot, with a useful private tutoring path in the first 5-8 engineering days if a model endpoint is available. Re-estimate after that first path and the T4 measurement. No infrastructure purchase is implied.

The operator needs to supply the T4 host/access details, domain/DNS access, the first subject and representative materials, a reviewer or checker route, and student onboarding constraints. These do not prevent beginning the local implementation. Credentials should go through deployment configuration, not into this document.

The next concrete implementation task is step 1 followed by the pasted-notes path in step 2. Avoid spending the next iteration on additional simulated agents, graph styling or deployment of the static demo as if it were the completed tutor.
