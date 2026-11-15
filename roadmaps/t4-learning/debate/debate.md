---
goal: A self-hosted tutoring webapp for school students learning from their own materials
date: 2026-11-14
rounds: 2 of 2
status: proposed
roadmap: not started
supersedes: none
decision: none
---

# Debate: a personal tutor on one T4

The proposed product is a materials-first tutor with a structured learning path, persistent skill progress and short practice sessions. The user confirmed 100 registered learners with modest concurrent use, and school students bringing their own materials. A single T4 is a plausible deployment target for a constrained small-model service, but this debate has not measured its speed or tutoring accuracy.

The critical product decision is to separate useful tutoring from verified assessment. Students can explore their uploaded material with the tutor. Confirmed skill advancement requires trustworthy assessment evidence. A model-generated answer key is not automatically trustworthy merely because the same model grades against it.

## What the references contribute

| Reference | Retain | Adapt for this product |
|---|---|---|
| [Jane Street tutor](https://github.com/janestreet/agent_skills/tree/master/socratic-tutor) | Diagnostic, skill levels, questioning, review, final assessment | Enforce the learning sequence in application code and store evidence in a database. |
| [LearnHarness](https://learnharness.ai/) | Lesson map, reasoning workspace, adaptive teaching and persistent understanding | Make the interface responsive, with hosted inference by default and optional user API keys/endpoints. |
| [Gizmo](https://gizmo.ai/) | Easy entry from study material, brief practice and an approachable tone | Make the next useful action obvious and keep engagement rewards separate from mastery. |

The competitive premise needs updating. [Gizmo already documents an AI Tutor](https://help.gizmo.ai/en/articles/13011417-how-does-the-ai-tutor-work), and LearnHarness supports custom model endpoints. The opportunity is an accessible, self-hosted learning workflow with explicit evidence for progress. These public references were inspected; no authenticated usability comparison was performed. J6-J8.

## Settled structure

The two sides converged on these scope choices. User approval remains pending.

1. Let a student upload a text PDF or paste notes, start with a suggested short excerpt and receive a useful first exchange while later sections prepare. Keep the outline editor optional. P3, P11, O4, O6.
2. Keep a persistent skill map and a code-controlled tutor sequence. The student can change difficulty, request an explanation, choose a skill and resume later. P1.
3. Show a level out of five for each assessed skill, with provisional status where evidence is incomplete. Keep practice completion and engagement rewards distinct. Confirmed advancement initially covers one text-based material family with reviewed promotion items. P2, P9, O1, O8.
4. Default to one hosted small quantized model, and let users optionally connect their own API key or custom endpoint. All routes use the same learning sequence and progress rules. The application owns scheduling, permissions and accepted progress changes. P4, P7, P10, amended by the user on 2026-11-14.
5. Release to 10-15 invited learners for two weeks before expanding to all 100 accounts. Measure extraction, grading, user experience and server load before expanding supported material. P6, P12, O2, O3, O5.

## Learning experience

A session begins with a short diagnostic and a proposed skill map. Teach one question at a time. Wrong answers lead to narrower prompts; repeated difficulty leads to an explanation and a fresh check. Advancement needs multiple independent demonstrations, including unaided recall. Review revisits older skills, and a mixed assessment checks completion. The learner can request a direct explanation. This adapts the [Jane Street specification](https://raw.githubusercontent.com/janestreet/agent_skills/master/socratic-tutor/SKILL.md), which is a prompt design rather than evidence of small-model learning effectiveness.

The proposed progress UI shows the skill name, current level, target and evidence status. A bar labelled 3/5 means the learner has reached that stage of the rubric. It does not mean a calibrated 60% probability of understanding. Diagnostic placement remains provisional. Assisted practice does not become an independent assessment attempt. O1 and O8 constrain P2.

On desktop, place a compact skill map beside the lesson/work area, with sources available in a collapsible panel. On mobile, show one learning card at a time and open progress or sources on demand. Home emphasizes continuing the current lesson and reviews due. Use forgiving streaks and small celebrations, with no penalty for requesting help. P5.

Keep persistent notes about misconceptions and an optional confidence input. Confidence is self-report and cannot qualify a promotion. Defer the full proposition/reasoning graph and live agent research. This preserves LearnHarness's core learning workspace without importing its entire agent system. P11.

## Application and model responsibilities

| Component | Responsibility |
|---|---|
| Responsive React client | Learning workspace, source viewer, progress and resume state. |
| Application service | Authentication, ownership checks, lesson state, assessment rules, quotas and request scheduling. |
| PostgreSQL and private file storage | Materials, source locations, skill versions, attempt evidence, reviews and learner state. |
| Background worker | Extract and prepare selected sections; stop or yield when interactive work arrives. |
| Model gateway | Route requests to the hosted T4 service or the user's configured provider/endpoint through a common adapter interface. |

### Optional personal models

The default experience requires no API key. An optional Models setting offers a personal provider API key or a custom compatible endpoint with a base URL, model name and optional credentials. Start with a documented compatibility contract and connection test; do not promise support for every API format. Store the selected route per learning workspace so the destination is predictable.

Keep keys encrypted on the server, scoped to their owner, masked in the UI and excluded from logs and learning context. Users can replace or remove them. Explain which study material and conversation context will be sent to the selected provider, and that its usage charges are theirs. Do not silently switch providers or send material elsewhere after a connection fails.

Custom endpoint requests originate from the app server. A user's localhost therefore does not refer to their laptop. Personal local servers need an explicitly configured reachable route; arbitrary endpoint URLs must not grant access to server-internal services. Validate endpoint destinations, redirects and outbound access, with private-network destinations reserved for explicit operator configuration.

The tutoring sequence, learner record and assessment eligibility remain application-controlled regardless of provider. A connection test establishes compatibility, not grading quality; an unvalidated external model cannot automatically confer verified mastery. Log the model/provider version with assessment evidence. Test provider failures, cancellation, isolation and progress consistency before release.

This is an explicit user scope amendment. Provider adapters, secret storage and endpoint validation add implementation and evaluation work; the existing delivery estimate must be revised in the roadmap rather than treated as unchanged. Hosted T4 capacity remains a standalone acceptance gate, without assuming that users bring paid models.

Persist each attempt with the question and rubric versions, assistance shown, verdict and evidence for the accepted update. Retries must not award progress twice. Retrieval must filter by account ownership before calling the model. Imported instructions and model output cannot grant access or directly change durable progress. P4, P7, O7.

Begin with one pending model request per learner and a fair queue, provisionally capped at eight. Preparation yields between short chunks. When the service cannot admit another request, show an explicit retry state or an existing review activity. These limits protect responsiveness; they do not prove capacity. P10.

[Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507) is a concrete non-thinking candidate to test, not a selected production model. Compare its quantized version with a larger candidate only if it misses the tutor-quality gate. Load one candidate at a time. Both [llama.cpp](https://github.com/ggml-org/llama.cpp/tree/master/tools/server) and [vLLM](https://docs.vllm.ai/en/latest/features/quantization/) are serving candidates; pin the exact runtime and quantized artifact after testing the T4. J9, J13.

## Budget

| Axis | Proposed allowance | Evidence and limit |
|---|---|---|
| Device | One T4; initially test 2-4 active generations, bounded 4k contexts and short responses | P4. These are test configurations, not measured capacity. |
| Host resources | Preliminary 16 GB RAM and 50 GB free storage; 32 GB RAM preferable for colocated services | Proponent estimate. Server CPU, RAM, storage and driver remain unknown. |
| Delivery | 8-12 engineering weeks for one experienced developer, plus subject review | P6. No repository calibration exists; calendar time depends on review and pilot findings. |
| Content review | Proposed initial cap of 12 qualified reviewer-hours for one material family, plus one engineer-day of assessment feasibility | P12. No reviewer has been assigned or committed. This does not fund ongoing review of arbitrary uploads. |
| Development tokens | 1-3 million as a provisional allowance | P6. Estimate, not a spending authorization or actual usage report. |
| Runtime tokens | Example: 100 learners at 20 turns/day and 1,500 input plus 180 output tokens/turn produce 3 million input and 360,000 output tokens/day | Workload scenario, not forecast. Preparation and retries add load. |
| Learning quality | Assessment support expands only with separately verified items and held-out evaluation | O1, O2, O8. Generated feedback alone cannot certify mastery. |
| Privacy | Private account-scoped materials and records, bounded retention, deletion/export and no automatic external-model fallback | P7. School-age release requirements remain a pre-release decision. |

The [T4 specification](https://www.nvidia.com/en-us/data-center/tesla-t4/) lists 16 GB of memory. For the candidate architecture, four independent 4,096-token FP16 attention caches total 2.25 GiB. This excludes weights and runtime overhead. Four-bit weights do not imply a four-bit cache. The calculation is in [measurement notes](evidence/measurement-notes.md). Memory fit does not establish responsiveness. J5, J12, O3.

Preparation also costs GPU time. The opponent's illustrative ten-chapter workload generates 75,000 tokens before outlines and retries. That estimate justifies measuring preparation separately and imposing quotas, not predicting a particular completion time. O4.

Proposed starting import limits are 25 MB per file, 30 selected PDF pages, one import job per account, and at most 3,000 source tokens in the first preparation chunk. Cap initial generated preparation output at 1,500 tokens. A provisional five import jobs per account per day must be revised from measured cost. Limits may change after evaluation. P11.

## Required measurements before expanding the build

These are future feasibility gates after approval, not completed tests or a task-level roadmap.

| Gate | Bounded check | Pass condition and consequence |
|---|---|---|
| Assessment quality | One engineer-day and up to 12 reviewer-hours; freeze 200 held-out cases before tuning, including 100 wrong or materially incomplete answers | At least 190 correct verdicts; at most two wrong-answer passes; at least 95% factual source support; report errors by slice. If this fails, narrow the assessed material or revisit the mastery promise. |
| Progress correctness | Replay attempts with hints, retries, malformed responses and unverified items | No unauthorized promotions, double awards or use of an immediately revealed answer as independent recall. |
| T4 serving | After setup, a 30-minute comparison at 1, 2 and 4 concurrent requests, with background imports and bursts | At the admitted load, p95 first meaningful content at most 3 seconds and completed short turn at most 15 seconds, including queue delay. No memory failures or silently lost requests. Reduce admission or revise the design if it fails. |
| Mobile entry | Five students use their own supported samples without coaching | Four of five reach a useful exchange, including a brief diagnostic, within five minutes. Inspect selected source extraction for hidden errors. Revise onboarding or formats if it fails. |
| Isolation and imported instructions | Adversarial upload and cross-account suite | No cross-account disclosures or unauthorized state changes; no unintended answer disclosure in the designated assessment cases. |
| Learning pilot | 10-15 students, two weeks, with unaided checks before/after and seven-day recall | Inspect persistent misconceptions and suspend faulty items. This exploratory pilot cannot establish superiority over competing tutors. |

These are proposed thresholds from P10-P13. A two-percent observed error rate in a small sample is not proof that the population error rate is below two percent. Model-card benchmarks are not substitutes for these cases. A longer load soak follows during the pilot before broad release.

## Open risks and how they close

- T4 latency and real traffic remain unknown. Run P10's target-server measurement, then select a runtime, artifact and admission limit. O3. No server access exists in this task.
- Mobile onboarding and the usefulness of text-only uploads remain unknown. Run P11's five-student check and record unsupported-input frequency. O2, O6. Photos and diagrams are a real launch limitation, not silently supported inputs.
- Preparation cost is only an example calculation. Measure tokens and wall time for selected sections under concurrent tutoring before setting production quotas. O4, P10-P11.
- Review capacity is unassigned. The operator must secure a qualified reviewer or a verified checker route within P12's cap. If unavailable, assessed mastery for that material remains unavailable. O5, P12.
- Small-model semantic grading and explanation quality are unproven. Run the fixed held-out evaluation on the exact quantized artifact, and expand scope only with new evidence. O1, P9, P12.
- If quality, staffing or latency fails, a provisional-practice-only product does not complete the promised assessed tutor. Return for an explicit scope decision rather than calling the fallback finished. O10.
- Supported ages, jurisdictions and school/guardian onboarding responsibilities are unspecified. The operator must settle them before inviting school students, together with retention and dispute handling. P13. This debate does not assert compliance with any jurisdiction.

## Rejected and deferred

- A quiz-only study-pack product as the main launch misses the requested adaptive tutor. Keep it only as a contingency if live tutoring fails. P8.
- A generic chat with a large tutoring prompt leaves sequencing and progress too dependent on model behavior. Adopt P1's controlled sequence instead.
- Automatic mastery certification for every subject and arbitrary upload lacks evidence. Adopt O8's verified-assessment boundary.
- Initially defer scanned or handwritten material and diagram-heavy assessment. Selectable PDF text still needs extraction checks. P3, O2.
- Defer native apps, live voice, social feeds, leaderboards and generated executable demos. P5.

Build a new web interface using these interaction ideas. Source reuse is a separate implementation choice: [Jane Street publishes its skill under MIT](https://github.com/janestreet/agent_skills/blob/master/LICENSE.md), while [LearnHarness publishes under AGPL-3.0](https://github.com/amosblomqvist/learnharness/blob/main/LICENSE). No code or artwork was copied during the debate.

## Proofs and remaining evidence

No model download, server benchmark or throwaway build ran during this debate. The deployment server was not connected, and no representative school materials or labelled answers were supplied. Local hardware measurements cannot substitute for the server. No application code was created.

Prior art supports testing unaided learning separately from assisted performance. [Bastani and colleagues](https://pubmed.ncbi.nlm.nih.gov/40560616/) found that tutor design affected later unaided performance in high-school mathematics. That result does not establish the effectiveness of this small model. J10.

## Inferred choices

- Self-hosted inference and ordinary browser access take priority over unrestricted autonomous model behavior. J11.
- Start with selected text sections and a restricted assessment scope to make one T4 and reliable progress compatible. P3, O8. This is a proposed scope cut for approval.
- No deadline was supplied. Engineering and token allowances are estimates to revise after the first feasibility work. J3, P6.

## Answers from the user

- Q1: 100 registered learners with modest concurrent use.
- Q2: School students studying from their own materials.

## Overruled

On 2026-11-14 the user required an option to add personal API keys and endpoints. This amends the hosted-only reading of P4/P10 and extends P7's data-handling boundary to explicitly selected providers. The original claims remain sealed, with the amendment recorded in their user-ruling fields. Overall approval remains pending.

## Cost of this debate

Two agents serve as proponent and opponent; the parent acts as judge. The cap is two rounds. Exact aggregate token usage is not exposed, so no measured spend is claimed. The ledger's empty spend list must not be interpreted as zero usage.

The ledger passed validation and reached `settle` at the two-round cap. Its two remaining warnings concern estimated preparation and review costs, O4 and O5. Both have bounded future measurements above; neither estimate is presented as a measured result. All three open claims, O3, O6 and O10, have explicit follow-up conditions.

The detailed implementation roadmap follows approval. The invoked [goal-debate skill](C:/Users/narch/.codex/skills/goal-debate/SKILL.md) says, "Never move on to planning or building without that approval." Approval here accepts the product scope and feasibility gates, including text-first uploads and limited verified assessments. It does not claim those gates have passed.
