#!/usr/bin/env bash
# Vendor the browser assets into public/ so nothing third-party sits in front of
# first paint. Re-run to refresh; commit whatever it writes.
#
#   ./scripts/vendor-assets.sh
set -euo pipefail

DATASTAR_VERSION="v1.0.2"
FONT_CSS='https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;700&display=swap&subset=latin,latin-ext'
# Google serves woff2 only to browsers that advertise support.
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

cd "$(dirname "${BASH_SOURCE[0]}")/.."
out=public
mkdir -p "$out/fonts"

echo "==> datastar $DATASTAR_VERSION"
curl -fsSL -o "$out/datastar.js" \
  "https://cdn.jsdelivr.net/gh/starfederation/datastar@${DATASTAR_VERSION}/bundles/datastar.js"
printf '    %s (%s bytes)\n' "$out/datastar.js" "$(wc -c < "$out/datastar.js" | tr -d ' ')"

echo "==> IBM Plex Mono + Sans"
css=$(curl -fsSL -H "User-Agent: $UA" "$FONT_CSS")

# Pull every woff2 the stylesheet references, then repoint the CSS at our copies.
printf '%s\n' "$css" | grep -o 'https://fonts.gstatic.com/[^)]*\.woff2' | sort -u | while read -r u; do
  f="$(basename "$u")"
  [ -f "$out/fonts/$f" ] || curl -fsSL -o "$out/fonts/$f" "$u"
  printf '    fonts/%s\n' "$f"
done

printf '%s\n' "$css" \
  | sed -E 's#https://fonts\.gstatic\.com/[^)]*/([^/)]+\.woff2)#./fonts/\1#g' \
  > "$out/fonts.css"

# The page is all latin, and a font arriving after first paint reflows every row
# (a ~0.17 layout shift, measured). Preload just the latin faces so they land
# with the HTML instead of swapping in later. `crossorigin` is required on font
# preloads even same-origin, because font fetches are CORS-mode.
# __BASE__ is substituted at render time — the mount prefix is runtime config.
# Weights often share one file, so dedupe — a repeated preload is a wasted hint.
awk '
  /^\/\* / { subset = $2 }
  subset == "latin" && match($0, /\.\/fonts\/[^)]+\.woff2/) {
    f = substr($0, RSTART + 2, RLENGTH - 2)
    if (seen[f]++) next
    print "<link rel=\"preload\" as=\"font\" type=\"font/woff2\" crossorigin href=\"__BASE__/static/" f "\" />"
  }
' "$out/fonts.css" > "$out/fonts-preload.html"

printf '%s\n' \
  "" \
  "vendored:" \
  "  $out/datastar.js       datastar $DATASTAR_VERSION" \
  "  $out/fonts.css         $(grep -c '@font-face' "$out/fonts.css") faces" \
  "  $out/fonts/            $(ls "$out/fonts" | wc -l | tr -d ' ') files, $(du -sh "$out/fonts" | cut -f1)" \
  "  $out/fonts-preload.html $(grep -c . "$out/fonts-preload.html") latin faces preloaded"
