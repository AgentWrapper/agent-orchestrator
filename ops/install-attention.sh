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
has_key() { grep -qE "^${1}=" "${env_file}"; }
if [[ -r "${env_file}" ]]; then
  for k in "${required_keys[@]}"; do
    has_key "${k}" || missing+=("${k}")
  done
  # A usable sink is EITHER a webhook OR a bot token *paired with* a channel —
  # createSlackClient only uses the Web API when both token and channel are set.
  have_sink=0
  has_key SLACK_WEBHOOK_URL && have_sink=1
  { has_key SLACK_BOT_TOKEN && has_key SLACK_CHANNEL; } && have_sink=1
  [[ "${have_sink}" == "1" ]] || missing+=("a Slack sink (SLACK_BOT_TOKEN+SLACK_CHANNEL or SLACK_WEBHOOK_URL)")
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
log "Installing ${unit} -> ${units_dir}/${unit}"
run cp "${repo_root}/ops/${unit}" "${units_dir}/${unit}"

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

if [[ "${do_start}" == "1" ]]; then
  run_soft systemctl --user enable "${unit}"
  run_soft systemctl --user restart "${unit}"
  log "Attention reply service installed and (re)started; outbound attention notifier retired."
else
  log "Attention reply unit installed (start skipped: AO_ATTENTION_START=0); outbound attention notifier retired."
fi
