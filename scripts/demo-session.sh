#!/usr/bin/env bash
# Simulated open-agent TUI session for VHS demo capture (no live LLM).
# Renders welcome shimmer + tiered interaction on every frame via capture-welcome-demo.ts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export COLORTERM=truecolor
export TERM=xterm-256color

exec bun "$ROOT/scripts/capture-welcome-demo.ts" --full-demo
