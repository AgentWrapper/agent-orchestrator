#!/usr/bin/env bash
#
# Fresh-machine install check. The Dockerfile installs `ao` on PATH in a clean
# image and runs this; it proves a freshly installed binary actually works on a
# machine with no Go toolchain and no developer state. The COMPREHENSIVE,
# cross-platform behavioural suite lives in Go (backend/internal/cli/e2e_test.go,
# `go test -tags e2e`); this stays deliberately small and linear.

set -euo pipefail

AO_BIN="${AO_BIN:-ao}"
tmp="$(mktemp -d)"
export AO_RUN_FILE="$tmp/running.json"
export AO_DATA_DIR="$tmp/data"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

echo "ao binary : $(command -v "$AO_BIN")"
"$AO_BIN" version            >/dev/null || fail "version"
"$AO_BIN" doctor             >/dev/null || fail "doctor"

# `ao start` is now the desktop-app launcher: it resolves an installed app or
# fetches the release, then opens it (it no longer runs a daemon). On a fresh
# container there is no installed app, so start reaches the fetch path. Depending
# on the current release platform assets, this can either download/open the app
# successfully or fail with a clear fetch/platform error. Both are sane fresh-box
# outcomes; what must never happen is a panic, a daemon-start path, or a silent
# success that did not install the expected fetched app.
if out="$("$AO_BIN" start 2>&1)"; then
  app="$tmp/agent-orchestrator.AppImage"
  [ -x "$app" ] || fail "start succeeded but did not install executable AppImage at $app; got: $out"
  echo "$out" | grep -qi "desktop app" || fail "start succeeded without desktop launcher notice; got: $out"
else
  echo "$out" | grep -qiE "download|ao start:" || fail "start did not fail with a clear error; got: $out"
fi

echo "fresh-install check: OK"
