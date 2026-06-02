# open-agent documentation

Developer-focused notes for the local-first coding agent fork. For a product overview and install steps, see the [repository README](../README.md).

## Core

| Doc | Description |
| --- | ----------- |
| [architecture.md](./architecture.md) | 3-tier models (interface / worker / compactor), tool gating, delegation |
| [local-models.md](./local-models.md) | Eight local runtimes, keyless auth, llama.cpp, ONNX tiny models |
| [configuration.md](./configuration.md) | `config.yml`, `models.yml`, `modelTiers`, `OA_*` env, `.open-agent` migration |
| [contributing.md](./contributing.md) | Monorepo layout, build, test, conventions |

## Configuration and models (legacy topic docs)

| Doc | Description |
| --- | ----------- |
| [config-usage.md](./config-usage.md) | Multi-root discovery (`.open-agent`, `.claude`, …) |
| [models.md](./models.md) | `models.yml` schema and resolution (being aligned with local-only + `modelTiers`) |
| [environment-variables.md](./environment-variables.md) | Exhaustive env reference (includes legacy cloud keys) |
| [compaction.md](./compaction.md) | Context compaction and branch summaries |

## Runtime subsystems

| Doc | Description |
| --- | ----------- |
| [session.md](./session.md) | Session JSONL storage |
| [tui.md](./tui.md) | Interactive UI |
| [natives-architecture.md](./natives-architecture.md) | Native addon layout |
| [sdk.md](./sdk.md) | Embedding `@open-agents/coding-agent` |
| [mcp-config.md](./mcp-config.md) | MCP server configuration |

## Tools

Per-tool references: [tools/](./tools/) (bash, read, task, …).

## Skills and extensions

| Doc | Description |
| --- | ----------- |
| [skills.md](./skills.md) | Skills overview |
| [skills/authoring-extensions.md](./skills/authoring-extensions.md) | Extension authoring |
| [extensions.md](./extensions.md) | Extension loading |

## Note on rebranding

Some older pages still mention `omp`, `oh-my-pi`, `modelRoles`, or cloud OAuth flows. Prefer the **Core** docs above for current open-agent behavior. Auth broker / install-id / cloud provider docs are historical unless you maintain a custom fork with those features enabled.
