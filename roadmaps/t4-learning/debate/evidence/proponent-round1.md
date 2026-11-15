# Proponent round 1

These are design estimates, not benchmark results or a delivery commitment.

## Division of responsibility

The app stores the learning objective, versioned skill tree, prerequisite edges, source passages, active question, attempt history, hints already shown, misconceptions, current level and review due date. An immutable attempt event records the question version, student's answer, evidence used, assistance received, evaluation verdict and accepted state change. A retry must not award progress twice.

The small model receives the current skill, a few relevant source passages, a rubric, a compact learner summary and recent turns. It returns a constrained verdict with supporting evidence and one proposed next tutor response. The app validates the response and permitted transition before committing it. Invalid or uncertain judgements request clarification or offer a source-backed exercise, and cannot increase the skill level. Deterministic checkers handle exact answers where suitable. Semantic grading remains an unproven component.

A familiar topic description and a material upload are enough to begin. The model proposes the outline, but the learner can remove irrelevant chapters and correct titles before a short diagnostic. Partial diagnostics leave untested skills labelled unassessed. The course target defaults to independent use; an advanced mastery target adds explanation and transfer checks. A visible level is a coarse evidence label, not a percentage probability of knowledge.

## Import limits

Start with pasted text and selectable-text PDF chapters, with a proposed per-job limit of 25 MB and 30 selected pages. Accept other subjects through the same pipeline, but only advertise supported text-based material types verified in evaluation. Report extraction failures before generating lessons. A student can preview the exact extracted source and exclude bad passages. Do not treat a student's approval as proof that the contents or generated answer key are correct.

Questions retain source locations, their expected answer and reviewer status. Conflicting or insufficient sources suspend assessment for that point. Mark unreviewed generated content visibly and allow reporting it; subsequent quality debate must decide whether such content may affect mastery. Defer image OCR, photographed worksheets and diagram-heavy reasoning from the first supported upload path. This still supports material-first learning, though it narrows the file formats.

## Hardware and traffic estimates

One 4B model at four bits has an ideal weight-only lower bound near 2 GB, before quantization metadata, runtime buffers and KV cache. Qwen3-4B's stated architecture gives FP16 KV memory of 2 x 36 x 8 x 128 x 2 = 147456 bytes/token. A full 4096-token slot therefore uses about 576 MiB for KV alone; four such slots use about 2.25 GiB. These are arithmetic bounds, not allocator measurements.

Propose a working GPU budget of 12 GiB with remaining nominal memory held for overhead and variability. Reserve 16 GB host RAM and 50 GB free storage as a preliminary minimum planning allowance, preferably 32 GB RAM if imports, indexing and backups coexist. The user's host capacities are unknown. Keep extraction and simple retrieval on CPU; run heavy preparation below interactive priority.

At 100 accounts x 20 tutor turns/day, an illustrative 1500 input + 180 output tokens per turn is 3 million input and 360000 output tokens/day. This is a workload scenario, not a user forecast. Four active learners submitting once per minute require 12 output tokens/second on average at 180 output tokens each, plus prefill and burst headroom. Capacity must be tested at actual arrival rates; no T4 throughput number is claimed.

Pin a serving runtime, model revision, quantization artifact and driver combination after testing. Use FP16 compute where required by Turing, not an assumed BF16 path. Do not keep two model candidates resident. No fine-tuning is needed for the first comparison.

## Time and token estimates

One experienced full-stack developer with occasional subject reviewer input: about 1-2 weeks for material/model feasibility and rubric preparation, 2 weeks for core data/state/auth/import, 2-3 weeks for responsive learning UI and tutor integration, 1-2 weeks for evaluation and load testing, and 2-3 weeks for pilot repair and operational hardening. Some work overlaps; 8-12 engineering weeks is a rough range. Subject review is an additional human dependency that can lengthen calendar time.

Development model usage allowance: roughly 20-30 medium work units at 30000-70000 tokens each plus orchestration, integration and correction yields about 1-3 million tokens. It is uncalibrated and is not the debate's actual spend. Self-hosted runtime tokens incur GPU time and electricity, not an assumed API fee. Import preparation tokens are additional and must be logged separately from interactive tokens.

## Candidate gates to debate

Use fixed held-out examples with human rubrics covering partial answers, plausible mistakes, unsupported claims, requests for answers, adversarial source instructions and extraction errors. Suggested release targets are at least 95% correct rubric decisions and at most 2% incorrect-answer acceptance on the supported slices, at least 95% source-supported claims, and zero illegal progress transitions in state tests. These are proposed thresholds, not measured achievements.

Proposed load gate: a one-hour replay at the expected pilot arrival distribution, p95 first visible tutor content under 3 seconds and completed short turn under 15 seconds, with no out-of-memory errors and no dropped attempts. Re-evaluate the targets if the school-user usability test shows they are inadequate. A wait state must offer an existing review exercise rather than fabricate feedback.

Keep a small no-tutor quiz baseline and inspect delayed unaided results in the pilot. Passing model grading checks does not demonstrate that students learned more.
