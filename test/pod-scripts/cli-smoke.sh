#!/usr/bin/env bash
#
# Packaged CLI smoke test (P0 group 2 of AgentWrapper/agent-orchestrator#2483).
#
# Runs inside the test pod AFTER the desktop app has been installed and launched
# (the desktop app is what starts the daemon; the CLI must attach to THAT daemon,
# it does not start its own). This asserts the packaged `ao` binary is usable and
# talks to the app's daemon:
#
#   1. `ao version`  prints a version and exits 0
#   2. `ao status`   reports the daemon and exits 0 while the daemon is up
#   3. `ao doctor`   runs local health checks and exits 0
#   4. the CLI is looking at the SAME daemon the desktop app launched
#      (the port `ao status` reports matches the expected AO_PORT when the pod
#      pins one; otherwise we just assert status agrees the daemon is ready)
#
# It is deliberately tolerant of startup timing: the daemon may need a moment
# after the app launches, so `ao status` is polled until ready (or a deadline).
#
# Output contract: prints a final machine-readable line
#   CLI_SMOKE {"passed":true|false,...}
# and exits 0 when passed, 1 otherwise. The pod harness greps for that line the
# same way the e2e gate greps for AO_VERDICT.
#
# Invocation in the pod (after app install + launch):
#   AO_BIN=/opt/ao/ao AO_PORT=4477 bash test/pod-scripts/cli-smoke.sh
# or simply, if `ao` is on PATH and the app pinned the daemon port itself:
#   bash test/pod-scripts/cli-smoke.sh

set -uo pipefail

# ----- config ---------------------------------------------------------------
AO_BIN="${AO_BIN:-ao}"
# How long to wait for the app's daemon to come up, in seconds.
READY_TIMEOUT="${CLI_SMOKE_READY_TIMEOUT:-60}"
# Poll interval, in seconds.
POLL_INTERVAL="${CLI_SMOKE_POLL_INTERVAL:-2}"
# Optional: the port the desktop app was told to run the daemon on. When set, we
# assert `ao status` reports the very same port (proves same-daemon attach).
EXPECTED_PORT="${AO_PORT:-}"

# ----- result accumulation --------------------------------------------------
version_out=""
status_port=""
status_state=""
declare -a failures=()

record_fail() {
  failures+=("$1")
  echo "FAIL: $1" >&2
}

# JSON-escape a string for embedding in the CLI_SMOKE line.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"
  s="${s//$'\t'/ }"
  printf '%s' "$s"
}

emit_and_exit() {
  local passed="$1"
  local reason
  if [ "${#failures[@]}" -eq 0 ]; then
    reason=""
  else
    reason="$(printf '%s; ' "${failures[@]}")"
    reason="${reason%; }"
  fi
  printf 'CLI_SMOKE {"passed":%s,"version":"%s","daemonState":"%s","port":"%s","expectedPort":"%s","reason":"%s"}\n' \
    "$passed" \
    "$(json_escape "$version_out")" \
    "$(json_escape "$status_state")" \
    "$(json_escape "$status_port")" \
    "$(json_escape "$EXPECTED_PORT")" \
    "$(json_escape "$reason")"
  if [ "$passed" = "true" ]; then
    exit 0
  fi
  exit 1
}

# ----- 0. binary present -----------------------------------------------------
bin_path="$(command -v "$AO_BIN" 2>/dev/null || true)"
if [ -z "$bin_path" ]; then
  record_fail "ao binary not found on PATH (AO_BIN=$AO_BIN)"
  emit_and_exit false
fi
echo "ao binary : $bin_path"

# ----- 1. ao version ---------------------------------------------------------
if version_out="$("$AO_BIN" version 2>&1)"; then
  version_out="$(printf '%s' "$version_out" | head -n1)"
  if [ -z "$version_out" ]; then
    record_fail "ao version printed nothing"
  else
    echo "ao version: $version_out"
  fi
else
  record_fail "ao version exited non-zero"
  version_out=""
fi

# ----- 2. ao status (polled until the app's daemon is ready) -----------------
# The desktop app launches the daemon asynchronously; poll rather than assume it
# is already up. We accept the daemon as "ready" when `ao status` exits 0 and
# reports a ready/running state. Prefer JSON output when supported, fall back to
# parsing the human text form.
deadline=$(( $(date +%s) + READY_TIMEOUT ))
status_ok=false
last_status_out=""
while :; do
  if status_json="$("$AO_BIN" status --json 2>/dev/null)"; then
    last_status_out="$status_json"
    # Extract "state" and "port" from the JSON without needing jq.
    parsed_state="$(printf '%s' "$status_json" | grep -oE '"state"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')"
    parsed_port="$(printf '%s' "$status_json" | grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' | head -n1 | grep -oE '[0-9]+')"
  else
    # Fall back to the human-readable form: "AO daemon: <state>" and "port: N".
    last_status_out="$("$AO_BIN" status 2>&1 || true)"
    parsed_state="$(printf '%s' "$last_status_out" | grep -iE 'AO daemon:' | head -n1 | sed -E 's/.*AO daemon:[[:space:]]*([A-Za-z_]+).*/\1/')"
    parsed_port="$(printf '%s' "$last_status_out" | grep -iE '^[[:space:]]*port:' | head -n1 | grep -oE '[0-9]+')"
  fi

  status_state="$parsed_state"
  status_port="$parsed_port"

  # Ready when status exits 0 (checked below) and state looks live.
  if "$AO_BIN" status >/dev/null 2>&1; then
    case "$status_state" in
      ready|running|Ready|Running|ok)
        status_ok=true
        break
        ;;
    esac
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    break
  fi
  echo "waiting for app daemon (state=${status_state:-unknown}) ..."
  sleep "$POLL_INTERVAL"
done

echo "ao status : state=${status_state:-unknown} port=${status_port:-unknown}"
if [ "$status_ok" != "true" ]; then
  record_fail "ao status did not report a ready daemon within ${READY_TIMEOUT}s (last: ${last_status_out:-none})"
fi

# ----- 3. ao doctor ----------------------------------------------------------
if "$AO_BIN" doctor >/dev/null 2>&1; then
  echo "ao doctor : OK"
else
  record_fail "ao doctor exited non-zero"
fi

# ----- 4. CLI attached to the daemon the desktop app launched ----------------
# When the pod pins the app's daemon port via AO_PORT, the CLI must report that
# exact port — proof it connected to the app's daemon and not some other one. If
# no port was pinned, a ready daemon with a reported port is the best signal we
# have.
if [ "$status_ok" = "true" ]; then
  if [ -n "$EXPECTED_PORT" ]; then
    if [ "$status_port" = "$EXPECTED_PORT" ]; then
      echo "same-daemon: ao status port $status_port matches expected $EXPECTED_PORT"
    else
      record_fail "ao status port ($status_port) does not match the app daemon's expected port ($EXPECTED_PORT)"
    fi
  elif [ -z "$status_port" ]; then
    record_fail "ao status reported a ready daemon but no port; cannot confirm same-daemon attach"
  else
    echo "same-daemon: ao status sees daemon on port $status_port (no AO_PORT pinned to cross-check)"
  fi
fi

# ----- verdict ---------------------------------------------------------------
if [ "${#failures[@]}" -eq 0 ]; then
  echo "cli-smoke: OK"
  emit_and_exit true
fi
echo "cli-smoke: FAILED (${#failures[@]} check(s))" >&2
emit_and_exit false
