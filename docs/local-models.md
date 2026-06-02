# Local models

open-agent is **local-first**: built-in providers are on-machine inference runtimes only. There is no cloud provider catalog in the default dispatch path. Unreachable endpoints are skipped during discovery; no API keys are required for the built-in local providers.

## Supported runtimes

Defined in `packages/ai/src/provider-models/descriptors.ts` as `LOCAL_PROVIDER_DESCRIPTORS`:

| Provider | Default host:port | Default model id | Notes |
| -------- | ----------------- | ---------------- | ----- |
| **ollama** | `127.0.0.1:11434` | `gpt-oss:20b` | Native `/api/tags` enrichment |
| **llama.cpp** | `127.0.0.1:8080` | `default` | Can auto-start `llama-server` (see below) |
| **vllm** | `127.0.0.1:8000` | `gpt-oss-20b` | OpenAI-compatible; uses `max_model_len` for context |
| **lm-studio** | `127.0.0.1:1234` | `llama-3-8b` | LM Studio local server |
| **localai** | `127.0.0.1:8080` | `default` | OpenAI drop-in |
| **jan** | `127.0.0.1:1337` | `default` | Jan desktop API |
| **llamafile** | `127.0.0.1:8080` | `default` | Single-file executables |
| **tabbyapi** | `127.0.0.1:5000` | `default` | ExLlamaV2 / TabbyAPI |

**Port conflict:** `llama.cpp`, `localai`, and `llamafile` all default to **8080**. Run only one on that port, or set distinct `baseUrl` values in `models.yml`.

## Keyless auth (`kNoAuth` / `allowUnauthenticated`)

Local descriptors set `allowUnauthenticated: true`. At runtime:

- `ModelRegistry.getApiKey()` returns the sentinel **`kNoAuth`** (`"N/A"`) for providers in the keyless set when no credential is stored (`packages/coding-agent/src/config/model-registry.ts`).
- `isAuthenticated(kNoAuth)` is **false**, but discovery and requests treat keyless providers as usable when `allowUnauthenticated` is set on the descriptor.
- `resolveModelOverrideWithAuthFallback` treats `kNoAuth` like a valid credential so subagents are not rerouted to a different provider (#1008).

`AuthStorage.createKeyless()` uses `NullAuthCredentialStore` — no SQLite vault, no OAuth. Optional env-based keys (e.g. `OLLAMA_API_KEY`) still work if you enable auth on a local endpoint.

## Configuring providers (`models.yml`)

Default path: `~/.open-agent/agent/models.yml` (see [configuration.md](./configuration.md)).

Minimal example — Ollama only:

```yaml
providers:
  ollama:
    baseUrl: http://127.0.0.1:11434
```

Override discovery or pin models:

```yaml
providers:
  ollama:
    baseUrl: http://127.0.0.1:11434
    discovery:
      type: ollama
    models:
      - id: my-model
        name: My Model
        api: openai-completions
        contextWindow: 128000
        maxTokens: 8192
```

Disable a provider globally via `config.yml`:

```yaml
disabledProviders:
  - tabbyapi
```

## llama.cpp lifecycle (`LlamaCppConfig`)

When `providers.llama.cpp` (or discovery type `llama.cpp`) is used, `ensureLlamaCpp` in `packages/ai/src/local/llama-cpp.ts` may spawn `llama-server`:

| Field | Meaning | Default |
| ----- | ------- | ------- |
| `executablePath` | Path to `llama-server` binary | Search `PATH` |
| `modelPath` | `.gguf` file (required to auto-start) | — |
| `baseUrl` | Server URL | `http://127.0.0.1:8080` |
| `contextSize` | `-c` flag | `4096` |
| `threads` | `-t` flag | `os.availableParallelism()` |
| `autoStart` | Spawn when health check fails | `true` when `modelPath` is set |

If a healthy server already exists at `baseUrl`, it is reused. `models.yml` provider fields map into `LlamaCppModelManagerConfig` (`executablePath`, `modelPath`, `contextSize`, `threads`, `autoStart`, `baseUrl`) via `llamaCppModelManagerOptions`.

Example:

```yaml
providers:
  llama.cpp:
    baseUrl: http://127.0.0.1:8080
    modelPath: /models/my-model.gguf
    executablePath: /usr/local/bin/llama-server
    contextSize: 8192
```

## Choosing models per tier

Assign models in `config.yml` (not `models.yml`):

```yaml
modelTiers:
  interface: ollama/qwen2.5:3b
  worker: ollama/qwen2.5:32b
  compactor: ollama/qwen2.5:1.5b
```

See [architecture.md](./architecture.md) for how tiers interact with tools and compaction.

## On-device tiny models

Separate from the eight HTTP runtimes, open-agent can run **small ONNX/transformers.js models** on CPU for auxiliary tasks (defaults keep these **`online`** / server-based so nothing downloads until you opt in):

| Setting | Purpose |
| ------- | ------- |
| `providers.tinyModel` | Session title generation |
| `providers.memoryModel` | Mnemopi extraction / consolidation |
| `providers.autoThinkingModel` | `auto` thinking-level classifier |
| `providers.compactorOnnxModel` | Compaction summaries (compactor tier); falls back to `modelTiers.compactor` on failure |

Env overrides: `OA_TINY_DEVICE`, `OA_TINY_DTYPE` (see [configuration.md](./configuration.md)).

Local options reuse a shared 1B–1.7B q4 registry; compactor ONNX shares the memory-model model list. Runtime notes (CPU default, load times, shipped model ids) are in the historical maintainer doc sections — implementation: `packages/coding-agent/src/tiny/`, `packages/coding-agent/src/compaction/compactor-onnx.ts`.

## Related docs

- [configuration.md](./configuration.md) — paths, env vars, migration from `.omp`
- [architecture.md](./architecture.md) — interface / worker / compactor behavior
- [models.md](./models.md) — full `models.yml` schema (being updated for local-only defaults)
