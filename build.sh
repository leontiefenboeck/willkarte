#!/usr/bin/env bash
# Packages the Firefox extension from willkarte-chromium/ as willkarte-firefox.xpi.
#
# Chrome/Edge/Brave users load willkarte-chromium/ directly (willkarte-chromium/manifest.json is the MV3
# manifest). Firefox needs the MV2 manifest, so here we swap manifest.firefox.json
# in as manifest.json and zip it up.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp -r "$root/willkarte-chromium" "$work/firefox"
mv -f "$work/firefox/manifest.firefox.json" "$work/firefox/manifest.json" # MV2 → manifest.json

rm -f "$root/willkarte-firefox.xpi"
( cd "$work/firefox" && zip -qr -X "$root/willkarte-firefox.xpi" . -x '.*' )

echo "Built willkarte-firefox.xpi"
