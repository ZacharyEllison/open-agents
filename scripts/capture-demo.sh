#!/usr/bin/env bash
# Capture a static welcome screen PNG (legacy). For the README demo GIF, run: vhs scripts/demo.tape
#
# Requires: bun, aha (brew install aha), Google Chrome, ImageMagick
# Usage: ./scripts/capture-demo.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/docs/assets/demo.png"
TMP="${TMPDIR:-/tmp}/open-agent-demo-capture"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

mkdir -p "$TMP" "$(dirname "$OUT")"

if ! command -v aha >/dev/null 2>&1; then
	echo "error: aha not found (brew install aha)" >&2
	exit 1
fi
if [[ ! -x "$CHROME" ]]; then
	echo "error: Google Chrome not found at $CHROME" >&2
	exit 1
fi
if ! command -v magick >/dev/null 2>&1; then
	echo "error: ImageMagick magick not found" >&2
	exit 1
fi

bun "$ROOT/scripts/capture-welcome-demo.ts" >"$TMP/welcome.ansi"

aha --black --no-header <"$TMP/welcome.ansi" >"$TMP/body.html"

cat >"$TMP/welcome.html" <<'HTML'
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0;
    padding: 24px;
    background: #0d0d0d;
  }
  #terminal {
    font-family: "SF Mono", "Menlo", "Monaco", "Cascadia Code", "Consolas", monospace;
    font-size: 14px;
    line-height: 1.25;
    white-space: pre;
    letter-spacing: 0;
  }
</style>
</head>
<body>
<div id="terminal">
HTML
cat "$TMP/body.html" >>"$TMP/welcome.html"
cat >>"$TMP/welcome.html" <<'HTML'
</div>
</body>
</html>
HTML

"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
	--window-size=1100,700 \
	--screenshot="$TMP/raw.png" \
	"file://$TMP/welcome.html"

magick "$TMP/raw.png" -trim +repage -bordercolor '#0d0d0d' -border 20x20 \
	-resize '720x>' "$OUT"

echo "Wrote $OUT ($(magick identify -format '%wx%h' "$OUT"))"
