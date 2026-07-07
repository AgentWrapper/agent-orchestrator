#!/usr/bin/env bash
# install-attention.sh — nickify/deploy-layer wiring for the two-way attention
# system (issue #82). Idempotently installs the systemd user units for the
# outbound notifier and the inbound reply listener, verifies the required Slack
# config keys are present, and (re)starts the services.
#
# This is the "config lives in nickify/deploy, not a hand-patched unit + .env"
# half of acceptance #4: a fresh host runs this once and the attention system
# is wired — SLACK_MEMBER_ID, SLACK_SIGNING_SECRET, and a Slack sink are read
# from the env layer, not baked into a bespoke unit.
#
# Vanilla rule: this only manages ops-layer units + env; it never touches ao.

set -euo pipefail

repo_root="${AO_ATTENTION_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
units_dir="${AO_ATTENTION_UNITS_DIR:-${HOME}/.config/systemd/user}"
env_file="${AO_ENV_FILE:-${HOME}/agent-orchestrator/.env}"
dry_run="${AO_ATTENTION_DRY_RUN:-0}"
do_start="${AO_ATTENTION_START:-1}"

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
    log "WARN: '$*' failed (no user systemd bus?); unit files are installed — once a user bus is available, run: systemctl --user daemon-reload && systemctl --user enable --now ao-attention-notifier.service ao-attention-reply.service"
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

# 2. Install the units (idempotent copy).
run mkdir -p "${units_dir}"
for unit in ao-attention-notifier.service ao-attention-reply.service; do
  log "Installing ${unit} -> ${units_dir}/${unit}"
  run cp "${repo_root}/ops/${unit}" "${units_dir}/${unit}"
done

# 3. Reload + (re)start.
run_soft systemctl --user daemon-reload

# Division of responsibility (not supersession): the two-way attention notifier
# owns session-derived attention (needs_input/blocked/no_signal); the legacy
# ao-slack-notifier keeps owning PR/merge EVENTS (ready_to_merge incl. parked
# sensitive merges, pr_merged, park notes) that a session poll cannot see. The
# legacy notifier no longer mentions needs_input, so the two run side by side
# without double-paging. We therefore leave ao-slack-notifier.service running.

if [[ "${do_start}" == "1" ]]; then
  for unit in ao-attention-notifier.service ao-attention-reply.service; do
    run_soft systemctl --user enable "${unit}"
    run_soft systemctl --user restart "${unit}"
  done
  log "Attention services installed and (re)started."
else
  log "Attention units installed (start skipped: AO_ATTENTION_START=0)."
fi
