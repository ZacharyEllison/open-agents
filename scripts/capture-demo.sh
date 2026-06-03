#!/usr/bin/env bash
# Capture a demo screenshot of open-agent TUI
# Requires: termshot (brew install homeport/tap/termshot) or similar
#
# Usage: ./scripts/capture-demo.sh
#
# Alternative manual approach:
#   1. Run: bun run dev
#   2. Take a screenshot of the terminal showing the welcome screen
#   3. Save to: docs/assets/demo.png

set -euo pipefail

OUTDIR="$(dirname "$0")/../docs/assets"
mkdir -p "$OUTDIR"

echo "To capture a demo screenshot:"
echo ""
echo "  Option 1: Use termshot"
echo "    brew install homeport/tap/termshot"
echo "    termshot --show-cmd -- bun run dev"
echo "    mv *.png $OUTDIR/demo.png"
echo ""
echo "  Option 2: Manual"
echo "    1. Run: bun run dev"
echo "    2. Screenshot the terminal (Cmd+Shift+4 on macOS)"
echo "    3. Save to: $OUTDIR/demo.png"
echo ""
echo "  Option 3: SVG via svg-term"
echo "    npm install -g svg-term-cli"
echo "    # Record with asciinema first, then convert"
echo "    asciinema rec /tmp/demo.cast"
echo "    svg-term --in /tmp/demo.cast --out $OUTDIR/demo.svg"
