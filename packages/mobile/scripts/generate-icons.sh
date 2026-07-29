#!/usr/bin/env bash
# Regenerate every app icon asset from assets/ao-logo.svg (the repo-root source of truth).
#
#   packages/mobile/scripts/generate-icons.sh
#
# Stages:
#   1. render-svg.mjs  rasterises assets/ao-logo.svg at 4096px via frontend's Chromium
#   2. separate.py     splits the render into wand / creature layers by colour
#   3. compose.py      recolours to the Electron gradient and emits every output
#
# Outputs land in packages/mobile/assets/: the Icon Composer bundle AO.icon (iOS
# 26 Liquid Glass) plus the flat rasters used by Android, web and Expo Go.
#
# Verify the Liquid Glass result without a build:
#   scripts/preview-icon.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mobile="$(dirname "$here")"
assets="$mobile/assets"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "==> rasterising ao-logo.svg"
node "$here/icon-build/render-svg.mjs" "$work/logo.png" 4096

echo "==> splitting wand / creature layers"
python3 "$here/icon-build/separate.py" "$work/logo.png" "$work/wand.png" "$work/creature.png"

echo "==> composing icons"
python3 "$here/icon-build/compose.py" \
  --creature "$work/creature.png" --wand "$work/wand.png" --out "$work/out"

echo "==> installing into assets/"
rm -rf "$assets/AO.icon"
mkdir -p "$assets/AO.icon/Assets"
cp "$work/out/layers/creature.png" "$work/out/layers/wand.png" \
   "$work/out/layers/tip-glow.png" "$assets/AO.icon/Assets/"
cp "$here/icon-build/icon.json" "$assets/AO.icon/icon.json"

for f in icon.png splash-icon.png favicon.png \
         android-icon-foreground.png android-icon-monochrome.png; do
  cp "$work/out/$f" "$assets/$f"
done

echo "==> done"
ls -1 "$assets"
