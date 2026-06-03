#!/usr/bin/env bash
# Legacy wrapper — the demo now uses the real TUI via demo.tape directly.
# This script is kept for the static welcome capture (PNG/static screenshots).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export COLORTERM=truecolor
export TERM=xterm-256color

exec bun "$ROOT/scripts/capture-welcome-demo.ts" --full-demo
