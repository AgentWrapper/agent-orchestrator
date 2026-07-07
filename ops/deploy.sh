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
  AO_DEPLOY_BASE            base git ref for changed-path detection
  AO_DEPLOY_HEAD            head git ref for changed-path detection (default: HEAD)
  AO_DEPLOY_WEB_URL         tailnet/public web URL to verify
  AO_DEPLOY_WAIT_SECONDS    ao restart readiness timeout (default: 30)
  AO_DEPLOY_DRY_RUN=1       print actions without changing the host
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="${AO_DEPLOY_REPO_ROOT:-$(cd "${script_dir}/.." && pwd -P)}"
ao_bin="${AO_DEPLOY_AO_BIN:-${HOME}/.local/bin/ao}"
ao_prev="${AO_DEPLOY_AO_PREV:-${ao_bin}.prev}"
state_dir="${AO_DEPLOY_STATE_DIR:-${HOME}/.ao/deploy}"
state_file="${AO_DEPLOY_STATE_FILE:-${state_dir}/agent-orchestrator.last-deployed}"
ao_unit="${AO_DEPLOY_AO_UNIT:-ao.service}"
web_unit="${AO_DEPLOY_WEB_UNIT:-ao-web.service}"
notifier_unit="${AO_DEPLOY_NOTIFIER_UNIT:-ao-slack-notifier.service}"
attention_notifier_unit="${AO_DEPLOY_ATTENTION_NOTIFIER_UNIT:-ao-attention-notifier.service}"
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

git_head() {
  git -C "${repo_root}" rev-parse "${AO_DEPLOY_HEAD:-HEAD}"
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

  local status
  status="$(curl --location --silent --output /dev/null --write-out '%{http_code}' "${url}")"
  if [[ "${status}" != "200" ]]; then
    printf '%s returned HTTP %s, expected 200\n' "${url}" "${status}" >&2
    return 1
  fi
  log "${url} returned HTTP 200"
}

unit_exists() {
  systemctl --user cat "$1" >/dev/null 2>&1
}

restart_unit() {
  local unit="$1"
  run systemctl --user restart "${unit}"
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
  restart_unit "${ao_unit}"
  verify_after_restart "${pre_sessions}"
  verify_tailnet_web
}

deploy() {
  local head base frontend_changed=false ops_changed=false pre_sessions

  if [[ "${dry_run}" != "1" && ! -x "${ao_bin}" ]]; then
    printf 'Current ao binary is not executable: %s\n' "${ao_bin}" >&2
    return 1
  fi

  head="$(git_head)"
  base="$(default_base_ref || true)"

  log "Deploying ao from ${repo_root}"
  log "Deploy range: ${base:-<unknown/first deploy>}..${head}"

  if changed_in_range "${base}" "${head}" "frontend/"; then
    frontend_changed=true
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
  run cp "${ao_bin}" "${ao_prev}"
  run_in "${repo_root}/backend" go build -o "${ao_bin}" ./cmd/ao
  restart_unit "${ao_unit}"
  verify_after_restart "${pre_sessions}"

  if [[ "${frontend_changed}" == "true" ]]; then
    log "frontend/ changed; restarting ${web_unit} (ExecStartPre rebuilds the production web bundle)."
    restart_unit "${web_unit}"
    verify_unit_active "${web_unit}" "ao web"
  else
    log "frontend/ unchanged; leaving ${web_unit} running."
  fi

  verify_tailnet_web

  if [[ "${ops_changed}" == "true" ]]; then
    log "ops/ changed; restarting ${notifier_unit}."
    restart_unit "${notifier_unit}"
    verify_unit_active "${notifier_unit}" "Slack notifier"

    # Two-way attention system (issue #82): install/refresh its units from the
    # deploy/nickify layer, then (re)start them. Config (SLACK_MEMBER_ID,
    # SLACK_SIGNING_SECRET, sink) lives in the env layer, not a bespoke unit.
    log "ops/ changed; installing + restarting attention units (${attention_notifier_unit}, ${attention_reply_unit})."
    run_in "${repo_root}" bash ops/install-attention.sh

    # install-attention.sh is best-effort (run_soft) so it can run on hosts
    # without a user bus; in a real deploy we must not finish green with the
    # attention services down, so verify both are active here.
    verify_unit_active "${attention_notifier_unit}" "attention notifier"
    verify_unit_active "${attention_reply_unit}" "attention reply listener"
  else
    log "ops/ unchanged; leaving ${notifier_unit} running."
    log "ops/ unchanged; leaving attention units running."
  fi

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
