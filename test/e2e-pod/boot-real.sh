#!/usr/bin/env bash
# Runs INSIDE the Daytona pod for the stable-release e2e gate.
#
# The release .deb and this harness are uploaded by the runner (AO_DEB_PATH) —
# the pod holds NO secret and fetches NO application code (CodeRabbit lesson: a
# compromised pod finds nothing to pivot to). It boots the real Electron app
# headless, drives it with Playwright (_electron.launch against the app's own
# electron), and emits a final `AO_VERDICT {json}` line the runner parses.
#
# Verdict contract (parsed by scripts/ao-e2e-pod-gate.mjs):
#   {"passed":true}               -> app smoke passed         (green)
#   {"passed":false}              -> app smoke FAILED          (red app_failed)
#   {"passed":false,"infra":true} -> setup/toolchain problem   (neutral, NOT red)
#
# The infra/app split is by CAUSE, not by which step ran:
#   - Toolchain/registry setup (apt update/install of xvfb/tmux, npm install of
#     @playwright/test) failing = infra (neutral): a Daytona/registry outage, not
#     the release build's fault.
#   - The RELEASE PACKAGE itself failing (a .deb that cannot install or does not
#     contain a runnable app binary) = app_failed (RED). A broken/uninstallable
#     package is the product result covered by INS-001, not infra.
#   - The Playwright app-test run's pass/fail = app result.
#
# Toolchain (xvfb, tmux, @playwright/test) is installed only if ABSENT, so a
# prebuilt sandbox image with these baked in runs fully egress-free. On a stock
# image they are fetched from the OS/npm registries at boot — the one remaining
# egress. Acceptable for the STABLE gate (trusted signed build); the per-PR /
# untrusted gate MUST run on a prebuilt image so no install-time egress happens.
# TODO: bake xvfb/tmux/@playwright/test into the Daytona snapshot.
set -o pipefail
cd /home/daytona
DEB="${AO_DEB_PATH:-/home/daytona/app.deb}"
# Optional tag filter (e.g. AO_SUITE=T0 -> playwright --grep @T0). Empty = all.
SUITE="${AO_SUITE:-}"

# Emit an INFRA verdict and stop. Setup/toolchain problems are NOT the release
# build's fault — the runner maps infra:true to a NEUTRAL gate result, never red.
fail_infra() {
	echo "== INFRA FAILURE ($1): $2 =="
	echo "AO_VERDICT {\"passed\":false,\"infra\":true,\"stage\":\"$1\",\"reason\":\"$2\"}"
	exit 0
}

# Emit an APP_FAILED verdict and stop. The release PACKAGE is bad (won't install
# or ships no runnable binary) — a real release-build failure, mapped to RED.
fail_app() {
	echo "== APP FAILURE ($1): $2 =="
	echo "AO_VERDICT {\"passed\":false,\"suite\":\"real-app-t0\",\"stage\":\"$1\",\"reason\":\"$2\"}"
	exit 0
}

echo "== deps: xvfb, tmux (install only if absent) =="
if ! command -v xvfb-run >/dev/null 2>&1 || ! command -v tmux >/dev/null 2>&1; then
	sudo apt-get update -qq >/dev/null 2>&1 || fail_infra "apt-update" "apt-get update failed (registry/network)"
	sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb tmux >/dev/null 2>&1 ||
		fail_infra "apt-install" "installing xvfb/tmux failed (registry/network)"
fi
command -v xvfb-run >/dev/null 2>&1 || fail_infra "xvfb-missing" "xvfb-run unavailable after install"

echo "== install release build: $DEB =="
# Guard against a STALE binary masquerading as a fresh install: drop any
# pre-existing agent-orchestrator so the ONLY binary that can satisfy the check
# below is one THIS .deb installs. Trusting `command -v` alone would let a broken
# package pass against a leftover binary on PATH.
if command -v agent-orchestrator >/dev/null 2>&1; then
	sudo rm -f "$(command -v agent-orchestrator)" 2>/dev/null || true
fi
sudo rm -f /usr/lib/agent-orchestrator/agent-orchestrator 2>/dev/null || true

# dpkg -i unpacks the package's files; runtime-dependency *configuration* may be
# deferred to apt-get -f below (dpkg then exits non-zero with "dependency
# problems"). But a dpkg failure that is NOT a mere dependency deferral (corrupt
# archive, wrong architecture, unpack or maintainer-script error) means the
# RELEASE PACKAGE itself is broken -> app_failed (RED, INS-001), not infra.
dpkg_out="$(sudo dpkg -i "$DEB" 2>&1)"
dpkg_rc=$?
echo "$dpkg_out"
if [ "$dpkg_rc" != 0 ] && ! printf '%s' "$dpkg_out" | grep -qiE 'dependency problems'; then
	fail_app "package-install" "dpkg -i could not unpack/install the release .deb (rc=$dpkg_rc)"
fi

# Resolve the deferred runtime deps. A failure here has TWO distinct causes that
# must NOT be conflated:
#   - the apt registry/network is unreachable (fetch/resolve/connect errors) =
#     INFRA (neutral): a Daytona/registry outage, not the build's fault.
#   - the package's declared deps are genuinely unsatisfiable = app_failed (RED):
#     a real problem with the release .deb.
apt_out="$(sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -f -qq 2>&1)"
apt_rc=$?
echo "$apt_out"
if [ "$apt_rc" != 0 ]; then
	if printf '%s' "$apt_out" | grep -qiE 'could not resolve|failed to fetch|temporary failure|unable to connect|could not connect|network is unreachable|connection timed out|cannot initiate the connection'; then
		fail_infra "apt-install-fix" "apt-get -f install could not reach the registry/network"
	fi
	fail_app "package-deps" "release .deb declares dependencies that cannot be satisfied (apt-get -f rc=$apt_rc)"
fi

# Authoritative install check: the package must be registered as installed AND
# must OWN the resolved binary (dpkg -s / dpkg -L) — not merely resolve to some
# binary on PATH. This is what makes a stale/foreign binary unable to green a
# broken package.
if ! dpkg -s agent-orchestrator >/dev/null 2>&1; then
	fail_app "package-install" "agent-orchestrator is not registered as installed after dpkg/apt (dpkg rc=$dpkg_rc)"
fi
APP="$(command -v agent-orchestrator || echo /usr/lib/agent-orchestrator/agent-orchestrator)"
if [ ! -x "$APP" ]; then
	fail_app "package-install" "release .deb installed no runnable app binary (dpkg rc=$dpkg_rc, path=$APP)"
fi
# Confirm the resolved binary is a file the package owns (following symlinks).
APP_REAL="$(readlink -f "$APP" 2>/dev/null || echo "$APP")"
if ! dpkg -L agent-orchestrator 2>/dev/null | grep -qxF "$APP" &&
	! dpkg -L agent-orchestrator 2>/dev/null | grep -qxF "$APP_REAL"; then
	fail_app "package-install" "resolved binary $APP is not owned by the agent-orchestrator package (stale/foreign binary)"
fi
echo "app: $APP (dpkg rc=$dpkg_rc)"

echo "== playwright lib (install only if absent; uses the app's own electron) =="
if [ ! -x node_modules/.bin/playwright ]; then
	[ -f package.json ] || npm init -y >/dev/null 2>&1
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i -D @playwright/test >/dev/null 2>&1 ||
		fail_infra "npm-playwright" "installing @playwright/test failed (npm registry)"
fi
[ -x node_modules/.bin/playwright ] || fail_infra "playwright-missing" "playwright unavailable after install"

echo "== real-app e2e under xvfb${SUITE:+ (suite @$SUITE)} =="
# From here PW is the REAL app-test result: 0 = app passed, non-zero = app failed.
# Setup is done and the package installed a runnable binary; only the app under
# test decides pass/fail now.
export AO_APP_BIN="$APP"
xvfb-run -a npx playwright test -c playwright.electron.config.ts ${SUITE:+--grep "@$SUITE"} 2>&1
PW=$?

# Bundle the Playwright results (json report + any traces/screenshots) so the
# runner can download them before teardown and attach them to the check. Best-
# effort: if nothing was produced, the runner still keeps the full pod log.
tar czf /home/daytona/artifacts.tgz -C /home/daytona test-results playwright-report 2>/dev/null || true

if [ "$PW" = 0 ]; then
	echo "AO_VERDICT {\"passed\":true,\"suite\":\"real-app-t0\"${SUITE:+,\"grep\":\"@$SUITE\"}}"
else
	echo "AO_VERDICT {\"passed\":false,\"suite\":\"real-app-t0\",\"playwright_exit\":$PW}"
fi
