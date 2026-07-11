#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ops/deploy.sh [--rollback]

Deploy ao's self-hosted production target: the local user-level ao daemon.

Environment overrides:
  AO_DEPLOY_REPO_ROOT       repo checkout to deploy from (default: script parent)
  AO_DEPLOY_AO_BIN          ao binary path (default: ~/.local/bin/ao)
  AO_DEPLOY_SYSTEMD_USER_DIR systemd user unit dir (default: ~/.config/systemd/user)
  AO_DEPLOY_BASE            base git ref for changed-path detection
  AO_DEPLOY_HEAD            head git ref for changed-path detection (default: HEAD)
  AO_DEPLOY_GITHUB_REPO     GitHub repo owner/name for main CI verification
  AO_DEPLOY_WEB_URL         tailnet/public web URL to verify
  AO_DEPLOY_WAIT_SECONDS    ao restart + web readiness timeout (default: 30)
  AO_DEPLOY_DRY_RUN=1       print actions without changing the host
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="${AO_DEPLOY_REPO_ROOT:-$(cd "${script_dir}/.." && pwd -P)}"
ao_bin="${AO_DEPLOY_AO_BIN:-${HOME}/.local/bin/ao}"
ao_prev="${AO_DEPLOY_AO_PREV:-${ao_bin}.prev}"
systemd_user_dir="${AO_DEPLOY_SYSTEMD_USER_DIR:-${HOME}/.config/systemd/user}"
state_dir="${AO_DEPLOY_STATE_DIR:-${HOME}/.ao/deploy}"
state_file="${AO_DEPLOY_STATE_FILE:-${state_dir}/agent-orchestrator.last-deployed}"
# Durable, append-only record of every deploy: timestamp, source ref, and the
# built revision. The old ~/.ao/deploy-main.log went stale (last written by a
# since-deleted worktree) because nothing appended to it reliably; log() now
# tees here on every run so the log can never silently fall behind again.
deploy_log="${AO_DEPLOY_LOG:-${state_dir}/agent-orchestrator.deploy.log}"
deploy_log_warned=0
ao_unit="${AO_DEPLOY_AO_UNIT:-ao.service}"
web_unit="${AO_DEPLOY_WEB_UNIT:-ao-web.service}"
notifier_unit="${AO_DEPLOY_NOTIFIER_UNIT:-ao-slack-notifier.service}"
attention_reply_unit="${AO_DEPLOY_ATTENTION_REPLY_UNIT:-ao-attention-reply.service}"
wait_seconds="${AO_DEPLOY_WAIT_SECONDS:-30}"
ao_port="${AO_PORT:-3001}"
dry_run="${AO_DEPLOY_DRY_RUN:-0}"
rollback=false

while (($# > 0)); do
  case "$1" in
    --rollback)
      rollback=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

quote_cmd() {
  local quoted=()
  local arg
  for arg in "$@"; do
    quoted+=("$(printf '%q' "$arg")")
  done
  printf '%s' "${quoted[*]}"
}

log() {
  printf '%s\n' "$*"
  # Mirror every human-facing line into the durable deploy log with a UTC
  # timestamp. Best-effort (never abort the deploy if the log is unwritable),
  # but the common path always appends so source ref + revision + timestamps
  # land on disk. Skipped under dry-run so a rehearsal cannot pollute the log.
  if [[ "${dry_run}" != "1" ]]; then
    # A silently-failing audit log recreates the stale-log condition this log
    # exists to prevent, so surface the first write failure loudly on stderr
    # (once, to avoid spamming) rather than swallowing it. The deploy still
    # proceeds: the console output and commit-status markers remain the
    # authoritative record, and blocking a production deploy solely because a
    # log file is unwritable would be worse than a loud warning.
    if ! { mkdir -p "$(dirname "${deploy_log}")" 2>/dev/null &&
      printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "${deploy_log}" 2>/dev/null; }; then
      if [[ "${deploy_log_warned}" != "1" ]]; then
        printf 'WARNING: could not append to deploy log %s; deploy proceeding without a durable file record.\n' "${deploy_log}" >&2
        deploy_log_warned=1
      fi
    fi
  fi
}

run() {
  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: %s\n' "$(quote_cmd "$@")"
    return 0
  fi
  "$@"
}

run_in() {
  local dir="$1"
  shift
  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: cd %s && %s\n' "$(printf '%q' "${dir}")" "$(quote_cmd "$@")"
    return 0
  fi
  (cd "${dir}" && "$@")
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# binary_build_setting reads a single Go build setting (e.g. vcs.revision,
# vcs.modified) embedded in a compiled binary by the toolchain. Emits the value
# or an empty string when go is unavailable or the setting is absent (e.g. a
# binary built outside a VCS checkout). Never fails, so callers can compare
# against an empty string rather than being killed by `set -e`.
binary_build_setting() {
  local path="$1" key="$2"
  if ! command_exists go; then
    return 0
  fi
  # `grep` exits 1 when the setting is absent (e.g. a binary built with
  # -buildvcs=false), which under `set -o pipefail` would fail the pipeline
  # and, because callers assign the result under `set -e`, abort the whole
  # deploy instead of degrading to the intended empty-value warning. Force
  # the pipeline to succeed so a missing setting yields "" not a fatal error.
  go version -m "${path}" 2>/dev/null | grep -F "${key}=" | head -n1 | sed "s/.*${key}=//" || true
}

# daemon_reported_revision asks the running daemon which revision it was built
# from via /api/v1/version. Emits the revision or an empty string when the
# endpoint is unreachable or does not report one. Never fails.
daemon_reported_revision() {
  local url="http://127.0.0.1:${ao_port}/api/v1/version"
  local node_read='let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(b).revision||""))}catch{process.stdout.write("")}});'
  curl --silent --fail --max-time 5 "${url}" 2>/dev/null | node -e "${node_read}" 2>/dev/null || true
}

# warn_if_dirty loudly flags a binary built from a dirty working tree. A dirty
# build means the running revision does not fully describe the code on disk —
# exactly the "undetectable from any ao surface" trap this issue exists to close.
warn_if_dirty() {
  local path="$1" modified
  modified="$(binary_build_setting "${path}" vcs.modified)"
  if [[ "${modified}" == "true" ]]; then
    log ""
    log "WARNING: ao binary was built from a DIRTY working tree (vcs.modified=true)."
    log "WARNING: the running revision does not fully describe the code on disk."
    log "WARNING: commit or stash local changes before deploying to production."
    log ""
  fi
}

# verify_daemon_revision confirms the just-restarted daemon reports the same
# revision the deploy just built. A mismatch means the restart did not pick up
# the new binary (stale service, wrong path) and is a hard failure. An
# unreadable built revision or an unavailable /version endpoint degrades to a
# loud warning so the check never blocks a deploy on missing provenance data.
verify_daemon_revision() {
  local expected="$1"
  if [[ "${dry_run}" == "1" ]]; then
    log "DRY-RUN: would verify running daemon revision matches ${expected:-<unknown>}"
    return 0
  fi
  if [[ -z "${expected}" ]]; then
    log "WARNING: could not read built binary revision (go version -m); skipping revision-match verification."
    return 0
  fi
  local reported
  reported="$(daemon_reported_revision)"
  if [[ -z "${reported}" ]]; then
    log "WARNING: running daemon did not report a revision (/api/v1/version unavailable); cannot verify it matches built ${expected}."
    return 0
  fi
  if [[ "${reported}" != "${expected}" ]]; then
    printf 'Revision mismatch: built %s but running daemon reports %s\n' "${expected}" "${reported}" >&2
    return 1
  fi
  log "Running daemon revision matches built binary: ${reported}"
}

git_head() {
  git -C "${repo_root}" rev-parse "${AO_DEPLOY_HEAD:-HEAD}"
}

github_repo() {
  if [[ -n "${AO_DEPLOY_GITHUB_REPO:-}" ]]; then
    printf '%s\n' "${AO_DEPLOY_GITHUB_REPO}"
    return 0
  fi
  local url
  url="$(git -C "${repo_root}" remote get-url origin 2>/dev/null || true)"
  url="${url%.git}"
  url="${url#https://github.com/}"
  url="${url#git@github.com:}"
  if [[ "${url}" == */* ]]; then
    printf '%s\n' "${url}"
  fi
}

main_ci_report() {
  local repo="$1" sha="$2"
  gh api "repos/${repo}/commits/${sha}/check-runs?per_page=100" | node -e '
let body = "";
process.stdin.on("data", (chunk) => (body += chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(body || "{}");
  if (typeof parsed.state === "string") {
    const jobs = Array.isArray(parsed.failedJobs) ? parsed.failedJobs : [];
    console.log(`${parsed.state}\t${jobs.join(", ")}`);
    return;
  }
  const runs = Array.isArray(parsed.check_runs) ? parsed.check_runs : [];
  if (Number(parsed.total_count || 0) > runs.length) {
    console.log(`unknown\tcheck runs truncated at ${runs.length}/${parsed.total_count}`);
    return;
  }
  // Deploy verification is stricter than Slack paging: hard-red conclusions
  // are failures, while action_required/pending/empty results still block as
  // not-known-green without claiming a hard red.
  const bad = new Set(["failure", "cancelled", "timed_out"]);
  const failed = runs.filter((r) => String(r.status || "").toLowerCase() === "completed" && bad.has(String(r.conclusion || "").toLowerCase()));
  const pending = runs.filter((r) => String(r.status || "").toLowerCase() !== "completed" || String(r.conclusion || "").toLowerCase() === "action_required");
  if (failed.length) {
    console.log(`failure\t${failed.map((r) => r.name || r.check_suite?.app?.name || "unknown").join(", ")}`);
  } else if (pending.length) {
    console.log(`pending\t${pending.map((r) => r.name || "unknown").join(", ")}`);
  } else if (runs.length === 0) {
    console.log("unknown\tno check runs");
  } else {
    console.log("success\t");
  }
});
'
}

verify_main_ci_green() {
  local head="$1"
  if [[ "${dry_run}" == "1" ]]; then
    log "DRY-RUN: would verify main CI is green for ${head}"
    return 0
  fi
  local repo
  repo="$(github_repo)"
  if [[ -z "${repo}" ]]; then
    printf 'Refusing to deploy %s: cannot resolve GitHub repo for main CI verification\n' "${head}" >&2
    return 1
  fi
  if ! command_exists gh; then
    printf 'Refusing to deploy %s: gh is required for main CI verification\n' "${head}" >&2
    return 1
  fi
  local report state jobs
  report="$(main_ci_report "${repo}" "${head}")"
  state="${report%%$'\t'*}"
  jobs="${report#*$'\t'}"
  case "${state}" in
    success)
      log "Main CI is green for ${head}."
      ;;
    failure|error|cancelled|timed_out|action_required)
      printf 'Refusing to deploy %s: main CI is %s: %s\n' "${head}" "${state}" "${jobs:-unknown jobs}" >&2
      return 1
      ;;
    *)
      printf 'Refusing to deploy %s: main CI is not green (%s: %s)\n' "${head}" "${state:-unknown}" "${jobs:-unknown jobs}" >&2
      return 1
      ;;
  esac
}

default_base_ref() {
  if [[ -n "${AO_DEPLOY_BASE:-}" ]]; then
    printf '%s\n' "${AO_DEPLOY_BASE}"
    return 0
  fi
  if [[ -s "${state_file}" ]]; then
    cat "${state_file}"
    return 0
  fi
  if git -C "${repo_root}" rev-parse --verify --quiet HEAD^ >/dev/null; then
    git -C "${repo_root}" rev-parse HEAD^
    return 0
  fi
  return 1
}

changed_in_range() {
  local base="$1"
  local head="$2"
  local pathspec="$3"

  if [[ -z "${base}" ]]; then
    return 0
  fi
  if ! git -C "${repo_root}" rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
    log "Base ref ${base} is not available; treating ${pathspec} as changed."
    return 0
  fi
  if ! git -C "${repo_root}" rev-parse --verify --quiet "${head}^{commit}" >/dev/null; then
    log "Head ref ${head} is not available; treating ${pathspec} as changed."
    return 0
  fi

  git -C "${repo_root}" diff --name-only "${base}" "${head}" -- "${pathspec}" | grep -q .
}

install_frontend_dependencies() {
  if [[ ! -f "${repo_root}/frontend/package-lock.json" ]]; then
    printf 'Refusing to install frontend dependencies: %s is missing; this deploy expects npm lockfile management.\n' "${repo_root}/frontend/package-lock.json" >&2
    return 1
  fi
  log "frontend package metadata changed; installing dependencies with npm ci."
  if ! run_in "${repo_root}/frontend" npm ci; then
    printf 'Frontend dependency install failed; aborting deploy before restarting %s.\n' "${web_unit}" >&2
    return 1
  fi
}

session_count() {
  ao session ls --json | node -e '
let body = "";
process.stdin.on("data", (chunk) => (body += chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(body);
  const sessions = Array.isArray(parsed) ? parsed : parsed.data;
  console.log(Array.isArray(sessions) ? sessions.length : 0);
});
'
}

wait_for_ao_ready() {
  if [[ "${dry_run}" == "1" ]]; then
    run ao status
    return 0
  fi

  local start now output
  start="$(date +%s)"
  while true; do
    if output="$(ao status 2>&1)" && grep -q 'AO daemon: ready' <<<"${output}"; then
      log "${output}"
      return 0
    fi
    now="$(date +%s)"
    if (( now - start >= wait_seconds )); then
      printf 'ao did not become ready within %ss\nLast status:\n%s\n' "${wait_seconds}" "${output:-<none>}" >&2
      return 1
    fi
    sleep 1
  done
}

verify_ao_doctor() {
  if [[ "${dry_run}" == "1" ]]; then
    run ao doctor
    return 0
  fi

  local output
  output="$(ao doctor 2>&1)"
  printf '%s\n' "${output}"
  if grep -q '^FAIL ' <<<"${output}"; then
    printf 'ao doctor reported failures\n' >&2
    return 1
  fi
}

verify_projects_api() {
  local url="http://127.0.0.1:${ao_port}/api/v1/projects"
  if [[ "${dry_run}" == "1" ]]; then
    run curl --fail --silent --show-error --output /dev/null "${url}"
    return 0
  fi

  local status
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' "${url}")"
  if [[ "${status}" != "200" ]]; then
    printf '%s returned HTTP %s, expected 200\n' "${url}" "${status}" >&2
    return 1
  fi
  log "${url} returned HTTP 200"
}

systemd_environment_value() {
  local key="$1"
  if ! command_exists systemctl; then
    return 1
  fi
  systemctl --user show "${web_unit}" --property=Environment --value 2>/dev/null |
    tr ' ' '\n' |
    sed -n "s/^${key}=//p" |
    tail -n 1
}

web_verify_url() {
  if [[ -n "${AO_DEPLOY_WEB_URL:-}" ]]; then
    printf '%s\n' "${AO_DEPLOY_WEB_URL}"
    return 0
  fi
  if [[ -n "${AO_WEB_PUBLIC_URL:-}" ]]; then
    printf '%s\n' "${AO_WEB_PUBLIC_URL}"
    return 0
  fi
  systemd_environment_value AO_WEB_PUBLIC_URL || true
}

# Emits the HTTP status of $1, or 000 when no response was received at all
# (connection refused, DNS failure, stalled response). Never fails, so `set -e`
# cannot kill the caller before it reports which URL was unreachable. $2 caps
# the whole request: a host that accepts the connection and then stalls would
# otherwise block forever and the caller's retry budget would never be checked.
web_url_status() {
  local status
  status="$(curl --location --silent --connect-timeout 5 --max-time "$2" --output /dev/null --write-out '%{http_code}' "$1" 2>/dev/null)" || true
  printf '%s' "${status:-000}"
}

# Statuses ao-web.service can serve while it is still coming up: no response
# yet (000, connection refused / stalled) or tailscale serve proxying to a
# backend that has not bound its port (502/503/504). Anything else — 401, 403,
# 404, 500 — is a real fault that retrying cannot clear.
web_status_is_transient() {
  case "$1" in
    000 | 502 | 503 | 504) return 0 ;;
    *) return 1 ;;
  esac
}

verify_tailnet_web() {
  local url
  url="$(web_verify_url)"
  if [[ -z "${url}" ]]; then
    log "No AO_DEPLOY_WEB_URL/AO_WEB_PUBLIC_URL found; skipping tailnet web HTTP verification."
    return 0
  fi
  if [[ "${dry_run}" == "1" ]]; then
    run curl --fail --silent --show-error --output /dev/null "${url}"
    return 0
  fi

  # ao-web.service's ExecStartPre rebuilds the web bundle and the node server
  # then needs a moment to bind, so the URL serves 502 (or refuses the
  # connection) for a few seconds after a restart. Retry on the same budget as
  # the daemon readiness loop rather than treating the transient as a failure.
  local start now status remaining
  start="$(date +%s)"
  while true; do
    now="$(date +%s)"
    # Cap each probe by what is left of the budget, so the loop honours
    # wait_seconds even against a host that stalls mid-response. curl treats
    # --max-time 0 as "no limit", hence the floor of 1.
    remaining=$(( wait_seconds - (now - start) ))
    (( remaining < 1 )) && remaining=1

    status="$(web_url_status "${url}" "${remaining}")"
    if [[ "${status}" == "200" ]]; then
      log "${url} returned HTTP 200"
      return 0
    fi
    if ! web_status_is_transient "${status}"; then
      printf '%s returned HTTP %s, expected 200 (not a restart transient; not retrying)\n' "${url}" "${status}" >&2
      return 1
    fi
    now="$(date +%s)"
    if (( now - start >= wait_seconds )); then
      printf '%s returned HTTP %s, expected 200 (waited %ss)\n' "${url}" "${status}" "${wait_seconds}" >&2
      return 1
    fi
    sleep 1
  done
}

unit_exists() {
  systemctl --user cat "$1" >/dev/null 2>&1
}

restart_unit() {
  local unit="$1"
  run systemctl --user restart "${unit}"
}

install_ao_unit() {
  run mkdir -p "${systemd_user_dir}"
  run cp "${repo_root}/ops/ao.service" "${systemd_user_dir}/${ao_unit}"
  run systemctl --user daemon-reload
}

verify_unit_active() {
  local unit="$1"
  local label="$2"
  if [[ "${dry_run}" == "1" ]]; then
    run systemctl --user is-active --quiet "${unit}"
    return 0
  fi
  if ! unit_exists "${unit}"; then
    printf '%s unit %s is not installed\n' "${label}" "${unit}" >&2
    return 1
  fi
  systemctl --user is-active --quiet "${unit}"
  log "${label} unit ${unit} is active"
}

verify_after_restart() {
  local expected_sessions="$1"

  wait_for_ao_ready
  verify_ao_doctor
  verify_projects_api

  if [[ "${dry_run}" == "1" ]]; then
    run ao session ls --json
  else
    local actual_sessions
    actual_sessions="$(session_count)"
    if [[ "${actual_sessions}" != "${expected_sessions}" ]]; then
      printf 'Session re-adoption count mismatch: before=%s after=%s\n' "${expected_sessions}" "${actual_sessions}" >&2
      return 1
    fi
    log "Session re-adoption count preserved: ${actual_sessions}"
  fi

}

rollback_deploy() {
  log "Rolling back ao binary from ${ao_prev} to ${ao_bin}"
  if [[ "${dry_run}" != "1" && ! -f "${ao_prev}" ]]; then
    printf 'Rollback binary not found: %s\n' "${ao_prev}" >&2
    return 1
  fi

  local pre_sessions
  if [[ "${dry_run}" == "1" ]]; then
    pre_sessions=0
  else
    pre_sessions="$(session_count)"
  fi

  run cp "${ao_prev}" "${ao_bin}"
  run chmod +x "${ao_bin}"
  install_ao_unit
  restart_unit "${ao_unit}"
  verify_after_restart "${pre_sessions}"
  verify_tailnet_web
}

deploy() {
  local head base frontend_changed=false frontend_package_metadata_changed=false ops_changed=false pre_sessions

  if [[ "${dry_run}" != "1" && ! -x "${ao_bin}" ]]; then
    printf 'Current ao binary is not executable: %s\n' "${ao_bin}" >&2
    return 1
  fi

  head="$(git_head)"
  base="$(default_base_ref || true)"

  log "Deploying ao from ${repo_root}"
  log "Deploy range: ${base:-<unknown/first deploy>}..${head}"
  verify_main_ci_green "${head}"

  if changed_in_range "${base}" "${head}" "frontend/"; then
    frontend_changed=true
  fi
  if changed_in_range "${base}" "${head}" "frontend/package.json" ||
    changed_in_range "${base}" "${head}" "frontend/package-lock.json"; then
    frontend_package_metadata_changed=true
  fi
  if changed_in_range "${base}" "${head}" "ops/"; then
    ops_changed=true
  fi

  if [[ "${dry_run}" == "1" ]]; then
    pre_sessions=0
  else
    pre_sessions="$(session_count)"
  fi

  run mkdir -p "$(dirname "${ao_bin}")"
  install_ao_unit
  run cp "${ao_bin}" "${ao_prev}"
  run_in "${repo_root}/backend" go build -o "${ao_bin}" ./cmd/ao

  # Record + flag the built revision before restarting: the log line lands in
  # the durable deploy log, and a dirty tree gets a loud warning so a
  # vcs.modified=true binary is never shipped silently.
  local built_revision built_modified
  if [[ "${dry_run}" != "1" ]]; then
    built_revision="$(binary_build_setting "${ao_bin}" vcs.revision)"
    built_modified="$(binary_build_setting "${ao_bin}" vcs.modified)"
    log "Built ao revision: ${built_revision:-<unknown>} (dirty=${built_modified:-unknown})"
    warn_if_dirty "${ao_bin}"
  fi

  restart_unit "${ao_unit}"
  verify_after_restart "${pre_sessions}"
  verify_daemon_revision "${built_revision:-}"

  if [[ "${frontend_changed}" == "true" ]]; then
    if [[ "${frontend_package_metadata_changed}" == "true" ]]; then
      install_frontend_dependencies
    fi
    log "frontend/ changed; restarting ${web_unit} (ExecStartPre rebuilds the production web bundle)."
    restart_unit "${web_unit}"
    verify_unit_active "${web_unit}" "ao web"
  else
    log "frontend/ unchanged; leaving ${web_unit} running."
  fi

  if [[ "${ops_changed}" == "true" ]]; then
    log "ops/ changed; restarting ${notifier_unit}."
    restart_unit "${notifier_unit}"
    verify_unit_active "${notifier_unit}" "Slack notifier"

    # Reconcile #82/#87: ao-slack-notifier.service is the single outbound
    # notifier. It now reads the durable notifications API, so the session-poll
    # ao-attention-notifier.service must not also run and duplicate pages. Keep
    # only the inbound reply listener wiring from the two-way attention system.
    log "ops/ changed; installing + restarting attention reply unit (${attention_reply_unit}); outbound attention notifier is retired."
    run_in "${repo_root}" bash ops/install-attention.sh

    # install-attention.sh is best-effort (run_soft) so it can run on hosts
    # without a user bus; in a real deploy we must not finish green with the
    # reply listener down.
    verify_unit_active "${attention_reply_unit}" "attention reply listener"
  else
    log "ops/ unchanged; leaving ${notifier_unit} running."
    log "ops/ unchanged; leaving ${attention_reply_unit} running; outbound attention notifier remains retired."
  fi

  # Verify last: every unit this deploy is responsible for restarting has now
  # been restarted, so a web URL that is genuinely down still fails the deploy
  # without leaving the notifier behind on stale code.
  verify_tailnet_web

  if [[ "${dry_run}" != "1" ]]; then
    mkdir -p "${state_dir}"
    printf '%s\n' "${head}" > "${state_file}"
  else
    run mkdir -p "${state_dir}"
    printf 'DRY-RUN: write deployed ref %s to %s\n' "${head}" "${state_file}"
  fi

  log "ao deploy complete."
}

if [[ "${rollback}" == "true" ]]; then
  rollback_deploy
else
  deploy
fi
