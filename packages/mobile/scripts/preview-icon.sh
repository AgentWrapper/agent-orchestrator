#!/usr/bin/env bash
# Render the AO.icon bundle exactly as iOS 26 will draw it, without a build.
#
#   scripts/preview-icon.sh [output-dir]
#
# Uses ictool, the CLI inside Icon Composer.app. It validates icon.json (printing
# any problems as JSON) and renders all six appearance renditions plus a
# light-angle sweep showing how the specular highlight tracks device tilt.
#
# Use THIS, not the simulator, to judge the icon. The iOS simulator does not
# implement the Liquid Glass icon material: it draws the tile flat, with no
# silver edge and no tile gradient. Apple's own icons render flat there too, so a
# flat-looking icon in the simulator is not a bug in this asset -- check with a
# control icon before chasing it.
#
# Do not "fix" the flat simulator look by baking a rim or a background gradient
# into the artwork. On real hardware iOS applies its own pass on top, and the two
# stack: baking the extracted rim measured top-edge luminance 160 -> 220 and
# bottom 93 -> 154. The renders this script produces already include the system
# pass and are what a device shows.
set -euo pipefail

app="/Applications/Xcode.app/Contents/Applications/Icon Composer.app"
ictool="$app/Contents/Executables/ictool"
[ -x "$ictool" ] || { echo "ictool not found -- Xcode 26+ required" >&2; exit 1; }
export DYLD_FRAMEWORK_PATH="$app/Contents/Frameworks"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
icon="$(dirname "$here")/assets/AO.icon"
out="${1:-$(mktemp -d)}"
mkdir -p "$out"

for r in Default Dark TintedLight TintedDark ClearLight ClearDark; do
  "$ictool" "$icon" --export-image --output-file "$out/$r.png" \
    --platform iOS --rendition "$r" --width 512 --height 512 --scale 1
done

for angle in 0 90 180 270; do
  "$ictool" "$icon" --export-image --output-file "$out/tilt-$angle.png" \
    --platform iOS --rendition Default --width 512 --height 512 --scale 1 \
    --light-angle "$angle"
done

echo "wrote renditions to $out"
ls -1 "$out"
