#!/usr/bin/env bash
# install-attention.sh — nickify/deploy-layer wiring for the inbound half of
# the two-way attention system (issue #82). Idempotently installs the Slack
# reply listener, verifies the required Slack config keys are present, and
# (re)starts the listener.
#
# This is the "config lives in nickify/deploy, not a hand-patched unit + .env"
# half of acceptance #4: a fresh host runs this once and the reply path is
# wired — SLACK_MEMBER_ID, SLACK_SIGNING_SECRET, and a Slack sink are read from
# the env layer, not baked into a bespoke unit.
#
# Vanilla rule: this only manages ops-layer units + env; it never touches ao.

set -euo pipefail

repo_root="${AO_ATTENTION_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
units_dir="${AO_ATTENTION_UNITS_DIR:-${HOME}/.config/systemd/user}"
env_file="${AO_ENV_FILE:-${HOME}/agent-orchestrator/.env}"
dry_run="${AO_ATTENTION_DRY_RUN:-0}"
do_start="${AO_ATTENTION_START:-1}"
legacy_state="${AO_ATTENTION_LEGACY_STATE:-${AO_ATTENTION_STATE:-${HOME}/.ao/attention-state.json}}"
release_current="${AO_ATTENTION_RELEASE_CURRENT:-${AO_DEPLOY_CURRENT:-${AO_DEPLOY_STATE_DIR:-${HOME}/.ao/deploy}/current}}"

log() { printf '%s\n' "$*"; }
run() {
  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: %s\n' "$*"
    return 0
  fi
  "$@"
}

# systemctl wiring is best-effort: a host without a running user bus (e.g. CI)
# must still get the unit files installed. Warn instead of aborting.
run_soft() {
  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: %s\n' "$*"
    return 0
  fi
  if ! "$@"; then
    log "WARN: '$*' failed (no user systemd bus?); unit files are installed — once a user bus is available, run: systemctl --user daemon-reload && systemctl --user enable --now ao-attention-reply.service"
    return 0
  fi
}

# 1. Verify required config keys (warn, don't fail — a host may wire env later).
required_keys=(SLACK_MEMBER_ID SLACK_SIGNING_SECRET)
missing=()
has_nonempty_key() {
  local key="$1" value
  value="$(grep -E "^${key}=" "${env_file}" | tail -n 1 | cut -d= -f2- || true)"
  value="${value%$'\r'}"
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  [[ -n "${value}" ]]
}
if [[ -r "${env_file}" ]]; then
  for k in "${required_keys[@]}"; do
    has_nonempty_key "${k}" || missing+=("${k}")
  done
  # A usable sink is EITHER a webhook OR a bot token paired with a channel.
  have_sink=0
  has_nonempty_key SLACK_WEBHOOK_URL && have_sink=1
  if has_nonempty_key SLACK_BOT_TOKEN &&
    { has_nonempty_key SLACK_CHANNEL ||
      has_nonempty_key SLACK_CHANNEL_NOTIFY ||
      has_nonempty_key SLACK_CHANNEL_NEEDS_RESPONSE; }; then
    have_sink=1
  fi
  [[ "${have_sink}" == "1" ]] || missing+=("a Slack sink (SLACK_BOT_TOKEN plus a Slack channel or SLACK_WEBHOOK_URL)")
else
  log "WARN: env file ${env_file} not found; the units will start but cannot post until it exists."
fi
if ((${#missing[@]})); then
  log "WARN: missing attention config in ${env_file}:"
  for m in "${missing[@]}"; do log "  - ${m}"; done
  log "The services will start and self-report the gap rather than silently no-op."
fi

# 2. Install the inbound reply unit (idempotent copy). The outbound #82
# session-poll notifier is intentionally retired here: #87 makes
# ao-slack-notifier.service the single outbound notifier, now backed by
# /api/v1/notifications, so running both would duplicate pages.
run mkdir -p "${units_dir}"
unit="ao-attention-reply.service"
unit_source="${repo_root}/ops/${unit}"
if [[ -f "${release_current}/systemd/${unit}" ]]; then
  unit_source="${release_current}/systemd/${unit}"
fi
log "Installing ${unit} -> ${units_dir}/${unit}"
run cp "${unit_source}" "${units_dir}/${unit}"

# 3. Reload + (re)start the reply listener, and best-effort disable any stale
# outbound attention notifier unit left from a previous #82 install.
run_soft systemctl --user daemon-reload
run_soft systemctl --user disable --now ao-attention-notifier.service
if [[ -e "${legacy_state}" ]]; then
  if [[ "${dry_run}" == "1" ]]; then
    log "Would remove retired outbound attention state: ${legacy_state}"
  elif rm -f "${legacy_state}"; then
    log "Removed retired outbound attention state: ${legacy_state}"
  else
    log "WARN: failed to remove retired outbound attention state: ${legacy_state}"
  fi
fi

if [[ "${do_start}" == "1" && "${dry_run}" != "1" && ! -e "${release_current}" ]]; then
  run_soft systemctl --user enable "${unit}"
  log "WARN: release pointer ${release_current} not found; reply unit installed and enabled, but start skipped until ops/deploy.sh creates a release."
elif [[ "${do_start}" == "1" ]]; then
  run_soft systemctl --user enable "${unit}"
  run_soft systemctl --user restart "${unit}"
  log "Attention reply service installed and (re)started; outbound attention notifier retired."
else
  log "Attention reply unit installed (start skipped: AO_ATTENTION_START=0); outbound attention notifier retired."
fi
