# Contributing

## Prerequisites

- [Bun](https://bun.sh) **≥ 1.3.14** (`packageManager` in root `package.json`)
- Rust toolchain (for `packages/natives` / `crates/pi-natives`) when working on native code
- Optional: Python 3 for `python/omp-rpc`, `python/robomp` tests

## Repository layout

| Package | Path | Role |
| ------- | ---- | ---- |
| `@open-agents/coding-agent` | `packages/coding-agent` | CLI (`open-agent`), tools, session, TUI integration |
| `@open-agents/agent` | `packages/agent` | Agent loop, tiers, compaction |
| `@open-agents/ai` | `packages/ai` | Local providers, streaming, models catalog |
| `@open-agents/tui` | `packages/tui` | Terminal UI |
| `@open-agents/natives` | `packages/natives` | Rust-backed grep/PTY/media |
| `@open-agents/utils` | `packages/utils` | Paths, env, logging |
| `@open-agents/stats` | `packages/stats` | `open-agent stats` dashboard |
| `@open-agents/mnemopi` | `packages/mnemopi` | Memory backend |
| `@open-agents/hashline` | `packages/hashline` | Edit/snapshot primitives |

Rust crate: `crates/pi-natives`.

## First-time setup

```sh
git clone <your-fork-url> open-agents
cd open-agents
bun install
bun run install:dev   # optional: link coding-agent + ai globally for `open-agent` on PATH
```

Run from source (no install):

```sh
bun run dev
# or
bun run packages/coding-agent/src/cli.ts
```

Build standalone binary:

```sh
bun run build --cwd=packages/coding-agent
# output: dist/open-agent
```

Smoke-test compiled workers:

```sh
bun run packages/coding-agent/src/cli.ts --smoke-test
```

## Commands

Run from repo root unless noted.

| Command | Purpose |
| ------- | ------- |
| `bun check` | Typecheck (all workspaces) + Biome on repo root |
| `bun test` | TypeScript tests (parallel) + Rust tests |
| `bun run test:ts` | TS tests only |
| `bun run lint` / `bun run fmt` / `bun run fix` | Biome lint / format / fix |
| `bun run build:native` | Build natives addon |
| `bun run generate-models` | Regenerate `packages/ai/src/models.json` from descriptors |
| `bun run generate-docs-index` | Refresh embedded docs index in coding-agent |
| `bun --cwd=packages/coding-agent test` | Package-local tests |

Do **not** use `tsc` / `npx tsc` — use `bun check`.

## Code conventions

See root **`AGENTS.md`** for binding rules: Bun APIs, no `console.log` in coding-agent (use `logger` from `@open-agents/utils`), prompts in `.md` files only, `#private` fields, `Promise.withResolvers()`, worker spawn pattern for compiled binaries, no `mock.module()` in tests, changelog format, etc.

## Documentation

User and maintainer docs live in **`docs/`** (this tree). After editing markdown under `docs/`, run:

```sh
bun run generate-docs-index
```

The CLI serves these via internal `oa://` URLs. Keep docs aligned with code — especially `modelTiers`, local providers, and `.open-agent` paths.

## Changelog

Package changelogs: `packages/*/CHANGELOG.md`. Add entries under `## [Unreleased]` only; do not edit released version sections.

## Pull requests

- Focused diffs; match existing style in touched files.
- Run `bun check` and relevant tests before opening a PR.
- Do not commit generated `models.json` unless you ran `generate-models` for a deliberate catalog change.

## Related docs

- [configuration.md](./configuration.md) — local setup and env vars
- [architecture.md](./architecture.md) — tier model design
- Root [README.md](../README.md) — product overview
