#!/usr/bin/env bash
#
# test-onboarding.sh — End-to-end onboarding test for a PUBLISHED @aoagents/ao.
#
# Installs the published npm package into a throwaway prefix, runs `ao start`
# against a sandboxed HOME/config, verifies the dashboard serves, then runs
# `ao stop` — all FULLY ISOLATED from any real ao install/runtime on the box.
#
# Two modes:
#   --mode fresh    Canonical clean onboarding (clean CI / new machine).
#   --mode coexist  Machine already runs ao. Proves ZERO change to the real
#                   install: snapshots real running.json + tmux + listening
#                   ports BEFORE/AFTER and fails loudly if anything moved.
#
# Isolation guarantees (all enforced by this script):
#   - npm install -g into a TEMP --prefix; never touches real global modules.
#   - Sandbox HOME (temp) so ~/.agent-orchestrator is fully separate; the
#     sandbox `ao stop` only ever sees the sandbox running.json.
#   - Auto-allocated free dashboard + terminal WS ports (never 3001/14801).
#   - runtime: process (no shared tmux server) so the test cannot see/kill
#     real tmux sessions. (tmux equivalent — see SKILL.md.)
#   - Throwaway git repo to onboard.
#   - Non-interactive: AO_CALLER_TYPE=agent + --no-orchestrator.
#   - Everything under ONE temp root, auto-removed on EXIT (trap).
#
# Usage:
#   scripts/test-onboarding.sh [--version <latest|nightly|EXACT>] \
#                              [--registry <url>] \
#                              [--mode <fresh|coexist>] \
#                              [--port <N>] [--keep] [-h|--help]
#
# Testing a BRANCH instead of a release:
#   The grok-style packaging bugs this harness catches only exist in the
#   PUBLISHED tarball, so a branch must be *published* somewhere first — a
#   source build does not reproduce them. Two faithful routes:
#     1. Merged to main: a per-commit nightly is auto-published. Run
#          --version 0.x.y-nightly-<sha>     (see: npm view @aoagents/ao versions)
#        to test that exact commit's real packaged artifact — no setup.
#     2. Unmerged PR branch: publish it to a throwaway local registry
#        (verdaccio) and point the harness there:
#          npx verdaccio &   # http://localhost:4873
#          pnpm -r publish --registry http://localhost:4873 --no-git-checks
#          scripts/test-onboarding.sh --registry http://localhost:4873 --version <ver>
#
# Exit code 0 = pass, non-zero = fail.

set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
VERSION="latest"
MODE="fresh"
FIXED_PORT=""
KEEP=0
REGISTRY=""

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed 's/^#\{0,1\} \{0,1\}//; /^set -euo/d'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --mode) MODE="${2:?--mode needs a value}"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --port) FIXED_PORT="${2:?--port needs a value}"; shift 2 ;;
    --port=*) FIXED_PORT="${1#*=}"; shift ;;
    --registry) REGISTRY="${2:?--registry needs a value}"; shift 2 ;;
    --registry=*) REGISTRY="${1#*=}"; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
done

case "$MODE" in
  fresh|coexist) ;;
  *) echo "Invalid --mode: $MODE (want fresh|coexist)" >&2; exit 2 ;;
esac

# Map version aliases to an npm spec (latest/nightly are dist-tags).
PKG_SPEC="@aoagents/ao@${VERSION}"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; NC=""
fi
step() { echo "${BLUE}▶ $*${NC}"; }
ok()   { echo "${GREEN}✓ $*${NC}"; }
warn() { echo "${YELLOW}! $*${NC}"; }
die()  { echo "${RED}✗ $*${NC}" >&2; exit 1; }

# Portable timeout: GNU `timeout` (Linux) or `gtimeout` (macOS+coreutils);
# falls back to running without a wall-clock cap when neither exists.
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"; fi
run_timeout() { # secs cmd...
  local secs="$1"; shift
  if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$secs" "$@"; else "$@"; fi
}

# ---------------------------------------------------------------------------
# Capture the REAL environment BEFORE we sandbox anything.
# ---------------------------------------------------------------------------
REAL_HOME="$HOME"
REAL_AO_DIR="$REAL_HOME/.agent-orchestrator"
REAL_RUNNING_JSON="$REAL_AO_DIR/running.json"

# ---------------------------------------------------------------------------
# Sandbox layout — ONE temp root for trivial cleanup.
# ---------------------------------------------------------------------------
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ao-onboarding.XXXXXX")"
SANDBOX_HOME="$ROOT/home"
NPM_PREFIX="$ROOT/npm-prefix"
REPO="$ROOT/repo"
GLOBAL_CONFIG="$ROOT/global-agent-orchestrator.yaml"
START_LOG="$ROOT/ao-start.log"
mkdir -p "$SANDBOX_HOME" "$NPM_PREFIX" "$REPO"

START_PID=""

# ---------------------------------------------------------------------------
# Cleanup: runs on success, failure, and interrupt. Leaves machine as found.
# ---------------------------------------------------------------------------
cleanup() {
  local ec=$?
  set +e
  echo
  step "Cleanup"
  # 1. Graceful sandbox stop (only sees the sandbox running.json via HOME).
  if [ -x "$NPM_PREFIX/bin/ao" ]; then
    HOME="$SANDBOX_HOME" PATH="$NPM_PREFIX/bin:$PATH" \
      AO_CALLER_TYPE=agent AO_GLOBAL_CONFIG="$GLOBAL_CONFIG" AO_CONFIG_PATH="$GLOBAL_CONFIG" \
      run_timeout 30 ao stop --all >/dev/null 2>&1 || true
  fi
  # 2. Kill the recorded daemon pid tree, if still alive.
  if [ -n "$START_PID" ] && kill -0 "$START_PID" 2>/dev/null; then
    pkill -P "$START_PID" 2>/dev/null || true
    kill "$START_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$START_PID" 2>/dev/null || true
  fi
  # 3. Safety net: reap any orphan process whose args reference our unique
  #    temp root. This path is unique to this run — cannot match real ao.
  pkill -f "$ROOT" 2>/dev/null || true
  # 4. Remove the single temp root.
  if [ "$KEEP" -eq 1 ]; then
    warn "--keep set; leaving sandbox at $ROOT"
  else
    rm -rf "$ROOT" 2>/dev/null || true
    ok "Removed sandbox $ROOT"
  fi
  exit "$ec"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Free-port allocator (asks the kernel for an ephemeral port via node).
# ---------------------------------------------------------------------------
free_port() {
  node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p));});'
}

# Snapshot helpers (coexist mode). All read-only — never mutate real state.
snapshot_real() {
  local out="$1"
  {
    echo "## running.json"
    if [ -f "$REAL_RUNNING_JSON" ]; then cat "$REAL_RUNNING_JSON"; else echo "(absent)"; fi
    echo
    echo "## tmux sessions"
    tmux ls 2>/dev/null | sort || echo "(no tmux server)"
    echo
    echo "## listening tcp ports"
    if command -v lsof >/dev/null 2>&1; then
      lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '{print $1, $9}' | sort -u
    else
      echo "(lsof unavailable)"
    fi
  } > "$out"
}

# ---------------------------------------------------------------------------
echo "${BLUE}══════════════════════════════════════════════════════════${NC}"
echo "${BLUE}  AO published-package onboarding test${NC}"
echo "${BLUE}  package=${PKG_SPEC}  mode=${MODE}${NC}"
echo "${BLUE}  sandbox=${ROOT}${NC}"
echo "${BLUE}══════════════════════════════════════════════════════════${NC}"

command -v node >/dev/null 2>&1 || die "node is required"
command -v npm  >/dev/null 2>&1 || die "npm is required"
command -v git  >/dev/null 2>&1 || die "git is required"
command -v curl >/dev/null 2>&1 || die "curl is required"

# coexist: snapshot BEFORE.
BEFORE="$ROOT/real-before.txt"
AFTER="$ROOT/real-after.txt"
if [ "$MODE" = "coexist" ]; then
  step "coexist: snapshotting real ao state (before)"
  snapshot_real "$BEFORE"
  if [ -f "$REAL_RUNNING_JSON" ]; then
    ok "Real ao appears to be running (running.json present) — good, we will prove it is untouched"
  else
    warn "No real running.json found — coexist still verifies nothing changes"
  fi
fi

# ---------------------------------------------------------------------------
# Allocate ports (dashboard + 2 terminal WS). Never 3001 / 14800 / 14801.
# ---------------------------------------------------------------------------
step "Allocating free ports"
if [ -n "$FIXED_PORT" ]; then
  PORT="$FIXED_PORT"
else
  PORT="$(free_port)"
fi
TERM_PORT="$(free_port)"
DIRECT_TERM_PORT="$(free_port)"
for p in "$PORT" "$TERM_PORT" "$DIRECT_TERM_PORT"; do
  case "$p" in
    3001|14800|14801) die "Refusing reserved port $p" ;;
  esac
done
ok "dashboard=$PORT terminal=$TERM_PORT directTerminal=$DIRECT_TERM_PORT"

# ---------------------------------------------------------------------------
# Install the package into the temp prefix.
# Default registry = npmjs. --registry points at a throwaway local registry
# (verdaccio) so an unmerged branch can be tested with full packaging fidelity.
# ---------------------------------------------------------------------------
REGISTRY_ARGS=()
if [ -n "$REGISTRY" ]; then
  REGISTRY_ARGS=(--registry "$REGISTRY")
  step "Installing $PKG_SPEC from $REGISTRY into temp prefix"
else
  step "Installing $PKG_SPEC into temp prefix"
fi
npm install -g --prefix "$NPM_PREFIX" ${REGISTRY_ARGS[@]+"${REGISTRY_ARGS[@]}"} "$PKG_SPEC" >"$ROOT/npm-install.log" 2>&1 \
  || { cat "$ROOT/npm-install.log" >&2; die "npm install failed"; }
[ -x "$NPM_PREFIX/bin/ao" ] || die "ao binary not found in temp prefix after install"
ok "Installed"

# Sandbox env used for ALL ao invocations from here on.
export HOME="$SANDBOX_HOME"
export PATH="$NPM_PREFIX/bin:$PATH"
export AO_CALLER_TYPE=agent
export AO_GLOBAL_CONFIG="$GLOBAL_CONFIG"
export AO_CONFIG_PATH="$GLOBAL_CONFIG"
export PORT="$PORT"
export TERMINAL_PORT="$TERM_PORT"
export DIRECT_TERMINAL_PORT="$DIRECT_TERM_PORT"

step "Verifying ao binary resolves to the sandbox"
RESOLVED="$(command -v ao)"
case "$RESOLVED" in
  "$NPM_PREFIX"/*) ok "ao -> $RESOLVED" ;;
  *) die "ao resolved to $RESOLVED (expected under $NPM_PREFIX)" ;;
esac
ao --version || die "ao --version failed"

# ---------------------------------------------------------------------------
# Throwaway git repo + sandbox global config.
# ---------------------------------------------------------------------------
step "Creating throwaway git repo"
git -C "$REPO" init -q
git -C "$REPO" config user.email "onboarding@example.com"
git -C "$REPO" config user.name "Onboarding Test"
git -C "$REPO" config commit.gpgsign false
echo "# onboarding test repo" > "$REPO/README.md"
git -C "$REPO" add .
git -C "$REPO" commit -qm "initial commit"
ok "Repo at $REPO"

step "Writing sandbox global config"
cat > "$GLOBAL_CONFIG" <<EOF
port: $PORT
terminalPort: $TERM_PORT
directTerminalPort: $DIRECT_TERM_PORT
defaults:
  runtime: process
  agent: claude-code
  workspace: worktree
  notifiers: []
projects:
  onboarding:
    name: Onboarding Test
    path: $REPO
    defaultBranch: main
    sessionPrefix: onb
    runtime: process
EOF
ok "Config at $GLOBAL_CONFIG"

# ---------------------------------------------------------------------------
# Start the sandbox daemon (dashboard only, no orchestrator agent).
# ---------------------------------------------------------------------------
step "Starting ao (dashboard only, no orchestrator)"
( cd "$REPO" && ao start --no-orchestrator >"$START_LOG" 2>&1 ) &
START_PID=$!
ok "ao start launched (wrapper pid $START_PID)"

# Wait for running.json to appear in the SANDBOX home.
SANDBOX_RUNNING="$SANDBOX_HOME/.agent-orchestrator/running.json"
step "Waiting for sandbox running.json"
RUNNING_PID=""
for _ in $(seq 1 100); do
  if [ -f "$SANDBOX_RUNNING" ]; then
    RUNNING_PID="$(node -e 'const j=require(process.argv[1]);process.stdout.write(String(j.pid||""))' "$SANDBOX_RUNNING" 2>/dev/null || true)"
    [ -n "$RUNNING_PID" ] && break
  fi
  kill -0 "$START_PID" 2>/dev/null || { cat "$START_LOG" >&2; die "ao start exited early"; }
  sleep 0.3
done
[ -n "$RUNNING_PID" ] || { cat "$START_LOG" >&2; die "running.json never appeared"; }
ok "running.json registered pid $RUNNING_PID on port $PORT"

# Wait for the dashboard to serve.
step "Waiting for dashboard on http://127.0.0.1:$PORT"
DASH_OK=0
for _ in $(seq 1 100); do
  if curl -sf "http://127.0.0.1:$PORT/api/sessions" >/dev/null 2>&1; then
    DASH_OK=1; break
  fi
  kill -0 "$START_PID" 2>/dev/null || { cat "$START_LOG" >&2; die "ao start exited before dashboard came up"; }
  sleep 0.5
done
[ "$DASH_OK" -eq 1 ] || { tail -n 40 "$START_LOG" >&2; die "dashboard did not respond on port $PORT"; }
ok "Dashboard responding (/api/sessions 200)"

# Confirm the served port is the sandbox port (and NOT 3001).
curl -sf "http://127.0.0.1:3001/api/sessions" >/dev/null 2>&1 \
  && warn "port 3001 also responds (the REAL ao) — expected in coexist mode" \
  || true

# ---------------------------------------------------------------------------
# Stop the sandbox daemon — must operate ONLY on the sandbox.
# ---------------------------------------------------------------------------
step "Stopping sandbox ao (ao stop --all)"
( cd "$REPO" && run_timeout 40 ao stop --all ) || die "ao stop --all failed/timed out"

step "Verifying clean shutdown"
for _ in $(seq 1 40); do
  kill -0 "$RUNNING_PID" 2>/dev/null || break
  sleep 0.5
done
kill -0 "$RUNNING_PID" 2>/dev/null && die "daemon pid $RUNNING_PID still alive after stop"
[ -f "$SANDBOX_RUNNING" ] && die "sandbox running.json still present after stop"
curl -sf "http://127.0.0.1:$PORT/api/sessions" >/dev/null 2>&1 \
  && die "dashboard still serving on $PORT after stop" || true
ok "Sandbox daemon stopped, running.json cleared, port released"

# ---------------------------------------------------------------------------
# coexist: prove the real ao is untouched.
# ---------------------------------------------------------------------------
if [ "$MODE" = "coexist" ]; then
  step "coexist: snapshotting real ao state (after) and diffing"
  snapshot_real "$AFTER"
  if diff -u "$BEFORE" "$AFTER" > "$ROOT/real-diff.txt"; then
    ok "Real ao state IDENTICAL before/after (running.json, tmux, ports)"
  else
    echo "${RED}Real ao state CHANGED — isolation breach:${NC}" >&2
    cat "$ROOT/real-diff.txt" >&2
    die "coexist invariant violated"
  fi
fi

echo
echo "${GREEN}══════════════════════════════════════════════════════════${NC}"
echo "${GREEN}  PASS — onboarding works for ${PKG_SPEC} (mode=${MODE})${NC}"
echo "${GREEN}══════════════════════════════════════════════════════════${NC}"
exit 0
