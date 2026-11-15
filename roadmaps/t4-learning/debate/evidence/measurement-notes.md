# Measurement notes

Collected on 2026-11-14. No application was built and no model was downloaded.

The workspace contained only `.git` before debate initialization. Git reported no commits. Searches found no project instructions, calibration, prior debates or decision records. No broader personal repositories were scanned.

`Get-PSDrive C` reported 71.71 GiB free on the local Windows workstation. `Get-CimInstance Win32_OperatingSystem` failed because CIM access was unavailable. `capacity.py` was absent from both local skill roots. These results do not describe the deployment server. There is no server connection in the task.

## Attention-cache arithmetic

Source: https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/raw/main/config.json

For this model, a conventional FP16 cache requires `2 * 36 layers * 8 KV heads * 128 head dimension * 2 bytes = 147456 bytes` per token per sequence. At 4096 total cached tokens, that is 0.5625 GiB per sequence. Four sequences require 2.25 GiB and eight require 4.5 GiB. Outputs are saved in `kv-arithmetic.json`.

This calculation excludes model weights, quantization metadata, activations, CUDA buffers, allocator overhead and runtime reservations. It assumes independent full-length sequences without prefix sharing. It measures arithmetic, not allocated memory or throughput. A 4-bit weight format does not imply a 4-bit attention cache.

The base Qwen3-4B and Instruct-2507 configs have the same dimensions used here. Instruct-2507 is a sourced non-thinking candidate, not a selected production model. The exact quantized artifact and runtime version must be tested together on the T4.

## Source boundaries

LearnHarness and Gizmo were inspected through their public sites and official documentation. No authenticated product session was tested. Product marketing and model-card benchmarks do not establish this app's learning effectiveness or server capacity.

https://learnharness.ai/
https://help.gizmo.ai/en/articles/13011417-how-does-the-ai-tutor-work
https://help.gizmo.ai/en/articles/15647638-what-is-spaced-repetition
https://raw.githubusercontent.com/janestreet/agent_skills/master/socratic-tutor/SKILL.md
https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507
https://docs.vllm.ai/en/latest/features/quantization/
https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md
https://pubmed.ncbi.nlm.nih.gov/40560616/
