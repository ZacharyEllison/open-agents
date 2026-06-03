# Configuration

## Config directories

| Path | Purpose |
| ---- | ------- |
| `~/.open-agent/` | User config root (`CONFIG_DIR_NAME`, overridable) |
| `~/.open-agent/agent/` | Agent state: `config.yml`, `models.yml`, sessions, SQLite DBs |
| `<project>/.open-agent/` | Project overrides (skills, agents, MCP, prompts, …) |

Implementation: `packages/utils/src/dirs.ts` (`APP_NAME` = `open-agent`).

### Overrides

| Variable | Effect |
| -------- | ------ |
| `OA_CONFIG_DIR` | Config directory name under `$HOME` (default `.open-agent`) |
| `OA_AGENT_DIR` | Absolute path to agent directory (settings, sessions, DBs) |

Discovery uses **`CONFIG_DIR_NAME`** (`.open-agent`) as the native root in `packages/coding-agent/src/config.ts`. Older **`~/.omp`** installs are migrated automatically on first launch (`~/.omp` is renamed to `~/.open-agent` when the new directory does not exist yet); the migration is skipped when `OA_CONFIG_DIR` is set, in which case you can point `OA_CONFIG_DIR=.omp` at the legacy directory.

On Linux, when `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` are set and the corresponding `…/open-agent` directory exists, some subpaths (sessions, logs, plugins) redirect under XDG. See `DirResolver` in `dirs.ts`.

## Main files

| File | Role |
| ---- | ---- |
| `~/.open-agent/agent/config.yml` | Global settings (schema in `settings-schema.ts`) |
| `<cwd>/.open-agent/config.yml` | Project settings (merged over global) |
| `~/.open-agent/agent/models.yml` | Provider endpoints, custom models, equivalence rules |
| `~/.open-agent/agent/keybindings.yml` | Key chords (not nested under `config.yml`) |
| `~/.open-agent/agent/mcp.json` | User MCP servers |

`Settings` loads global YAML, merges project capability discovery, and persists changes back to `config.yml` (`packages/coding-agent/src/config/settings.ts`). First-time migration can pull from legacy `settings.json` or `agent.db` into `config.yml`.

## `modelTiers`

Replaces **`modelRoles`**. Stored as a flat record in `config.yml`:

```yaml
modelTiers:
  interface: llama.cpp/gemma4-26b-a4b:off   # MoE ~4B active, fast prefill
  worker: llama.cpp/qwen3.6-27b             # dense 27B, deep reasoning + MTP
  compactor: llama.cpp/gemma4-26b-a4b:off   # fallback; reuses interface (no extra slot)
```

Values are model patterns (same grammar as the old roles):

- `provider/modelId`
- Canonical id (provider coalescing)
- `pi/interface`, `pi/worker`, `pi/compactor` (tier aliases)
- Legacy role names in keys are normalized on read (`default` → `interface`, `smol` → `compactor`, etc.)

Optional thinking suffix: `provider/model:high` (or `:off` to disable reasoning tokens entirely — recommended for the interface tier to minimize prefill).

Runtime helpers: `settings.getModelTier()`, `settings.setModelTier()`, `settings.getModelTiers()`.

See [local-models.md](./local-models.md) for model selection guidance and [architecture.md](./architecture.md) for how tiers affect tools, compaction, and `task`.

### On-device compactor (recommended)

Set `providers.compactorOnnxModel` to run compaction summaries on CPU via ONNX instead of using a server model slot:

```yaml
providers:
  compactorOnnxModel: qwen3-1.7b   # downloads ONNX weights on first use (~1.7 GB)
```

When enabled, the compactor tier runs entirely on-device — no model slot on llama-server, no swapping. On ONNX failure it falls back to `modelTiers.compactor` (which should reuse an already-loaded model to avoid a 3rd model swap).

See [docs/examples/local-llama-config.yml](./examples/local-llama-config.yml) for a complete example config.

## `providers.*` settings

Nested under `config.yml` (not `models.yml`). Common entries:

| Key | Meaning |
| --- | ------- |
| `providers.tinyModel` | Local/online title model (`online` default) |
| `providers.memoryModel` | Mnemopi LLM backend |
| `providers.compactorOnnxModel` | ONNX compaction summarizer |
| `providers.autoThinkingModel` | Classifier for `auto` thinking level |
| `providers.tinyModelDevice` / `OA_TINY_DEVICE` | ONNX device |
| `providers.tinyModelDtype` / `OA_TINY_DTYPE` | ONNX quantization |
| `providers.kimiApiFormat` | `openai` vs `anthropic` (if used) |
| `providers.openaiWebsockets` | Codex websocket preference (if used) |

Provider **transport** overrides (base URL, headers, API flavor) belong in **`models.yml`** under `providers.<id>`.

## `models.yml`

```yaml
providers:
  ollama:
    baseUrl: http://127.0.0.1:11434
  llama.cpp:
    baseUrl: http://127.0.0.1:8080
    modelPath: /path/to/model.gguf
equivalence:
  overrides: {}
  exclude: []
```

- Loaded by `ModelRegistry` (`packages/coding-agent/src/config/model-registry.ts`).
- If only `models.json` exists, it is migrated once to `models.yml`.
- Local providers need no `apiKey`; see [local-models.md](./local-models.md).

Other useful `config.yml` keys: `enabledModels`, `disabledProviders`, `disabledExtensions`, `memory.backend`, `compaction.*`, `task.*`, `secrets.enabled`.

Full schema: `packages/coding-agent/src/config/settings-schema.ts`. UI: `/settings`.

## Environment variables

Loaded via `$env` from `@open-agents/utils` (`packages/utils/src/env.ts`):

1. Process environment
2. `<cwd>/.env`
3. `~/.open-agent/agent/.env`
4. `~/.open-agent/.env`
5. `~/.env`

Inside each parsed `.env` file, **`OMP_*` and `PI_*` keys are mirrored to `OA_*`** (same suffix).

### Frequently used `OA_*` variables

| Variable | Purpose |
| -------- | ------- |
| `OA_CONFIG_DIR` | Config root directory name |
| `OA_AGENT_DIR` | Agent directory path |
| `OA_COMPILED` | Set in compiled binary builds |
| `OA_TINY_DEVICE` | Override tiny-model ONNX device |
| `OA_TINY_DTYPE` | Override tiny-model dtype / quantization |
| `OA_EDIT_VARIANT` | Edit tool variant (`hashline`, …) |
| `OA_EDIT_FUZZY` / `OA_EDIT_FUZZY_THRESHOLD` | Edit fuzzy matching |
| `OA_NO_TITLE` | Disable automatic session titles |
| `OA_NO_INTENT` | Disable intent tracing injection |
| `OA_STREAM_IDLE_TIMEOUT_MS` | Provider stream idle timeout |
| `OA_STREAM_FIRST_EVENT_TIMEOUT_MS` | First-token timeout |
| `OA_OPENAI_STREAM_*` | OpenAI-specific stream timeout overrides |
| `OA_GITHUB_CACHE_DB` | GitHub view cache DB path |
| `OA_SKIP_SETUP` | Skip first-run setup wizard |
| `OA_BLOCKED_AGENT` | Block a subagent name in `task` |
| `OA_TIMING` | Logger timing verbosity (`full`) |

Provider-specific `*_API_KEY` env vars are still read when present; the default install uses **keyless** `NullAuthCredentialStore` (`discoverAuthStorage` → `AuthStorage.createKeyless()`).

Extended reference (includes legacy cloud keys still present in code paths): [environment-variables.md](./environment-variables.md).

## Migration from oh-my-pi / `.omp`

1. **Directory** — On first launch `~/.omp` is renamed automatically to `~/.open-agent` when the new directory does not exist yet (skipped if `OA_CONFIG_DIR` is set, in which case you can set `OA_CONFIG_DIR=.omp` to keep using the legacy directory).
2. **Settings** — In `config.yml`, rename `modelRoles:` to `modelTiers:` and collapse keys using the [legacy map](./architecture.md#legacy-role-mapping) (eight roles → three tiers).
3. **CLI** — Command is `open-agent` (`packages/coding-agent` bin); binary output `dist/open-agent`.
4. **Packages** — Imports use `@open-agents/*` instead of `@oh-my-pi/*` / `@mariozechner/*`.
5. **Auth** — Remove reliance on `omp login` / OAuth; local providers work without credentials.
6. **Project dirs** — Prefer `<repo>/.open-agent/` over `<repo>/.omp/`.

`settings.json` → `config.yml` migration runs automatically on first load if `config.yml` is missing.

## Discovery order

Project + user config roots are scanned in priority order: **`.open-agent`** (native), then `.claude`, `.codex`, `.gemini` (`packages/coding-agent/src/config.ts`). Details: [config-usage.md](./config-usage.md) (some examples still say `.omp`; paths are the same shape with `.open-agent`).

## Related docs

- [architecture.md](./architecture.md)
- [local-models.md](./local-models.md)
- [models.md](./models.md)
