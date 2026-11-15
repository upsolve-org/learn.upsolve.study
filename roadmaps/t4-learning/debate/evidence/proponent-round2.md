# Proponent round 2

## Scope settlement

P9 adopts the opponent's assessment boundary. The first release still gives students a live adaptive tutor over their own supported text material. It does not equate conversational fluency with reliable grading. Each skill has a provisional practice view and, only when eligible, a demonstrated level backed by verified assessment items. Keep separate wording and visual treatments so a filled practice bar cannot be mistaken for tested mastery.

For the first assessed family, choose text-based factual/conceptual material whose expected answers can be verified from explicit passages, with a small reviewed promotion bank. This choice remains conditional on reviewer availability and the held-out evaluation. Do not advertise arbitrary essay, mathematical proof or diagram grading. Deterministic checking requires genuinely checkable questions; merely matching a word is insufficient for explanation skills. A correct answer key alone does not validate a model's partial-credit interpretation.

The operator owns the initial review gate. A qualified reviewer must explicitly accept that role, with a proposed 12-hour initial cap. The budget is an estimate, not available staffing. If the cap cannot establish a reliable assessment route, reduce the assessed family or launch clearly provisional practice only and revisit the mastery promise before approval. At rollout, limit verified assessment creation to reviewed units the operator can support; never silently generate a new verified bank for each uploaded chapter.

## Progressive onboarding and import economics

Retain LearnHarness-style source-linked lesson and working areas, a compact skill/dependency map, persistent notes on misconceptions and an optional confidence input. On a phone, show these as focused cards and drawers; on desktop, allow side-by-side lesson and map/source panels. Confidence is learner self-report and never sufficient promotion evidence. Park a full proposition/reasoning graph, generated interactive demos and live agent research until the core tutor passes its gates.

After sign-in, upload or paste, then select a short section. Default to a suggested excerpt so an outline editor is optional. Explain the brief diagnostic in plain language. First sessions should ask only what is needed to start this section, with remaining skills unassessed. Material expansion happens after a useful first exchange.

Initial proposed limits: 25 MB per file, 30 selected pages per accepted PDF job, a first preparation chunk no larger than 3000 source tokens, and a generated preparation-output cap of 1500 tokens before presenting partial results. Permit one import job per account at a time. Daily import allowance and storage limits should be set from measured cost; a provisional five jobs/day/account prevents an unlimited queue during the pilot but is not proof of server capacity.

A first chunk contains only enough source-linked skill/question material to start a short session. Do not generate the whole course and hundreds of cards before the learner begins. Existing interactive work outranks preparation; preparation must yield between bounded chunks. Track preparation tokens, wall time and abandoned imports separately.

For the mobile check, five invited students each use their own supported sample on their phone without coaching. Proposed success is four of five completing import, brief diagnostic and first useful tutoring exchange within five minutes, with no hidden extraction error in the chosen excerpts. This is a coarse usability gate, not a population estimate. Failure changes the onboarding or supported input path before wider rollout.

## T4 feasibility measurement

After access and the selected environment exist, run a capped 30-minute measurement, outside this debate, using the same tutor prompts and token limits planned for production. Record model revision, artifact hash, quantization, runtime version, driver, host resources and peak GPU memory. Compare one, two and four concurrent requests at bounded input sizes, including a deliberately simultaneous burst and background import chunks. The baseline is one request with no preparation running.

Proposed admission target: p95 first meaningful tutor text at most three seconds and p95 completed ordinary turn at most fifteen seconds for the admitted load, including queue delay. Measure 180-token typical and 250-token capped replies, plus 1500-token typical and 4096-token total-context cases. No out-of-memory errors, duplicate attempts or silent dropped requests are acceptable. Report number of requests, percentiles and worst cases rather than treating a short run as a service guarantee. Follow with a longer soak during the implementation pilot.

Use one pending generation per learner and round-robin or equivalent fair admission. A provisional queue cap of eight keeps overload finite. If estimated wait exceeds the latency budget, offer an already prepared review exercise or an explicit retry state; do not make a promise that all 100 users can generate immediately. Cancellation should stop unneeded GPU work where the runtime supports it. Test that repeated requests from one account do not starve another.

The 4B candidate may fail correctness or latency. Only then compare a larger candidate under the same gates; do not assume quantization or a different runtime fixes teaching quality. The exact runtime remains undecided.

## Fixed evaluation and release boundaries

Before tuning, freeze 200 human-labelled held-out cases from the supported family, separate from prompt-development examples. Include at least 100 incorrect or materially incomplete answers plus correct paraphrases, conflicting sources, malformed extraction, adversarial source text and requests to reveal answers. Keep question versions, ground truth, rubric and assistance history. Review disputed labels before scoring; do not count unresolved cases as correct.

Proposed initial gates:
- At least 190 of 200 verdicts match the reference rubric.
- At most two of the 100 incorrect/incomplete answers receive a passing verdict.
- At least 95 percent of evaluated factual tutor claims have valid source support.
- No promotion uses an unverified item, an immediately supplied answer as independent recall, or a malformed model result.
- No unintended answer disclosure in the designated diagnostic/assessment leakage cases.
- No cross-account source disclosure or unauthorized durable state change in the adversarial suite.

These counts are small release checks, not confidence that the true error rate is below two percent. Report per-slice errors and uncertainty. A model may receive a learning-quality rejection even if it meets the aggregate accuracy target.

Start with 10-15 invited learners for two weeks, after age/jurisdiction and onboarding requirements are settled. Compare each learner's unaided precheck with a held-out postcheck and a seven-day recall check. Record completion and return use separately. The pilot is exploratory: if verified practice is followed by persistent wrong reasoning, suspend the affected assessment items and inspect the traces. A larger controlled study would be needed to claim better learning than another tutor.

## Revised budget interpretation

The 8-12 engineering-week and 1-3 million development-token estimates remain uncalibrated planning allowances, conditional on passing feasibility and finding review capacity. No new measured timing or throughput exists. Pre-build spikes above are future bounded work after the settled design is approved, not completed proofs or permission to download large artifacts during this debate.
