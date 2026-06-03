#!/usr/bin/env bash
# Simulated open-agent TUI session for VHS demo capture (no live LLM).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export COLORTERM=truecolor
export TERM=xterm-256color

# Theme-aligned truecolor helpers (dark.json)
accent() { printf '\033[38;2;254;188;56m%s\033[0m' "$1"; }
muted() { printf '\033[38;2;119;125;136m%s\033[0m' "$1"; }
dim() { printf '\033[38;2;95;102;115m%s\033[0m' "$1"; }
success() { printf '\033[38;2;137;210;129m%s\033[0m' "$1"; }
error() { printf '\033[38;2;252;60;75m%s\033[0m' "$1"; }
cyan() { printf '\033[38;2;0;136;250m%s\033[0m' "$1"; }
green() { printf '\033[38;2;137;210;129m%s\033[0m' "$1"; }
red() { printf '\033[38;2;252;60;75m%s\033[0m' "$1"; }

type_chars() {
	local text="$1"
	local delay="${2:-0.04}"
	local i c
	for ((i = 0; i < ${#text}; i++)); do
		c="${text:i:1}"
		printf '%s' "$c"
		sleep "$delay"
	done
}

spinner_line() {
	local frame="$1"
	local msg="$2"
	printf '\r\033[K'
	dim "  ${frame} "
	muted "$msg"
}

clear

# Phase 1: welcome / triforce (real renderer output)
bun "$ROOT/scripts/capture-welcome-demo.ts"
sleep 2.5

# Phase 2: transition into an active session
printf '\n'
dim "───────────────────────────────────────────────────────────────────────────────"
printf '\n\n'

PROMPT="Fix the null check bug in src/main.ts"
printf '  '
type_chars "$PROMPT" 0.045
printf '\n\n'
sleep 0.4

# Phase 3: agent working (tools + brief reply)
assistant_line() {
	muted "  I'll inspect src/main.ts and patch the unsafe access."
	printf '\n\n'
}
assistant_line

frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
spinner_line "${frames[0]}" "Read src/main.ts"
sleep 0.55
spinner_line "${frames[2]}" "Read src/main.ts"
sleep 0.45
printf '\r\033[K'
success "  ✓ "
accent "Read"
dim ": "
muted "src/main.ts"
printf '\n'
sleep 0.25

spinner_line "${frames[5]}" "Edit src/main.ts"
sleep 0.65
printf '\r\033[K'
success "  ✓ "
accent "Edit"
dim ": "
muted "src/main.ts"
printf '\n'
sleep 0.2

dim "     "
red "- const result = data.value;"
printf '\n'
dim "     "
green "+ const result = data?.value ?? defaultValue;"
printf '\n\n'
sleep 0.35

muted "  Null check on line 42 — optional chaining applied. Ready for your next prompt."
printf '\n\n'
sleep 0.5

# Phase 4: prompt ready (cursor)
printf '  '
cyan "❯"
printf ' '
dim "Ask anything…"
sleep 2
