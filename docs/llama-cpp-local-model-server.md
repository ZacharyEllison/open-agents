# llama.cpp local model server

Recommended `llama-server` configuration for running open-agent with the 3-tier architecture. This doc covers the multi-model preset system, per-model tuning, and the KV cache reuse tradeoff.

## Overview

`llama-server` (from [llama.cpp](https://github.com/ggml-org/llama.cpp)) can host multiple GGUF models simultaneously via `--models-preset`. open-agent's interface and worker tiers map to two co-resident models; the compactor runs on-device via ONNX and does not consume a server slot.

```
┌─────────────────────────────────────────────┐
│ llama-server (--models-max 2)               │
│                                             │
│   slot 0: gemma4-26b-a4b  (interface)       │
│   slot 1: qwen3.6-27b     (worker)          │
│                                             │
│   compactor: ONNX qwen3-1.7b (off-server)  │
└─────────────────────────────────────────────┘
```

## serve.sh

A launch script that wraps `llama-server` with the preset file:

```bash
#!/usr/bin/env bash
set -euo pipefail

PRESET="/path/to/config.ini"
: "${LLAMA_PORT:=8080}"
: "${LLAMA_MODELS_MAX:=2}"
: "${LLAMA_PARALLEL:=1}"
: "${LLAMA_SLOT_PROMPT_SIMILARITY:=0.5}"

llama-server \
    --models-preset "${PRESET}" \
    --models-max "${LLAMA_MODELS_MAX}" \
    --parallel "${LLAMA_PARALLEL}" \
    --kv-unified \
    --slot-prompt-similarity "${LLAMA_SLOT_PROMPT_SIMILARITY}" \
    --host 0.0.0.0 \
    --port "${LLAMA_PORT}" \
    --metrics \
    --webui-mcp-proxy \
    --prio 2
```

### Key flags

| Flag | Value | Why |
|------|-------|-----|
| `--models-max 2` | 2 | Interface + worker co-resident. No swapping between turns. |
| `--parallel 1` | 1 (global default) | One concurrent request per model. Per-model `parallel` in `config.ini` overrides this. |
| `--kv-unified` | — | Share KV cache memory across models instead of pre-allocating per slot. |
| `--slot-prompt-similarity 0.5` | 0.5 | Reuse a slot's KV cache when the prompt prefix overlaps by 50%+. See [KV cache reuse](#kv-cache-reuse-tradeoff) below. |
| `--metrics` | — | Expose `/metrics` for timing diagnostics. |
| `--webui-mcp-proxy` | — | Expose the bundled web UI / MCP proxy. |
| `--prio 2` | 2 | Scheduling priority for the server process. |

`--cache-ram` is left at its default (RAM-based KV persistence enabled) so released slots keep their KV for reuse on the next turn.

## config.ini (model presets)

Each `[section]` defines a model that `llama-server` can load. The `[*]` section provides defaults. Models are referenced by section name in open-agent as `llama.cpp/<section-name>`.

### Global defaults

```ini
[*]
parallel = 2
ctx-checkpoints = 8
```

- `parallel = 2`: default concurrent slots per model (individual models override to `1` when they need the full context window).
- `ctx-checkpoints = 8`: KV checkpoints for mid-prefill recovery. Reduces "full prompt re-processing" events on hybrid architectures.

### Interface model: Gemma 4 26B-A4B (MoE)

```ini
[gemma4-26b-a4b]
model = /path/to/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf
mmproj = /path/to/mmproj-gemma-4-26B-A4B-it-Q8_0.gguf
mmproj-offload = true
parallel = 1
ctx-size = 131072
cache-type-k = q8_0
cache-type-v = q8_0
threads = 16
threads-batch = 16
batch-size = 4096
ubatch-size = 4096
flash-attn = on
n-gpu-layers = 99
jinja = true
context-shift = true
reasoning = true
temperature = 1.0
top-p = 0.95
top-k = 64
min-p = 0.05
; Speculative decoding with E2B draft model (same Gemma 4 family vocab)
model-draft = /path/to/gemma-4-E2B-it-Q4_K_S.gguf
n-gpu-layers-draft = 99
spec-draft-n-max = 2
draft-p-min = 0.75
cache-type-k-draft = q4_0
cache-type-v-draft = q4_0
```

**Why MoE for the interface:** Gemma 4 26B-A4B activates only ~4B parameters per token despite 26B total. This yields prefill throughput of 600+ tok/s on Apple Silicon (M3 Max) — roughly 3x faster than a dense 14B model at the same context length. Since the interface tier's job is context gathering and delegation (not deep reasoning), the speed advantage outweighs the parameter-count advantage of a dense model.

**Speculative decoding:** The `model-draft` field points to a Gemma 4 E2B (2B) model from the same family, enabling speculative decoding for faster generation. The draft model shares the vocabulary, so no tokenizer mismatch.

### Worker model: Qwen 3.6 27B (dense)

```ini
[qwen3.6-27b]
model = /path/to/Qwen3.6-27B-MTP-IQ4_XS.gguf
parallel = 1
ctx-size = 65536
cache-type-k = q4_0
cache-type-v = q4_0
batch-size = 4096
ubatch-size = 4096
threads = 16
threads-batch = 16
flash-attn = on
n-gpu-layers = 99
jinja = true
swa-full = true
context-shift = false
reasoning = true
temperature = 0.7
top-p = 0.95
top-k = 30
chat-template-kwargs = {"preserve_thinking": true}
; Native MTP speculative decoding (weights are inside the -MTP- GGUF)
spec-type = draft-mtp
spec-draft-n-max = 3
draft-p-min = 0.85
cache-type-k-draft = q4_0
cache-type-v-draft = q4_0
```

**Hybrid SWA notes:** Qwen 3.6 uses a hybrid Sliding Window Attention architecture. Key settings:

- `swa-full = true`: allocates the full SWA cache, reducing "forcing full prompt re-processing" events (see llama.cpp PR #13194).
- `context-shift = false`: MTP disables context-shift internally; keeping it off avoids conflicts.
- `cache-type-k/v = q4_0`: smaller KV reduces memory pressure for the 65k context window.

**MTP decoding:** The `-MTP-` GGUF files include a built-in Multi-Token Prediction head — no separate draft model needed. `spec-type = draft-mtp` enables this.

## KV cache reuse tradeoff

Two flags control whether llama-server reuses KV cache across requests:

| Flag | Current | Effect |
|------|---------|--------|
| `--slot-prompt-similarity` | `0.5` | Minimum prompt prefix overlap required to reuse a slot's KV cache. `0.5` = reuse when 50%+ of the prefix matches. |
| `--cache-ram` | default (enabled) | RAM-based KV cache persistence. Enabled = KV survives slot release and is available for the next turn. |

### What this buys you

The interface tier carries a large fixed prefix (system prompt + tool schemas + project context — on the order of 20-40k tokens). With cache reuse enabled, that prefix is prefilled **once** and reused on every subsequent turn: only the new turn (~200-2000 tokens) is prefilled, dropping TTFT from tens of seconds to ~1-3s. The fixed prefix still exists, but it is effectively free after the first turn.

This pairs with the harness-side trimming levers (worker-only heavy tools hidden from the interface schema, and `interface.contextFileMaxChars` to trim/skip AGENTS.md for the interface) which reduce the size of that prefix in the first place.

### Verifying reuse

After two interface turns, inspect the slot:

```bash
curl -s "http://127.0.0.1:8080/slots?model=gemma4-26b-a4b"
```

On the second turn, `n_prompt_tokens_processed` should be small (only the new suffix) while `n_prompt_tokens` reflects the full prompt — that gap is the reused cache.

### Caveat: hybrid SWA models

Hybrid Qwen checkpoints (SWA architecture) can produce corrupted output when partial KV cache reuse crosses a checkpoint boundary incorrectly. `--slot-prompt-similarity 0.5` is safe for the MoE Gemma interface. If you route a hybrid Qwen model as the worker and observe corrupted output, lower similarity for that workload (llama-server does not yet support per-model cache settings).

### Recommendations

| Setup | `slot-prompt-similarity` | `cache-ram` | Notes |
|-------|--------------------------|-------------|-------|
| Current (default) | `0.5` | default (enabled) | Reuses cache when 50%+ prefix matches. Safe for the MoE Gemma interface; near-instant repeat turns. |
| Conservative | `0.0` | `0` | Full re-prefill every turn. Only needed if a hybrid SWA worker corrupts on partial reuse. |

Also keep the prompt small via aggressive interface compaction (`interface.compactionThresholdTokens`) and the ONNX compactor, so even a cold prefill stays cheap.

## Memory budget (Apple Silicon example)

On a 64 GB unified memory Mac (M3 Max):

| Component | Approximate size |
|-----------|-----------------|
| Gemma 4 26B-A4B (Q4_K_XL) + E2B draft | ~16 GB + ~2 GB |
| Qwen 3.6 27B (IQ4_XS) | ~15 GB |
| KV cache (131k + 65k ctx, q4-q8) | ~8–12 GB |
| System + other processes | ~15–20 GB |

Total: ~50-65 GB. Fits within 64 GB unified with some swap pressure under peak KV usage.

## Related docs

- [local-models.md](./local-models.md) — tier model selection and provider config
- [configuration.md](./configuration.md) — `config.yml` and `models.yml` reference
- [prefill-latency-local-kv-cache.md](./prefill-latency-local-kv-cache.md) — prompt layering strategies for cache reuse
- [architecture.md](./architecture.md) — 3-tier model architecture
