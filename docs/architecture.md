# 3-tier model architecture

open-agent replaces the old eight **model roles** (`default`, `smol`, `slow`, `vision`, `plan`, …) with three **model tiers**. Each tier can point at a different local model; behavior is enforced by configuration, prompts, and (for mutating tools) structural checks in the agent loop.

## Tiers

| Tier | Purpose | Typical model size |
| ------ | --------- | ------------------- |
| **interface** | User-facing conversation: gather context, answer questions, delegate work | Small / fast |
| **worker** | Heavy reasoning and file changes (via `task` subagents and role resolution) | Large |
| **compactor** | Context compaction and short summaries | Tiny |

Types and labels live in `@open-agents/agent` (`ModelTier`, `MODEL_TIERS`).

### Legacy role mapping

Old `modelRoles` keys in config are migrated to tier keys when read (`Settings.#resolveTierKey`, `LEGACY_ROLE_TO_TIER` in `model-resolver.ts`):

| Legacy role | Tier |
| ------------- | ------ |
| `default`, `vision` | `interface` |
| `slow`, `plan`, `designer`, `task` | `worker` |
| `smol`, `commit` | `compactor` |

Pattern aliases still work: `pi/interface`, `pi/worker`, `pi/compactor`, and legacy names like `pi/smol` → compactor.

## How tiers are resolved

1. **`modelTiers` in `config.yml`** — record of tier → model pattern (`provider/modelId`, canonical id, or `pi/<tier>` alias). See [configuration.md](./configuration.md).
2. **`resolveModelFromSettings`** — walks `interface` → `worker` → `compactor` (or a custom order) and picks the first configured pattern that matches an available model.
3. **`AgentSession`** — resolves per-role models for compaction (`modelTiers.compactor`), plan mode, commit helpers, Ctrl+P tier cycling, etc. via `#resolveRoleModelFull` / `getModelTier`.
4. **`Agent` runtime** — holds optional `ModelTierConfig` (`setTierModels`). Each loop turn builds `AgentLoopConfig` with `tiers` and `activeTier` (default **`interface`**). When `setTierModels` was never called, all three tiers fall back to the session’s active model.

Primary implementation files:

- `packages/agent/src/types.ts` — tier types, `getActiveModel`, `getActiveTier`
- `packages/agent/src/agent.ts` — tier state, loop config
- `packages/agent/src/agent-loop.ts` — tool gating by tier
- `packages/coding-agent/src/config/model-resolver.ts` — pattern resolution
- `packages/coding-agent/src/config/settings.ts` — `modelTiers` getters/setters
- `packages/coding-agent/src/task/index.ts` — delegation to worker model

## Tool access (`allowedTiers`)

Tools may set `allowedTiers?: ModelTier[]` on `AgentTool`. In `executeToolCalls`, if the tool defines `allowedTiers` and `getActiveTier(config)` is not included, the call fails with:

```text
Tool '<name>' requires the worker tier. Use the 'task' tool to delegate this work.
```

Worker-only tools today (constant `WORKER_ONLY_TIERS` in `packages/coding-agent/src/tools/tier-access.ts`):

- `bash`
- `write`
- `edit` (patch tool)
- `checkpoint` (both checkpoint tools)

All other built-ins allow any tier (empty / omitted `allowedTiers`).

The primary session runs with **`activeTier: "interface"`** unless something calls `Agent.setActiveTier("worker")`. That means mutating tools on the main agent are structurally blocked; the interface model is expected to use **`task`** for implementation work.

## Delegation (`task` tool)

Subagents are defined under `.open-agent/agents/` (and bundled defaults). When the interface tier calls `task`:

1. The tool resolves **`modelTiers.worker`** (not the interface model) via `resolveConfiguredModelPatterns`.
2. `runSubprocess` / `runSubagent` starts a nested `AgentSession` with the subagent’s tool list (full access unless plan mode restricts to read-only tools).
3. Results are returned to the parent session as tool output.

Plan mode further constrains subagents to read/search tools only (`packages/coding-agent/src/task/index.ts`).

## Compactor tier

Compaction does not use the interactive tool surface. `AgentSession` selects a compactor model from `modelTiers.compactor` (`#getCompactionModelCandidates`). Optionally, **`providers.compactorOnnxModel`** runs on-device ONNX summarization (`packages/coding-agent/src/compaction/compactor-onnx.ts`) before falling back to the server compactor model. Details: [compaction.md](./compaction.md), [local-models.md](./local-models.md#on-device-tiny-models).

## Vision

Vision is a **model capability** (`input` includes `image`), not a separate tier. Use a vision-capable model for `modelTiers.interface` (or worker) if you rely on `inspect_image`.

## Package boundaries

```text
@open-agents/ai          Local provider descriptors, streaming, kNoAuth keyless providers
@open-agents/agent       Agent loop, tiers, compaction primitives
@open-agents/coding-agent CLI, tools, session, modelTiers settings, task delegation
@open-agents/natives     Fast grep/PTY; optional ONNX paths for tiny models
```

## Related docs

- [configuration.md](./configuration.md) — `modelTiers`, `models.yml`, config paths
- [local-models.md](./local-models.md) — local inference runtimes and ONNX compactor
- [tools/task.md](./tools/task.md) — task tool parameters and subagent definitions
