#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ops/deploy.sh [--rollback]

Deploy ao's self-hosted production target: the local user-level ao daemon.

Environment overrides:
  AO_DEPLOY_REPO_ROOT       repo checkout to deploy from (default: script parent)
  AO_DEPLOY_AO_BIN          stable ao CLI symlink path (default: ~/.local/bin/ao)
  AO_DEPLOY_SYSTEMD_USER_DIR systemd user unit dir (default: ~/.config/systemd/user)
  AO_DEPLOY_STATE_DIR       release state dir (default: ~/.ao/deploy)
  AO_DEPLOY_STATE_FILE      deployed revision marker (default: $AO_DEPLOY_STATE_DIR/agent-orchestrator.last-deployed)
  AO_DEPLOY_LOCK_FILE       deploy/rollback lock file (default: $AO_DEPLOY_STATE_DIR/deploy.lock)
  AO_DEPLOY_PRE_HERMETIC_DIR pre-hermetic binary/unit backup dir (default: $AO_DEPLOY_STATE_DIR/pre-hermetic)
  AO_DEPLOY_RELEASES_DIR    immutable release dirs (default: $AO_DEPLOY_STATE_DIR/releases)
  AO_DEPLOY_CURRENT         current release symlink (default: $AO_DEPLOY_STATE_DIR/current)
  AO_DEPLOY_PREVIOUS        previous release symlink (default: $AO_DEPLOY_STATE_DIR/previous)
  AO_DEPLOY_RELEASE_RETENTION inactive releases to keep besides current/previous (default: 3)
  AO_DEPLOY_NPM_CACHE_DIR   npm cache used by staged web builds (default: $AO_DEPLOY_STATE_DIR/npm-cache)
  AO_DEPLOY_BASE            base git ref for changed-path detection
  AO_DEPLOY_HEAD            head git ref for changed-path detection (default: HEAD)
  AO_DEPLOY_GITHUB_REPO     GitHub repo owner/name for main CI verification
  AO_DEPLOY_WEB_URL         tailnet/public web URL to verify
  AO_DEPLOY_SLACK_ENV_FILE  Slack config env file (default: ~/agent-orchestrator/.env)
  AO_DEPLOY_LEGACY_ATTENTION_UNIT retired outbound notifier unit (default: ao-attention-notifier.service)
  AO_DEPLOY_WAIT_SECONDS    ao restart + web readiness timeout (default: 30)
  AO_DEPLOY_DRY_RUN=1       print actions without changing the host
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="${AO_DEPLOY_REPO_ROOT:-$(cd "${script_dir}/.." && pwd -P)}"
ao_bin="${AO_DEPLOY_AO_BIN:-${HOME}/.local/bin/ao}"
systemd_user_dir="${AO_DEPLOY_SYSTEMD_USER_DIR:-${HOME}/.config/systemd/user}"
state_dir="${AO_DEPLOY_STATE_DIR:-${HOME}/.ao/deploy}"
state_file="${AO_DEPLOY_STATE_FILE:-${state_dir}/agent-orchestrator.last-deployed}"
deploy_lock="${AO_DEPLOY_LOCK_FILE:-${state_dir}/deploy.lock}"
pre_hermetic_dir="${AO_DEPLOY_PRE_HERMETIC_DIR:-${state_dir}/pre-hermetic}"
release_root="${AO_DEPLOY_RELEASES_DIR:-${state_dir}/releases}"
current_link="${AO_DEPLOY_CURRENT:-${state_dir}/current}"
previous_link="${AO_DEPLOY_PREVIOUS:-${state_dir}/previous}"
release_retention="${AO_DEPLOY_RELEASE_RETENTION:-3}"
npm_cache_dir="${AO_DEPLOY_NPM_CACHE_DIR:-${state_dir}/npm-cache}"
# Durable, append-only record of every deploy: timestamp, source ref, and the
# built revision. The old ~/.ao/deploy-main.log went stale (last written by a
# since-deleted worktree) because nothing appended to it reliably; log() now
# tees here on every run so the log can never silently fall behind again.
deploy_log="${AO_DEPLOY_LOG:-${state_dir}/agent-orchestrator.deploy.log}"
deploy_log_warned=0
ao_unit="${AO_DEPLOY_AO_UNIT:-ao.service}"
# Owns the tmux server, and therefore the cgroup every agent pane lives in
# (#293/D1). Installed and enabled like any other unit, but NEVER stopped,
# restarted or `disable --now`-ed by a deploy OR a rollback: stopping it signals
# the tmux server every agent in the fleet lives under. The unit itself is what
# makes a STOP JOB non-fatal now (no ExecStop, RefuseManualStop, SIGCONT, no
# SIGKILL — see ops/ao-tmux.service); guard_fleet_fatal() keeps this script from
# even trying.
#
# Scope that claim precisely, because every previous version of this fix
# overclaimed it: the deploy path and the ordinary systemd stop/restart/failure
# paths can no longer kill the fleet. Direct cgroup kills (`systemctl --user
# kill`, systemd-oomd, the kernel OOM killer) and host/user-manager shutdown still
# can — no unit directive can refuse a signal delivered straight to the cgroup.
# The residual-risk note at the end of ops/ao-tmux.service's [Service] block is
# the full list.
tmux_unit="${AO_DEPLOY_TMUX_UNIT:-ao-tmux.service}"
# Re-takes the tmux socket for ${tmux_unit} if the legacy server ever DIES (crash,
# OOM, an outright kill) — draining is prevented outright by
# prevent_legacy_tmux_drain(). A unit that ExecCondition SKIPPED is never retried
# by systemd, so without this the socket freed by such a death would be grabbed by
# the daemon and D1 would come straight back (#293).
tmux_claim_unit="${AO_DEPLOY_TMUX_CLAIM_UNIT:-ao-tmux-claim.service}"
tmux_claim_timer="${AO_DEPLOY_TMUX_CLAIM_TIMER:-ao-tmux-claim.timer}"
# Set when prevent_legacy_tmux_drain() could not write the exit-empty pin, so the
# end of the run can say so instead of ending on a clean-looking line (#293/D1).
tmux_drain_pin_failed=0
web_unit="${AO_DEPLOY_WEB_UNIT:-ao-web.service}"
notifier_unit="${AO_DEPLOY_NOTIFIER_UNIT:-ao-slack-notifier.service}"
attention_reply_unit="${AO_DEPLOY_ATTENTION_REPLY_UNIT:-ao-attention-reply.service}"
slack_env_file="${AO_DEPLOY_SLACK_ENV_FILE:-${AO_ENV_FILE:-${HOME}/agent-orchestrator/.env}}"
legacy_attention_unit="${AO_DEPLOY_LEGACY_ATTENTION_UNIT:-ao-attention-notifier.service}"
legacy_attention_state="${AO_DEPLOY_ATTENTION_LEGACY_STATE:-${AO_ATTENTION_LEGACY_STATE:-${AO_ATTENTION_STATE:-${HOME}/.ao/attention-state.json}}}"
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

# Refuse — hard, before anything is executed OR printed — any command that would
# stop the tmux server (#293/D1).
#
# Every agent pane, every claude / codex / `npm test` child in the fleet lives
# under that server. `systemctl stop|restart|kill|try-restart ao-tmux.service`,
# and `disable --NOW`, are not "risky": a deploy or an emergency rollback is
# exactly when someone reaches for them, and `kill` in particular signals the
# unit's whole cgroup — which no unit directive can refuse.
#
# THIS IS THE SECOND LAYER, NOT THE INVARIANT (#293, review cycle 2). A guard in
# one shell script cannot enforce a systemd-level property: it only sees the
# spellings this script issues, never a hand-typed `systemctl --user stop`, a
# `mask --now`, or a user-manager shutdown. The invariant lives in
# ops/ao-tmux.service, which now carries no ExecStop, refuses manual stops, and
# signals the server with SIGCONT rather than SIGTERM/SIGKILL. This guard exists
# so a future edit to THIS script fails the DEPLOY (loudly, before any host
# mutation) rather than relying on that unit's defenses.
#
# `disable` without `--now` and `enable`/`start` stay allowed: they are how the
# unit is installed and how it takes ownership of the socket.
#
# The tmux arm is the same idea one level down. Deploy has exactly one reason to
# speak to the fleet's tmux server (pinning `exit-empty off`, see
# prevent_legacy_tmux_drain), and every verb that can end a server, a session, a
# window or a pane is a fleet kill spelled without the word systemctl. Read-only
# probes and option writes stay allowed; anything that destroys does not.
guard_fleet_fatal() {
  local args=" ${*} " verb=""
  if [[ "$1" == "tmux" ]]; then
    case "${args}" in
      *" kill-server "* | *" kill-session "* | *" kill-window "* | *" kill-pane "*)
        printf 'Refusing to run `%s`: it would kill the tmux server (or a pane of it) that the whole agent fleet lives in (#293/D1). Deploy and rollback may only PROBE that server and set options on it.\n' \
          "$(quote_cmd "$@")" >&2
        return 1
        ;;
      *) return 0 ;;
    esac
  fi
  [[ "$1" == "systemctl" ]] || return 0
  [[ "${args}" == *" ${tmux_unit} "* ]] || return 0
  case "${args}" in
    *" stop "*) verb="stop" ;;
    *" restart "*) verb="restart" ;;
    *" try-restart "*) verb="try-restart" ;;
    *" reload-or-restart "*) verb="reload-or-restart" ;;
    *" kill "*) verb="kill" ;;
    *" --now "*) verb="disable --now" ;;
    *) return 0 ;;
  esac
  printf 'Refusing to run `%s`: it would stop the tmux server that %s owns, killing every agent pane in the fleet (#293/D1). Deploy and rollback must never stop this unit.\n' \
    "$(quote_cmd "$@")" "${tmux_unit}" >&2
  return 1
}

run() {
  guard_fleet_fatal "$@" || return 1
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

# NEVER BRANCH ON THIS FUNCTION'S EXIT STATUS (#293, review cycle 4).
#
# run_best_effort SWALLOWS failure by design: it warns and returns 0 whatever the
# command did. Its status therefore carries NO information about the command, and
# `if run_best_effort …` / `run_best_effort … || …` writes a branch that can never
# be taken. That is not hypothetical: the exit-empty pin was written that way and
# printed "Pinned exit-empty=off" on the line after "WARN: … failed; continuing" —
# a deploy reporting the D1 race closed while it was wide open.
#
# A caller that needs to know whether the command worked must call `run` (which
# returns the command's real status) and branch on that. deploy.test.mjs asserts no
# line in this file branches on run_best_effort.
run_best_effort() {
  # "Best effort" never extends to a fleet-fatal command: that one aborts.
  guard_fleet_fatal "$@" || return 1
  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: %s\n' "$(quote_cmd "$@")"
    return 0
  fi
  if ! "$@"; then
    log "WARN: '$(quote_cmd "$@")' failed; continuing."
  fi
  return 0
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

# verify_built_revision_stamped enforces the deploy provenance contract on the
# freshly built binary BEFORE the service is restarted onto it. The binary MUST
# carry Go VCS metadata (vcs.revision), MUST NOT be built from a dirty tree
# (vcs.modified=true), and its stamped revision MUST match the git ref this
# deploy is shipping. A build with no VCS stamping — e.g. -buildvcs=false or a
# checkout the toolchain could not read — makes the running daemon report
# "dev"/"unknown", which is undetectable from any ao surface (the exact trap
# #262 exists to close), so every one of these is a HARD FAILURE, not a
# warning. Failing here (before restart_unit) leaves the old daemon running and
# the active release pointer is left untouched so rollback still has a
# known-good release to switch to.
verify_built_revision_stamped() {
  local revision="$1" modified="$2" expected_ref="$3"
  if [[ "${dry_run}" == "1" ]]; then
    log "DRY-RUN: would verify built binary is VCS-stamped, clean, and matches ${expected_ref:-<unknown>}"
    return 0
  fi
  if ! command_exists go; then
    printf 'Refusing to deploy: go is required to read the built binary revision (go version -m).\n' >&2
    return 1
  fi
  if [[ -z "${revision}" ]]; then
    printf 'Refusing to deploy: built ao binary has no VCS revision stamp (go version -m reported no vcs.revision). A binary built with -buildvcs=false or outside a git checkout leaves the daemon reporting an unknown revision.\n' >&2
    return 1
  fi
  # The contract is to PROVE the binary is clean, so accept only an explicit
  # vcs.modified=false. A "true" stamp is a dirty build; anything else (empty,
  # absent, or malformed) means the clean flag could not be read and must not
  # be treated as clean.
  if [[ "${modified}" != "false" ]]; then
    if [[ "${modified}" == "true" ]]; then
      printf 'Refusing to deploy: built ao binary is stamped dirty (vcs.modified=true); the running revision %s would not fully describe the code on disk. Commit or stash local changes and rebuild.\n' "${revision}" >&2
    else
      printf 'Refusing to deploy: could not confirm built ao binary is clean (vcs.modified=%s, expected false); refusing to ship a binary whose dirty flag is unreadable.\n' "${modified:-<empty>}" >&2
    fi
    return 1
  fi
  if [[ -n "${expected_ref}" && "${revision}" != "${expected_ref}" ]]; then
    printf 'Refusing to deploy: built ao binary revision %s does not match the deploy source ref %s.\n' "${revision}" "${expected_ref}" >&2
    return 1
  fi
  log "Built ao binary is VCS-stamped and clean: ${revision}"
}

# verify_daemon_revision confirms the just-restarted daemon reports the same
# revision the deploy just built. A mismatch means the restart did not pick up
# the new binary (stale service, wrong path). An unreadable built revision or an
# unavailable/empty /version endpoint means the deploy cannot prove the running
# daemon is the code just built — undetectable provenance is exactly what #262
# closes — so all of these are hard failures rather than skipped warnings.
verify_daemon_revision() {
  local expected="$1"
  if [[ "${dry_run}" == "1" ]]; then
    log "DRY-RUN: would verify running daemon revision matches ${expected:-<unknown>}"
    return 0
  fi
  if [[ -z "${expected}" ]]; then
    printf 'Refusing to finish deploy: no built binary revision available to verify the running daemon against.\n' >&2
    return 1
  fi
  local reported
  reported="$(daemon_reported_revision)"
  if [[ -z "${reported}" ]]; then
    printf 'Revision verification failed: running daemon did not report a revision (/api/v1/version unavailable or empty); cannot confirm it matches built %s.\n' "${expected}" >&2
    return 1
  fi
  if [[ "${reported}" != "${expected}" ]]; then
    printf 'Revision mismatch: built %s but running daemon reports %s\n' "${expected}" "${reported}" >&2
    return 1
  fi
  log "Running daemon revision matches built binary: ${reported}"
}

maybe_fetch_origin() {
  local origin_url
  origin_url="$(git -C "${repo_root}" remote get-url origin 2>/dev/null || true)"
  if [[ -z "${origin_url}" ]]; then
    return 0
  fi
  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: git -C %s fetch --tags --prune origin\n' "$(printf '%q' "${repo_root}")" >&2
    return 0
  fi
  if ! git -C "${repo_root}" fetch --tags --prune origin; then
    case "${AO_DEPLOY_HEAD:-HEAD}" in
      origin/*|refs/remotes/origin/*)
        printf 'Refusing to deploy %s: origin fetch failed, so the requested remote-tracking ref may be stale.\n' "${AO_DEPLOY_HEAD}" >&2
        return 1
        ;;
    esac
    printf 'WARNING: origin fetch failed; deploying from local refs.\n' >&2
  fi
}

git_head() {
  maybe_fetch_origin || return 1
  git -C "${repo_root}" rev-parse "${AO_DEPLOY_HEAD:-HEAD}^{commit}"
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
  # Workflow runs for this sha classify each check suite by triggering event, so
  # scheduled/release-only guards can be excluded from the deploy gate below.
  # Project down to just {total_count, event, check_suite_id} up front: the raw
  # run objects are large and are passed to node via an environment variable,
  # which is bounded by MAX_ARG_STRLEN (~128 KiB) — a busy sha could otherwise
  # overflow it and abort the deploy.
  # On a failed fetch the gate fails closed (no exclusions → scheduled/release
  # guards still count). gh's own error is left on stderr (not captured into the
  # JSON var — capturing it would corrupt valid JSON on a success that also
  # printed a benign stderr notice) so the operator can see *why* a deploy is
  # being blocked, and we add an explicit warning naming the consequence.
  local workflow_runs
  if ! workflow_runs="$(gh api "repos/${repo}/actions/runs?head_sha=${sha}&per_page=100" \
    --jq '{total_count: .total_count, workflow_runs: [.workflow_runs[] | {event, check_suite_id}]}')"; then
    printf 'WARNING: could not fetch workflow runs for %s; scheduled/release guards will NOT be excluded from the main CI gate\n' "${sha}" >&2
    workflow_runs='{}'
  fi
  gh api "repos/${repo}/commits/${sha}/check-runs?per_page=100" | GH_WORKFLOW_RUNS="${workflow_runs}" node -e '
let body = "";
process.stdin.on("data", (chunk) => (body += chunk));
process.stdin.on("end", () => {
  const parsed = JSON.parse(body || "{}");
  if (typeof parsed.state === "string") {
    const jobs = Array.isArray(parsed.failedJobs) ? parsed.failedJobs : [];
    console.log(`${parsed.state}\t${jobs.join(", ")}`);
    return;
  }
  let runs = Array.isArray(parsed.check_runs) ? parsed.check_runs : [];
  if (Number(parsed.total_count || 0) > runs.length) {
    console.log(`unknown\tcheck runs truncated at ${runs.length}/${parsed.total_count}`);
    return;
  }
  // Exclude check runs produced by scheduled/release-only workflows (e.g.
  // release-latest-guard, which runs on cron/release against main). Those are
  // not part of the PR/merge required-check set, and on a fork with no GitHub
  // releases they fail — counting them would wrongly block every deploy. The
  // check-runs listing carries no triggering event, so map each suite to its
  // event via the workflow-runs listing fetched above.
  const IGNORED_EVENTS = new Set(["schedule", "release"]);
  const ignoredSuites = new Set();
  const keptSuites = new Set();
  try {
    const wr = JSON.parse(process.env.GH_WORKFLOW_RUNS || "{}");
    const wruns = Array.isArray(wr.workflow_runs) ? wr.workflow_runs : [];
    // Only trust the exclusion set when the workflow-runs listing is complete;
    // a truncated listing could omit the very schedule/release run we need to
    // drop, so fall back to counting every check run (fail-closed).
    if (Number(wr.total_count || 0) <= wruns.length) {
      for (const r of wruns) {
        if (r.check_suite_id == null) continue;
        const id = String(r.check_suite_id);
        if (IGNORED_EVENTS.has(String(r.event || "").toLowerCase())) {
          ignoredSuites.add(id);
        } else {
          keptSuites.add(id);
        }
      }
    }
  } catch {}
  // A suite referenced by ANY non-scheduled/non-release run is real merge CI —
  // never drop it, even if the same suite id also appears under a scheduled or
  // release run. Excluding it could mask a genuine push/merge_group failure.
  for (const id of keptSuites) ignoredSuites.delete(id);
  if (ignoredSuites.size) {
    runs = runs.filter((r) => !ignoredSuites.has(String(r.check_suite?.id ?? "")));
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

# The web surface's real inputs (#293 H4). Production does NOT execute anything
# from `frontend/` — it runs `ops/ao-web-server.mjs`, configured by
# `ops/ao-web.service` plus its drop-ins, serving the prebuilt `frontend/dist`
# bundle. Keying the web restart and its reporting on `frontend/` alone let an
# ops-only web change deploy "successfully" while the OLD node process kept
# serving, and the HTTP-200 verification then passed against that stale process.
# Each of these paths is a genuine web input.
web_input_paths=(
  "frontend/"
  "ops/ao-web-server.mjs"
  "ops/${web_unit}"
  "ops/${web_unit}.d"
)

# Emits the first changed web input path, or nothing when none changed. The path
# is echoed so the deploy log can name WHICH input triggered the restart instead
# of the untrue "frontend/ unchanged".
changed_web_input() {
  local base="$1" head="$2" pathspec
  for pathspec in "${web_input_paths[@]}"; do
    if changed_in_range "${base}" "${head}" "${pathspec}"; then
      printf '%s' "${pathspec}"
      return 0
    fi
  done
  return 1
}

# Unit drop-ins (`<unit>.d/*.conf`) are part of the unit definition. The tracked
# ops/ao-web.service.d/override.conf carries AO_WEB_PUBLIC_URL, which deploy
# itself reads back (systemd_environment_value) to decide whether to verify the
# tailnet web surface at all. Before #293 drop-ins were never rendered or
# installed, so a host kept whatever drop-in had been hand-placed on it forever,
# and a clean host silently SKIPPED web verification entirely.
unit_dropin_names() {
  local dir="$1" unit="$2" file
  [[ -d "${dir}/${unit}.d" ]] || return 0
  for file in "${dir}/${unit}.d"/*.conf; do
    [[ -f "${file}" ]] || continue
    printf '%s\n' "$(basename -- "${file}")"
  done
}

install_frontend_dependencies() {
  local source_root="$1"
  local lockfile="${source_root}/frontend/package-lock.json"
  local npm_ci_args=(npm ci --cache "${npm_cache_dir}" --prefer-offline)
  if [[ "${dry_run}" == "1" ]]; then
    if [[ ! -f "${lockfile}" ]] &&
      ! git -C "${repo_root}" cat-file -e "${AO_DEPLOY_HEAD:-HEAD}:frontend/package-lock.json" 2>/dev/null; then
      printf 'Refusing to install frontend dependencies: staged source is missing frontend/package-lock.json; this deploy expects npm lockfile management.\n' >&2
      return 1
    fi
    log "Installing frontend dependencies with npm ci for staged web build."
    run_in "${source_root}/frontend" "${npm_ci_args[@]}"
    return 0
  fi
  if [[ ! -f "${lockfile}" ]]; then
    printf 'Refusing to install frontend dependencies: %s is missing; this deploy expects npm lockfile management.\n' "${lockfile}" >&2
    return 1
  fi
  log "Installing frontend dependencies with npm ci for staged web build."
  run mkdir -p "${npm_cache_dir}"
  if ! run_in "${source_root}/frontend" "${npm_ci_args[@]}"; then
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

capture_pre_restart_sessions() {
  local count
  if count="$(session_count 2>/dev/null)"; then
    printf '%s\n' "${count}"
    return 0
  fi
  if [[ -L "${current_link}" ]] || ao status 2>/dev/null | grep -q 'AO daemon: ready'; then
    printf 'Refusing to deploy: could not capture pre-restart session count from a running ao daemon.\n' >&2
    return 1
  fi
  return 0
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

  # ao-web.service starts a prebuilt bundle from the active release, but the
  # node server still needs a moment to bind, so the URL serves 502 (or refuses the
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

# True when a unit declares an [Install] section, i.e. `systemctl enable` can do
# something with it. Read from the first definition that exists: the installed
# file, else the release payload, else the checkout's template (dry-run, where
# nothing has been rendered yet). A unit with no [Install] — ao-tmux-claim.service
# is started by its timer, not by a target — must not be handed to `enable`.
unit_is_enableable() {
  local unit="$1" candidate
  for candidate in "${systemd_user_dir}/${unit}" "${current_link}/systemd/${unit}" "${repo_root}/ops/${unit}"; do
    [[ -f "${candidate}" ]] || continue
    grep -qE '^\[Install\]' "${candidate}"
    return $?
  done
  # No definition to read: assume enableable and let systemctl be the judge, which
  # is how this behaved before the check existed.
  return 0
}

# Who owns the default tmux socket. THREE outcomes, never two (#293, review
# cycle 2) — the same classification the two unit files make, kept in step with
# them on purpose:
#
#   0 -> a server owns the socket
#   1 -> no server owns it (free)
#   2 -> the probe itself failed; we do not know, and we must not guess
#
# The old version returned "a server exists" for every tmux failure it did not
# recognize, so `tmux: command not found` or a socket permission error read as
# "someone owns it, leave it alone" — the safe-sounding answer that silently
# skips the whole D1 fix.
#
# Probe semantics, measured against tmux 3.5a:
#   server, >=1 session -> exit 0
#   server, 0 sessions  -> exit 0                                    <- has-session
#                                                                       exits 1 here
#   no server at all    -> exit 1, "error connecting to <socket>"
#   stale socket        -> exit 1, "no server running on <socket>"
# `list-sessions` gives us an exit code that positively proves a server exists
# without parsing English, and — like has-session, unlike start-server — it never
# CREATES a server, so the probe cannot itself spawn the ao.service-parented
# server we are avoiding.
tmux_server_running() {
  command_exists tmux || return 2
  local out
  if tmux list-sessions >/dev/null 2>&1; then
    return 0
  fi
  # `|| true`: the script runs under `set -e`, and reaching here means tmux exited
  # non-zero. errexit happens to be suppressed today (the only caller uses `||`),
  # but a future caller that does not would abort the whole deploy on the ordinary,
  # expected "no server" path. Do not leave that to the call site.
  out="$(tmux list-sessions 2>&1 || true)"
  if grep -qiE 'permission denied|operation not permitted' <<<"${out}"; then
    return 2
  fi
  if grep -qiE 'error connecting|no server running' <<<"${out}"; then
    return 1
  fi
  return 2
}

# Hand the tmux server to ao-tmux.service (#293/D1) — but only when no server
# already owns the socket.
#
# tmux daemonizes its SERVER from whichever client first touches the socket, so a
# server spawned lazily by the daemon inherits ao.service's cgroup, and with it
# every pane, agent process and `npm test` child. Starting ao-tmux.service first
# means the server is created inside THAT unit's cgroup, and pane placement
# follows the server, never the client — so nothing in the fleet can land in
# ao.service's cgroup again.
#
# When a server is already running we must NOT start or restart the unit:
#   * `systemctl start` would run `tmux start-server`, which merely attaches to
#     the existing server and exits, leaving this Type=forking unit stuck in
#     `activating` until its start timeout; and
#   * `systemctl restart` would stop the unit — and stopping the unit signals the
#     server the whole fleet lives under (guard_fleet_fatal refuses that outright,
#     from anywhere in this script).
# The legacy server keeps running under ao.service (where KillMode=process still
# protects it) and ao-tmux.service takes ownership at the next REBOOT. That is
# reported, never failed: a deploy cannot migrate a live server, and refusing to
# deploy over one would be strictly worse.
#
# We do exactly one thing to that legacy server, and it is not destructive:
# prevent_legacy_tmux_drain() pins its `exit-empty off` (below).
#
# This skip is the OUTER layer only. It cannot be the whole answer, because
# ao.service Wants= the tmux unit: restarting the daemon makes systemd start the
# very unit we declined to start. The unit therefore guards ITSELF with an
# ExecCondition that skips cleanly when a server already owns the socket — see
# ops/ao-tmux.service.
ensure_tmux_server_unit() {
  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: start %s when no tmux server owns the default socket\n' "${tmux_unit}"
    return 0
  fi
  local state=0
  tmux_server_running || state=$?
  case "${state}" in
    0)
      log "A tmux server is already running; not starting ${tmux_unit} over it. ${tmux_unit} takes ownership of the socket at the next reboot."
      prevent_legacy_tmux_drain
      return 0
      ;;
    2)
      # We could not classify the socket. Starting the unit might create a SECOND
      # server; not starting it leaves the daemon to spawn one. Neither is a
      # decision a deploy should make blind, so do nothing and say so loudly.
      # ao.service's ExecStartPre refuses on the same signal, so a genuinely
      # broken tmux surfaces as a failed daemon rather than a silent D1.
      log "WARN: the tmux ownership probe FAILED (tmux is missing, or the default socket cannot be queried). NOT starting ${tmux_unit}: it could become a second server. ${ao_unit} will refuse to start until this is fixed (#293/D1)."
      return 0
      ;;
  esac
  log "No tmux server owns the default socket; starting ${tmux_unit} so it — not ${ao_unit} — owns the fleet's cgroup."
  run_best_effort systemctl --user start --no-block "${tmux_unit}"
}

# CLOSE the reacquisition window rather than race to fill it (#293, review cycle 3).
#
# The legacy server — the one running on the deploy host right now, and on any host
# mid-migration — carries tmux's DEFAULT `exit-empty on`: the server exits as soon
# as its last session closes. The moment it does, the socket goes free, and the ao
# daemon (already running, already issuing tmux commands) can win the race to that
# free socket and lazily spawn a replacement server inside ao.service's cgroup.
# That IS D1, recreated silently, hours after the deploy, with nobody watching.
# ao-tmux-claim.timer bounds that window to one tick; it cannot eliminate it, and
# ao.service's ExecStartPre does not help — it only runs when ao itself starts.
#
# So do not race the daemon for the socket. Make the socket never go free:
#
#   A server that cannot drain cannot hand the socket to anyone.
#
# `exit-empty off` on the legacy server means it stays alive with zero sessions, so
# the socket stays owned for the life of this boot, so no window ever opens. The
# migration then happens exactly where it is safe — at the next REBOOT, where
# ao-tmux.service (Before=ao.service, WantedBy=default.target) creates the server
# first and owns it from the start.
#
# THE ONE THING WE DO TO A LIVE 49-AGENT SERVER, AND WHY IT IS SAFE. This is a pure
# server-option write. Verified against tmux 3.5a on a scratch socket, not assumed:
#   * it starts nothing, stops nothing, kills nothing: sessions, windows, panes and
#     the server's PID are all untouched by the set;
#   * `exit-empty` lives in tmux's SERVER option table, and `-g` resolves into that
#     table (`show-options -s exit-empty` reads back `off` afterwards) — the same
#     spelling ao-tmux.service's ExecStart uses;
#   * with it off, closing the last session leaves the server ALIVE (same PID), and
#     a later `new-session` re-attaches to that server instead of spawning one;
#   * against a socket with NO server it just exits 1. Unlike `new-session` or
#     `start-server`, `set-option` cannot itself create the very server we are
#     trying to keep out of ao.service's cgroup.
# It is nonetheless issued ONLY on the "a server positively owns the socket" branch:
# on a socket we could not classify (probe state 2) we touch nothing at all.
#
# WHEN THE PIN FAILS: ADVISORY, BUT NEVER SILENT, AND NEVER "SUCCESS" (#293, review
# cycle 4). The `set-option` can fail — an unreachable or read-only socket, a server
# that died between the probe and this call, an option error on an older tmux. The
# status this function branches on is therefore the REAL exit status of that
# `set-option` (via run(), which propagates it); it is deliberately NOT routed
# through run_best_effort(), which returns 0 whatever happened and made this
# function's failure branch unreachable dead code for a whole review cycle.
#
# Advisory, not fatal, and the reasoning is that aborting buys nothing:
#   * a failed pin leaves the host EXACTLY where it was before the deploy ran — the
#     server is unpinned, as it has been every day until now. Failing the deploy
#     removes none of that risk; it only withholds the new code.
#   * the same code path runs on --rollback, so a hard failure here would make an
#     emergency rollback unrunnable because of a transient tmux error. Refusing to
#     roll back a broken daemon to protect against a drain that may never happen is
#     the worse trade.
#   * the deploy's own fleet risk is unchanged by the pin: the pin defends against a
#     LATER drain, not against anything this script is about to do.
# What a failed pin does buy is a lie if we let it print the success line. So it
# prints the failure in the failure's own words, names the manual cgroup check that
# is still required, and is re-stated at the END of the run (report_fleet_safety_
# warnings) so it cannot scroll away behind the restart output.
#
# The probe cannot tell a LEGACY server from one ${tmux_unit} already owns, and it
# does not need to: the pin is idempotent. On a migrated host ${tmux_unit}'s own
# ExecStart already set `exit-empty off`, so this is a no-op that re-asserts it;
# on the migration host it is the fix. Only the log line distinguishes them, and
# it asks systemd rather than guessing.
prevent_legacy_tmux_drain() {
  local owner="legacy (pre-${tmux_unit})"
  if systemctl --user is-active --quiet "${tmux_unit}" 2>/dev/null; then
    owner="${tmux_unit}-owned"
  fi
  local status=0
  # run(), not run_best_effort(): this branch needs the set-option's REAL status.
  run tmux set-option -g exit-empty off || status=$?
  if [[ "${status}" -eq 0 ]]; then
    # Under dry-run, run() returns 0 WITHOUT executing anything, so a factual
    # "Pinned" line here would be exactly the false success cycle 4 caught —
    # asserting a state we never established. Say what a dry run actually knows.
    if [[ "${dry_run}" == "1" ]]; then
      printf 'DRY-RUN: would pin exit-empty=off on the %s tmux server\n' "${owner}"
      return 0
    fi
    log "Pinned exit-empty=off on the ${owner} tmux server: it can no longer exit when its last session closes, so it can never free the socket for ${ao_unit} to grab. ${tmux_unit} takes the socket at the next reboot."
    return 0
  fi
  tmux_drain_pin_failed=1
  log "WARN: the ${owner} tmux server could NOT be pinned (\`tmux set-option -g exit-empty off\` exited ${status}). This deploy did NOT confirm the #293/D1 reacquisition race is closed."
  # A failed set-option proves only that THIS RUN could not set or confirm the
  # option. It does not prove the server is exit-empty=on — a previous deploy may
  # already have pinned it. State the unconfirmed state, not a state we did not read.
  log "WARN:   * The server's exit-empty setting is UNCONFIRMED and may still be tmux's default (on). If it is on, then when its last session closes the server exits and frees the socket, and ${ao_unit} — already running, already issuing tmux commands — can spawn the next server inside its OWN cgroup. That is D1, live again, hours later, with nobody watching."
  log "WARN:   * ${tmux_claim_timer} still races for the freed socket and a reboot fixes it for good, but neither is a guarantee."
  log "WARN:   * The manual pre-deploy cgroup check REMAINS NECESSARY until this host reboots into ${tmux_unit}: confirm the tmux server is not in ${ao_unit}'s cgroup before the next deploy — cat /proc/\$(pgrep -f 'tmux.*server' | head -1)/cgroup."
  return 0
}

# Re-state, at the very end of a deploy or rollback, any fleet-safety property this
# run FAILED to establish (#293, review cycle 4). A warning printed before twenty
# restart lines is a warning nobody reads, and the last line of a deploy is the one
# a human acts on — it must not read like a clean run when it was not.
#
# This does not change the exit status: these are things that were ALREADY true of
# the host before the deploy and that the deploy could not improve (see
# prevent_legacy_tmux_drain), not things the deploy broke. Exiting non-zero would
# report a failed deploy that in fact succeeded, and would trip callers into rolling
# back a good release.
report_fleet_safety_warnings() {
  if [[ "${tmux_drain_pin_failed}" != "1" ]]; then
    return 0
  fi
  log "UNRESOLVED (#293/D1): the tmux server could NOT be pinned with exit-empty=off during this run. The fleet's tmux server can still drain and hand its socket to ${ao_unit}. Re-run once tmux is reachable, or reboot into ${tmux_unit}; until then the manual pre-deploy cgroup check remains necessary."
}

# Belt and braces for the ONE case the drain pin cannot cover (#293, review cycle 3).
#
# With prevent_legacy_tmux_drain() in place the socket no longer goes free by
# DRAINING. It can still go free by the server DYING: a crash, a segfault, an OOM
# kill, `systemctl --user kill`, a hand-run `tmux kill-server`. In that state
# ao-tmux.service is not running and was never started (its ExecCondition SKIPPED
# it while the legacy server held the socket), and a skipped unit is never retried
# — Restart= only reacts to a started process exiting. So nothing would start it,
# and the daemon's next `tmux new-session` would spawn the replacement server in
# ao.service's cgroup: D1, again.
#
# That is what this timer is for, and it is now its ONLY job. Note what it is NOT:
# it is not a rescue of a live fleet — if the server died, every agent pane died
# with it. It exists so the NEXT server is created in the right cgroup instead of
# the daemon's, without waiting for a human or a reboot.
#
# `systemctl enable` on a timer only links it for the NEXT boot, and the death we
# are covering can happen at any moment of THIS one — so the timer has to be running
# now. Restarting a timer is not a fleet operation (it triggers
# ao-tmux-claim.service, which only ever `start`s the tmux unit), so unlike
# ${tmux_unit} it is safe to converge on every deploy.
ensure_tmux_claim_timer() {
  run_best_effort systemctl --user restart "${tmux_claim_timer}"
}

# Classify the sudo PAM warnings that appear under ao.service after a restart
# (#293/D2, from #295).
#
# THE EMITTER IS NOT AO. `sudo` appears nowhere in this repo's deploy, ops, or
# backend surface. The warnings come from AGENT processes that the D1 cgroup bug
# mis-parented into ao.service's cgroup, and they are two very different things:
#
#   * `sudo -n true` — a NON-interactive capability probe the agent harnesses run
#     (it also shows up under session scopes and tmux-spawn scopes, wherever an
#     agent runs). `-n` tells sudo never to prompt, and pam_unix logs
#     "conversation failed" precisely BECAUSE it refused to prompt. It cannot
#     hang. On this host it accounted for 722 of the lines.
#   * a genuinely interactive `sudo -- sh -c "apt-get install …"` — Playwright's
#     browser-dependency install, run by a worker agent. THAT is the latent hang
#     #295 was worried about, and it is agent behavior, not daemon behavior.
#
# So the fix is not to suppress a log line: it is D1 (the agent fleet no longer
# lives in ao.service's cgroup, so neither class can be attributed to — or block —
# the daemon service). What deploy owes the operator is an honest classification:
# a bounded, documented count of the harmless probes, and the ACTUAL COMMAND LINE
# of anything interactive. Advisory, never fatal: an agent's install choice must
# not be able to fail a production deploy.
verify_ao_sudo_warnings() {
  local since="$1"
  if [[ "${dry_run}" == "1" ]]; then
    log "DRY-RUN: would classify sudo PAM warnings under ${ao_unit} since ${since}"
    return 0
  fi
  if ! command_exists journalctl || ! command_exists node; then
    log "WARN: journalctl or node unavailable; skipping the ${ao_unit} sudo warning scan."
    return 0
  fi

  # Read the journal FIRST, on its own, and check that it actually worked. Piping
  # journalctl straight into node under `set -o pipefail` with a trailing
  # `|| true` made a permission-denied / corrupt-journal failure indistinguishable
  # from a clean host: no entries, no error, "0 warnings" (#293, codex review of
  # #309). An unreadable journal means the classification is UNAVAILABLE — say so.
  local entries
  if ! entries="$(journalctl --user-unit "${ao_unit}" _COMM=sudo --since "${since}" -o json --no-pager 2>&1)"; then
    log "WARN: ${ao_unit}: sudo warning classification unavailable — the journal query failed (${entries%%$'\n'*}). This is NOT a clean result: the scan was skipped, not passed."
    return 0
  fi

  local report noninteractive interactive
  report="$(printf '%s' "${entries}" | node -e '
let body = "";
process.stdin.on("data", (chunk) => (body += chunk));
process.stdin.on("end", () => {
  let probes = 0;
  const interactive = new Map();
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const msg = String(entry.MESSAGE || "");
    if (!/pam_unix\(sudo:auth\)/.test(msg)) continue;
    const cmd = String(entry._CMDLINE || "");
    // `-n` anywhere in the option run before the command means non-interactive.
    if (/^sudo\s+(?:-\w+\s+)*-n(?:\s|$)/.test(cmd) || /\s-n\s/.test(cmd)) {
      probes += 1;
      continue;
    }
    interactive.set(cmd, (interactive.get(cmd) || 0) + 1);
  }
  const named = [...interactive.entries()].map(([cmd, n]) => `${n}x ${cmd.slice(0, 160)}`);
  process.stdout.write(`${probes}\t${named.join(" | ")}`);
});
' 2>/dev/null)" || {
    log "WARN: ${ao_unit}: sudo warning classification unavailable — the classifier could not read the journal output. This is NOT a clean result: the scan was skipped, not passed."
    return 0
  }

  noninteractive="${report%%$'\t'*}"
  interactive="${report#*$'\t'}"
  [[ -n "${noninteractive}" ]] || return 0

  if [[ "${noninteractive}" != "0" ]]; then
    log "${ao_unit}: ${noninteractive} non-interactive sudo probe warning(s) since restart (\`sudo -n\` capability probes from agent harnesses). Expected: \`-n\` means they cannot prompt and cannot hang; pam_unix logs 'conversation failed' precisely because sudo refused to prompt."
  fi
  if [[ -n "${interactive//[[:space:]]/}" ]]; then
    log "WARN: ${ao_unit}: interactive sudo attributed to the daemon service: ${interactive}"
    log "WARN: this is an AGENT-side install (typically Playwright browser deps), not ao — ao itself never shells out to sudo. It can only reach this cgroup while a pre-${tmux_unit} tmux server is still parented under ${ao_unit} (see #293/D1); it disappears once the host reboots and ${tmux_unit} owns the server."
  fi
}

# Report whether the D1 invariant actually holds on this host: no agent/worker
# process may live in ao.service's cgroup. This is the manual pre-deploy ritual
# (`/proc/$(pgrep -f 'tmux.*server')/cgroup`) turned into an automatic, always-run
# check. Advisory by design — a legacy server predating ao-tmux.service cannot be
# migrated by a deploy, and failing the deploy over it would block the very
# release that fixes it.
verify_ao_cgroup_is_daemon_only() {
  if [[ "${dry_run}" == "1" ]]; then
    log "DRY-RUN: would verify no agent/worker processes share the ${ao_unit} cgroup"
    return 0
  fi
  command_exists systemctl || return 0
  local cgroup procs pid comm leftovers=""
  cgroup="$(systemctl --user show "${ao_unit}" --property=ControlGroup --value 2>/dev/null || true)"
  [[ -n "${cgroup}" ]] || return 0
  procs="/sys/fs/cgroup${cgroup}/cgroup.procs"
  [[ -r "${procs}" ]] || return 0

  local main_pid
  main_pid="$(systemctl --user show "${ao_unit}" --property=MainPID --value 2>/dev/null || true)"
  while IFS= read -r pid; do
    [[ -n "${pid}" && "${pid}" != "${main_pid}" ]] || continue
    comm="$(cat "/proc/${pid}/comm" 2>/dev/null || true)"
    [[ -n "${comm}" ]] || continue
    leftovers+="${comm} "
  done < "${procs}"

  if [[ -z "${leftovers}" ]]; then
    log "${ao_unit} cgroup holds the daemon only; the agent fleet is outside it (#293/D1 invariant holds)."
    return 0
  fi
  log "WARN: ${ao_unit} cgroup still holds non-daemon processes: ${leftovers%% }"
  log "WARN: these predate ${tmux_unit} owning the tmux server. ${ao_unit} keeps KillMode=process so a restart of the daemon cannot kill them, but the structural escape only lands when the host reboots and ${tmux_unit} creates the server itself. (A direct cgroup kill of ${ao_unit} — systemctl kill, an OOM kill, host shutdown — would still take them with it.)"
}

restart_unit() {
  local unit="$1"
  run systemctl --user restart "${unit}"
}

render_release_units() {
  local release_dir="$1"
  local unit_dir="${release_dir}/systemd"
  local source_ops="${release_dir}/source/ops"
  local escaped_current="${current_link//\\/\\\\}"
  local unit
  escaped_current="${escaped_current//&/\\&}"
  escaped_current="${escaped_current//|/\\|}"
  run mkdir -p "${unit_dir}"

  local dropin
  for unit in "${ao_unit}" "${tmux_unit}" "${tmux_claim_unit}" "${tmux_claim_timer}" "${web_unit}" "${notifier_unit}" "${attention_reply_unit}"; do
    if [[ "${dry_run}" == "1" ]]; then
      printf 'DRY-RUN: render %s -> %s\n' "${source_ops}/${unit}" "${unit_dir}/${unit}"
    else
      if [[ ! -f "${source_ops}/${unit}" ]]; then
        printf 'Refusing to deploy: unit template missing from staged source: %s\n' "${source_ops}/${unit}" >&2
        return 1
      fi
      sed "s|%h/.ao/deploy/current|${escaped_current}|g" "${source_ops}/${unit}" > "${unit_dir}/${unit}"
    fi

    # Render the unit's tracked drop-ins alongside it, through the same %h
    # substitution, so `current/systemd/` is a complete picture of what the host
    # should be running (#293 H4).
    while IFS= read -r dropin; do
      [[ -n "${dropin}" ]] || continue
      if [[ "${dry_run}" == "1" ]]; then
        printf 'DRY-RUN: render %s -> %s\n' "${source_ops}/${unit}.d/${dropin}" "${unit_dir}/${unit}.d/${dropin}"
        continue
      fi
      mkdir -p "${unit_dir}/${unit}.d"
      sed "s|%h/.ao/deploy/current|${escaped_current}|g" "${source_ops}/${unit}.d/${dropin}" > "${unit_dir}/${unit}.d/${dropin}"
    done < <(unit_dropin_names "${source_ops}" "${unit}")
  done
}

# Rewrite a unit so it cannot hand the daemon prime activation.
#
# Only the daemon (ao.service) reads AO_PRIME_*, so only it is checked strictly.
# Refusing a unit that cannot activate prime would abort an emergency rollback for
# no gain, and a bricked rollback is a worse outcome than a stale one.
#
# Lines are folded into systemd's *logical* lines first — a trailing backslash
# continues a directive and systemd skips blank/comment lines inside it — so a
# directive is judged the way systemd reads it, not the way it happens to be typed.
#
# Scope. This closes the way prime actually got switched on: a plain Environment=
# directive baked into a unit that deploy or rollback then reinstalls. It is NOT a
# security boundary against a hostile unit author — a wrapper that assembles the
# variable name at runtime, a systemd drop-in, or the user manager's own environment
# all set variables from outside this file, and no amount of scanning the file sees
# them. Enforcement against a bad *commit* lives in CI (the template guards in
# deploy.test.mjs); this function only makes sure deploy and rollback cannot replay a
# prime-activating payload that already exists on disk.
#
# Rules for the daemon unit:
#   - Environment=: all assignments AO_PRIME_*  -> drop the directive.
#   -               mixes prime with other vars -> refuse (dropping it would silently
#                   strip a required variable; rewriting risks corrupting one).
#   -               cannot be tokenized (backslash escape, single quote, unbalanced
#                   quote) -> refuse. `A\x4f_PRIME_...` decodes to the real variable
#                   name, so an unparseable environment directive is never assumed
#                   innocent. Every unit on the host parses cleanly.
#   - ExecStart= carrying a backslash -> refuse; it could decode into the variable
#     (`/usr/bin/env A\x4f_PRIME_...=x`). No real unit has one.
#   - EnvironmentFile= -> drop. Its contents are outside this repo. The shipped daemon
#     unit has none (CI enforces that) and no payload on the host has one, so this is
#     a no-op in practice rather than a way to lose required config.
#   - Everything else is left exactly as written. In particular a backslash in a
#     Description= or a comment is not a reason to refuse a unit.
sanitize_unit() {
  local src="$1"
  local strict="$2"
  awk -v strict="${strict}" -v src="${src}" '
    # Split an Environment= value into assignments, honouring systemd double quotes
    # and tab separators. Returns -1 when the value cannot be parsed unambiguously,
    # so the caller can refuse rather than guess.
    function tokenize(rest, toks,   i, c, cur, inq, n) {
      n = 0; cur = ""; inq = 0
      for (i = 1; i <= length(rest); i++) {
        c = substr(rest, i, 1)
        if (c == "\\" || c == "'"'"'") return -1     # escapes / single quotes: do not guess
        if (c == "\"") { inq = !inq; continue }
        if ((c == " " || c == "\t") && !inq) { if (cur != "") toks[++n] = cur; cur = ""; continue }
        cur = cur c
      }
      if (inq) return -1                            # unbalanced quote
      if (cur != "") toks[++n] = cur
      return n
    }
    function refuse(why) {
      printf "Refusing to install %s: %s. Prime activation is operator-only.\n", src, why > "/dev/stderr"
      exit 1
    }
    function emit(line,   n, i, toks, primes, rest) {
      if (line ~ /^[ \t]*EnvironmentFile=/) {
        if (strict == 1) return                     # contents are outside our view
        if (line ~ /AO_PRIME_/) return
        print line
        return
      }
      if (line ~ /^[ \t]*Environment=/) {
        match(line, /^[ \t]*Environment=/)
        rest = substr(line, RLENGTH + 1)
        n = tokenize(rest, toks)
        if (n < 0) {
          if (strict == 1) refuse("an Environment= directive uses escaping we cannot verify")
          print line
          return
        }
        primes = 0
        for (i = 1; i <= n; i++) if (toks[i] ~ /^AO_PRIME_/) primes++
        if (primes == 0) { print line; return }
        if (primes == n) return                     # the whole directive was prime
        if (strict == 1) refuse("an Environment= directive mixes prime activation with other variables")
        print line
        return
      }
      # An escape here could decode into the activating variable name.
      if (strict == 1 && line ~ /^[ \t]*ExecStart=/ && line ~ /\\/)
        refuse("its ExecStart= uses backslash escapes we cannot verify")
      print line
    }
    {
      sub(/\r$/, "")                                # tolerate CRLF payloads
      if (cont) {
        if ($0 ~ /^[ \t]*$/ || $0 ~ /^[ \t]*[#;]/) next   # systemd skips these inside a continuation
        sub(/^[ \t]+/, "")
        logical = logical " " $0
      } else {
        logical = $0
      }
      if (logical ~ /\\$/) { sub(/[ \t]*\\$/, "", logical); cont = 1; next }
      cont = 0
      emit(logical)
      logical = ""
    }
    END { if (logical != "") emit(logical) }
  ' "${src}"
}

# True when the daemon unit provably cannot activate prime. Comments may name the
# variables, and UnsetEnvironment= removes them rather than setting them; anything
# else still naming AO_PRIME_ is syntax we did not model and must not be installed.
#
# Deliberately a single awk rather than `grep -v ... | grep -q ...`: in that pipeline
# the downstream grep exits as soon as it matches, the upstream grep then dies of
# SIGPIPE (141), and under `set -o pipefail` the pipeline reports failure -- which the
# leading `!` would invert into "prime-free" for a unit that DOES activate prime.
unit_is_prime_free() {
  ! awk '
    /^[[:space:]]*[#;]/ { next }
    /^[[:space:]]*UnsetEnvironment=/ { next }
    /AO_PRIME_/ { found = 1; exit }
    END { exit(found ? 0 : 1) }
  ' "$1"
}

# Sanitize a unit into ${dst}, or fail without touching ${dst}.
stage_unit_file() {
  local src="$1"
  local dst="$2"
  local unit="$3"
  local strict=0
  [[ "${unit}" == "${ao_unit}" ]] && strict=1

  if ! sanitize_unit "${src}" "${strict}" > "${dst}"; then
    return 1
  fi
  # Only the daemon can act on AO_PRIME_*, so only it fails closed.
  if [[ "${strict}" == "1" ]] && ! unit_is_prime_free "${dst}"; then
    printf 'Refusing to install %s: it still activates prime after sanitizing (unrecognized syntax in %s). Prime activation is operator-only.\n' \
      "${unit}" "${src}" >&2
    return 1
  fi
  chmod 644 "${dst}"
}

# Install one unit, dropping any setting that would hand the daemon prime activation.
install_unit_file() {
  local src="$1"
  local dst="$2"
  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: %s\n' "$(quote_cmd cp "${src}" "${dst}")"
    return 0
  fi
  local tmp
  tmp="$(mktemp "${dst}.XXXXXX")"
  if ! stage_unit_file "${src}" "${tmp}" "$(basename -- "${dst}")"; then
    rm -f -- "${tmp}"
    return 1
  fi
  if ! mv -Tf "${tmp}" "${dst}"; then
    rm -f -- "${tmp}"
    return 1
  fi
}

# Put a snapshot of the previously installed units back after a failed commit.
#
# The snapshot is re-sanitized on the way in. A host that has not yet taken this fix
# has a PRIME-BAKED ao.service installed, so restoring the snapshot verbatim would
# replay the very activation this code exists to stop — the restore path is an
# install path and gets the same guarantee. A unit absent from the snapshot did not
# exist before the commit, so remove it rather than leaving it stranded.
restore_units() {
  local backup="$1"
  shift
  local unit tmp
  for unit in "$@"; do
    if [[ -L "${backup}/${unit}" ]]; then
      # A masked/symlinked unit has no content to sanitize — put the link back as it was.
      rm -f -- "${systemd_user_dir}/${unit}"
      cp -a "${backup}/${unit}" "${systemd_user_dir}/${unit}" || printf 'Could not restore %s\n' "${unit}" >&2
      continue
    fi
    if [[ -f "${backup}/${unit}" ]]; then
      if ! tmp="$(mktemp "${systemd_user_dir}/${unit}.XXXXXX")"; then
        printf 'Could not restore %s\n' "${unit}" >&2
        continue
      fi
      if stage_unit_file "${backup}/${unit}" "${tmp}" "${unit}" && mv -Tf "${tmp}" "${systemd_user_dir}/${unit}"; then
        continue
      fi
      rm -f -- "${tmp}"
      # The unit now installed was validated prime-free, so leaving it is safe.
      printf 'Could not restore %s; leaving the newly installed unit in place\n' "${unit}" >&2
    else
      rm -f -- "${systemd_user_dir}/${unit}" 2>/dev/null || true
    fi
  done
}

# Sanitize and validate EVERY unit before installing ANY of them, so a refusal
# cannot leave the host with a half-updated set of units.
#
# Units the ACTIVE PAYLOAD does not ship are skipped, not fatal (#293). This runs
# AFTER the release pointer has already been flipped, so on a rollback to a release
# that predates a newly-introduced unit — every pre-#293 release has no
# ao-tmux.service — a hard failure here aborted the emergency rollback in a
# half-switched state: `current` and the CLI already on the old release, the units
# still the new ones. Breaking the recovery path is strictly worse than carrying a
# unit an older payload never knew about, so the installed unit is left as it is
# (for ao-tmux.service that is also the safe answer: it is release-independent).
install_units_from_current() {
  run mkdir -p "${systemd_user_dir}"
  local all_units=("${ao_unit}" "${tmux_unit}" "${tmux_claim_unit}" "${tmux_claim_timer}" "${web_unit}" "${notifier_unit}" "${attention_reply_unit}")
  local units=()
  local unit

  for unit in "${all_units[@]}"; do
    if [[ "${dry_run}" == "1" || -f "${current_link}/systemd/${unit}" ]]; then
      units+=("${unit}")
    else
      log "WARN: the active release ships no ${unit}; keeping the installed unit as-is (this release predates it)."
    fi
  done

  if [[ "${dry_run}" == "1" ]]; then
    for unit in "${units[@]}"; do
      printf 'DRY-RUN: %s\n' "$(quote_cmd cp "${current_link}/systemd/${unit}" "${systemd_user_dir}/${unit}")"
    done
  else
    local staged=()
    local tmp
    local failed=0
    for unit in "${units[@]}"; do
      # A mktemp failure must not strand the temps already staged.
      if ! tmp="$(mktemp "${systemd_user_dir}/${unit}.XXXXXX")"; then
        failed=1
        break
      fi
      staged+=("${tmp}")
      if ! stage_unit_file "${current_link}/systemd/${unit}" "${tmp}" "${unit}"; then
        failed=1
        break
      fi
    done
    if (( failed )); then
      [[ ${#staged[@]} -gt 0 ]] && rm -f -- "${staged[@]}"
      return 1
    fi

    # Every unit is validated by here. Snapshot whatever is installed so a failure
    # part-way through the commit restores the previous set rather than leaving a
    # new daemon unit beside an old web unit.
    local backup
    if ! backup="$(mktemp -d)"; then
      rm -f -- "${staged[@]}"
      return 1
    fi
    for unit in "${units[@]}"; do
      # -L before -e: a MASKED unit is a symlink to /dev/null, and `-f` follows the
      # link to a character device, reporting the unit as absent. Snapshot the link
      # itself (cp -a) so a restore can put the mask back instead of deleting it.
      if [[ -L "${systemd_user_dir}/${unit}" || -e "${systemd_user_dir}/${unit}" ]]; then
        if ! cp -a "${systemd_user_dir}/${unit}" "${backup}/${unit}"; then
          rm -f -- "${staged[@]}"
          rm -rf -- "${backup}"
          return 1
        fi
      fi
    done

    local i=0
    for unit in "${units[@]}"; do
      if ! mv -Tf "${staged[i]}" "${systemd_user_dir}/${unit}"; then
        printf 'Failed to install %s; restoring the previous units\n' "${unit}" >&2
        restore_units "${backup}" "${units[@]}"
        rm -f -- "${staged[@]}"
        rm -rf -- "${backup}"
        return 1
      fi
      i=$((i + 1))
    done
    rm -rf -- "${backup}"
  fi

  install_unit_dropins "${units[@]}"

  run systemctl --user daemon-reload
  # Enable what is actually installed. `systemctl enable` on a unit with no unit
  # file fails, and after a rollback to a payload that predates a unit the only
  # thing on disk may be the previously-installed file — which is still the one to
  # enable. -f follows the symlink, so a MASKED unit (-> /dev/null) is excluded
  # rather than turned into a hard deploy failure.
  #
  # …and only what is ENABLEABLE. A unit with no [Install] section cannot be
  # enabled: systemd prints a five-line "no installation config" complaint and
  # exits 0, so nothing fails — it just becomes permanent deploy noise.
  # ao-tmux-claim.service is such a unit (its .timer starts it; no target wants
  # it). The check reads the file rather than hardcoding a name, so a future
  # timer- or socket-activated unit is handled the day it lands.
  local enable_units=()
  for unit in "${all_units[@]}"; do
    if [[ "${dry_run}" == "1" || -f "${systemd_user_dir}/${unit}" ]]; then
      unit_is_enableable "${unit}" && enable_units+=("${unit}")
    fi
  done
  if (( ${#enable_units[@]} > 0 )); then
    run systemctl --user enable "${enable_units[@]}"
  fi
}

# Ownership ledger for the drop-ins this deploy installed into a unit's drop-in
# dir. systemd only reads `*.conf` from that dir, so a dot-prefixed ledger sits
# there inertly, next to the files it describes, and survives a rollback the same
# way the units do.
#
# OWNERSHIP IS CONTENT-ADDRESSED, NOT NAME-ADDRESSED (#293, review cycle 2). Each
# line is `<sha256>  <name.conf>` — the hash of the bytes deploy actually
# installed. Tracking names alone let deploy claim a file it never wrote: an
# operator's pre-existing `override.conf` was silently overwritten on the first
# deploy and RECORDED AS OURS, so a later release that retired that name deleted
# their file. Deploy owns a name only while the bytes on disk are still its bytes.
dropin_ledger() {
  printf '%s/%s.d/.ao-deploy-owned' "${systemd_user_dir}" "$1"
}

# Names deploy installed into ${unit}.d on the last convergence. Empty when the
# ledger is absent (a host that predates it), which is the safe answer: an
# unrecorded file is treated as somebody else's and left alone.
dropin_owned_names() {
  local ledger
  ledger="$(dropin_ledger "$1")"
  [[ -f "${ledger}" ]] || return 0
  awk 'NF == 2 && $2 ~ /^[^\/]+\.conf$/ { print $2 }' "${ledger}"
}

# The hash deploy recorded for ${unit}.d/${name}; empty when it never wrote it.
dropin_owned_hash() {
  local ledger
  ledger="$(dropin_ledger "$1")"
  [[ -f "${ledger}" ]] || return 0
  awk -v name="$2" 'NF == 2 && $2 == name { print $1; exit }' "${ledger}"
}

file_sha256() {
  [[ -f "$1" ]] || return 1
  local out
  out="$(sha256sum -- "$1" 2>/dev/null)" || return 1
  printf '%s' "${out%% *}"
}

# Never destroy a file at a managed drop-in name that deploy did not write.
#
# Two cases, one test: the bytes on disk are not the bytes we recorded. Either the
# operator hand-placed the file before deploy ever ran (unrecorded), or they edited
# the one deploy installed (recorded, but changed). In both, the file is about to
# be overwritten by an install or deleted by a retirement, and in both it is theirs.
#
# We back it up and warn rather than refusing the deploy: the release's drop-in is
# part of the unit definition and must reach the host (that is #293/H4), so a stale
# hand-placed file cannot be allowed to wedge production. But if the BACKUP itself
# fails we do refuse — proceeding would be the silent data loss this exists to stop,
# and a directory we cannot write to is broken in a way a deploy must not paper over.
# The backup keeps the operator's bytes and drops the `.conf` suffix, so systemd
# ignores it and it cannot come back as live config.
preserve_unmanaged_dropin() {
  local unit="$1" name="$2" path="$3"
  [[ -e "${path}" ]] || return 0

  local recorded actual backup
  recorded="$(dropin_owned_hash "${unit}" "${name}")"
  actual="$(file_sha256 "${path}" || true)"
  if [[ -n "${recorded}" && -n "${actual}" && "${recorded}" == "${actual}" ]]; then
    return 0
  fi

  backup="${path}.operator-backup.$(date -u +%Y%m%dT%H%M%SZ)"
  if ! cp -p -- "${path}" "${backup}"; then
    printf 'Refusing to deploy: %s.d/%s was not written by deploy (hand-placed or hand-edited) and it could not be backed up to %s. Deploy will not overwrite or delete a file it does not own.\n' \
      "${unit}" "${name}" "${backup}" >&2
    return 1
  fi
  log "WARN: ${unit}.d/${name} is not the file deploy installed (hand-placed or hand-edited). Preserved a copy at ${backup}; the release's own definition now takes that name (#293)."
}

# Converge each unit's drop-in dir with the release's. Drop-ins go through the
# same prime sanitizer as the units themselves (an `Environment=AO_PRIME_*` in a
# drop-in activates prime exactly as one in the unit body would), and drop-ins
# the release no longer ships are removed so a retired override cannot outlive
# the commit that deleted it (#293 H4).
#
# Removal is scoped by OWNERSHIP, never by glob (#293, codex review of #309). The
# old `rm -f <unit>.d/*.conf` deleted every drop-in in the dir — including files
# deploy never wrote: an operator's `10-local-port.conf`, a resource-limit
# override, anything a human put there — and the unconditional service restart
# then applied the loss immediately and silently. Only names this deploy recorded
# as its own are eligible for removal; everything else survives untouched.
install_unit_dropins() {
  local unit dropin dst_dir src_dir tmp ledger owned shipped
  for unit in "$@"; do
    src_dir="${current_link}/systemd/${unit}.d"
    dst_dir="${systemd_user_dir}/${unit}.d"

    if [[ "${dry_run}" == "1" ]]; then
      while IFS= read -r dropin; do
        [[ -n "${dropin}" ]] || continue
        printf 'DRY-RUN: %s\n' "$(quote_cmd cp "${src_dir}/${dropin}" "${dst_dir}/${dropin}")"
      done < <(unit_dropin_names "${current_link}/systemd" "${unit}")
      continue
    fi

    ledger="$(dropin_ledger "${unit}")"
    shipped=""
    if [[ -d "${src_dir}" ]]; then
      shipped="$(unit_dropin_names "${current_link}/systemd" "${unit}")"
    fi

    # Retire only the previously-installed drop-ins this release no longer ships —
    # and only after making sure the bytes there are still the bytes we installed.
    # An operator who edited a managed drop-in gets their version preserved instead
    # of deleted (the retired name still stops being active: that is the H4 fix).
    while IFS= read -r owned; do
      [[ -n "${owned}" ]] || continue
      grep -qxF "${owned}" <<<"${shipped}" && continue
      preserve_unmanaged_dropin "${unit}" "${owned}" "${dst_dir}/${owned}" || return 1
      rm -f -- "${dst_dir}/${owned}"
    done < <(dropin_owned_names "${unit}")

    if [[ -z "${shipped}" ]]; then
      rm -f -- "${ledger}"
      # Prune the dir only when nothing else lives in it. An operator drop-in keeps
      # it — and rmdir MUST NOT be able to fail the deploy for exactly that reason.
      if [[ -d "${dst_dir}" ]]; then
        rmdir "${dst_dir}" 2>/dev/null || true
      fi
      continue
    fi

    mkdir -p "${dst_dir}"
    while IFS= read -r dropin; do
      [[ -n "${dropin}" ]] || continue
      # A file already sitting at a name this release ships is only ours to
      # overwrite if we wrote it and nobody touched it since.
      preserve_unmanaged_dropin "${unit}" "${dropin}" "${dst_dir}/${dropin}" || return 1
      if ! tmp="$(mktemp "${dst_dir}/${dropin}.XXXXXX")"; then
        printf 'Refusing to deploy: could not stage drop-in %s\n' "${unit}.d/${dropin}" >&2
        return 1
      fi
      if ! stage_unit_file "${src_dir}/${dropin}" "${tmp}" "${unit}" || ! mv -Tf "${tmp}" "${dst_dir}/${dropin}"; then
        rm -f -- "${tmp}"
        printf 'Refusing to deploy: could not install drop-in %s\n' "${unit}.d/${dropin}" >&2
        return 1
      fi
    done <<<"${shipped}"

    # Record what we now own — the NAME and the HASH OF THE BYTES WE WROTE — and do
    # it AFTER installing: a crash mid-install leaves the older ledger, which
    # under-claims (leaks a file) rather than over-claims (deletes a stranger's).
    # The hash is what a later deploy re-checks before overwriting or retiring the
    # name, so an operator's edit can never be mistaken for our own file.
    while IFS= read -r dropin; do
      [[ -n "${dropin}" ]] || continue
      printf '%s  %s\n' "$(file_sha256 "${dst_dir}/${dropin}" || true)" "${dropin}"
    done <<<"${shipped}" > "${ledger}"
  done
}

backup_pre_hermetic_host() {
  if [[ -L "${current_link}" ]]; then
    return 0
  fi
  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: backup pre-hermetic ao binary and units into %s\n' "${pre_hermetic_dir}"
    return 0
  fi
  if [[ -e "${pre_hermetic_dir}/MANIFEST" ]]; then
    return 0
  fi
  mkdir -p "${pre_hermetic_dir}/systemd"
  if [[ -f "${ao_bin}" && ! -L "${ao_bin}" ]]; then
    cp -p "${ao_bin}" "${pre_hermetic_dir}/ao"
  fi
  local unit copied=0
  for unit in "${ao_unit}" "${tmux_unit}" "${tmux_claim_unit}" "${tmux_claim_timer}" "${web_unit}" "${notifier_unit}" "${attention_reply_unit}"; do
    if [[ -f "${systemd_user_dir}/${unit}" ]]; then
      cp -p "${systemd_user_dir}/${unit}" "${pre_hermetic_dir}/systemd/${unit}"
      copied=$((copied + 1))
    fi
  done
  printf 'ao_bin=%s\nunits=%s\n' "${ao_bin}" "${copied}" > "${pre_hermetic_dir}/MANIFEST"
  log "Backed up pre-hermetic deploy state in ${pre_hermetic_dir}"
}

rollback_pre_hermetic() {
  local pre_sessions="$1"
  if [[ "${dry_run}" != "1" && ! -f "${pre_hermetic_dir}/ao" ]]; then
    printf 'Rollback release not found: %s (no previous release and no pre-hermetic ao backup at %s)\n' "${previous_link}" "${pre_hermetic_dir}/ao" >&2
    return 1
  fi
  if [[ "${dry_run}" != "1" && ! -f "${pre_hermetic_dir}/systemd/${ao_unit}" ]]; then
    printf 'Pre-hermetic rollback cannot restart ao: no backed-up %s in %s\n' "${ao_unit}" "${pre_hermetic_dir}/systemd" >&2
    return 1
  fi
  log "Rolling back to pre-hermetic ao binary and units from ${pre_hermetic_dir}"
  run mkdir -p "$(dirname "${ao_bin}")" "${systemd_user_dir}"
  run cp "${pre_hermetic_dir}/ao" "${ao_bin}.tmp"
  run mv -Tf "${ao_bin}.tmp" "${ao_bin}"
  run rm -f "${current_link}" "${previous_link}"
  local unit
  for unit in "${ao_unit}" "${tmux_unit}" "${tmux_claim_unit}" "${tmux_claim_timer}" "${web_unit}" "${notifier_unit}" "${attention_reply_unit}"; do
    if [[ ! -f "${pre_hermetic_dir}/systemd/${unit}" ]] &&
      [[ "${unit}" == "${tmux_unit}" || "${unit}" == "${tmux_claim_unit}" || "${unit}" == "${tmux_claim_timer}" ]]; then
      # THE FLEET LIVES IN ao-tmux.service's CGROUP. A pre-hermetic backup taken
      # before that unit existed cannot contain it — which is the FIRST deploy from
      # any pre-#293 host — so the generic "not in the backup => disable --now and
      # remove" branch below would issue `disable --now` against the unit that owns
      # the tmux server and signal every agent pane. Absence from a backup is not
      # consent to kill the fleet.
      #
      # Keep these units instead. They are release-independent (they exec
      # /usr/bin/tmux and /usr/bin/systemctl, nothing under current/), so they stay
      # correct no matter how far back the binary is rolled — and removing them
      # would only hand the socket back to a daemon-spawned server, i.e. re-create
      # D1 during an emergency rollback. The claim timer goes with the unit: without
      # it, a rollback would silently disable the only path back to socket ownership.
      log "Keeping ${unit} installed and running: it predates this backup, and tearing it out re-exposes the fleet (#293/D1)."
      continue
    fi
    if [[ "${dry_run}" == "1" || -f "${pre_hermetic_dir}/systemd/${unit}" ]]; then
      install_unit_file "${pre_hermetic_dir}/systemd/${unit}" "${systemd_user_dir}/${unit}"
    elif [[ -f "${systemd_user_dir}/${unit}" ]]; then
      run systemctl --user disable --now "${unit}"
      run rm -f "${systemd_user_dir}/${unit}"
    fi
  done
  run systemctl --user daemon-reload
  if [[ "${dry_run}" != "1" ]]; then
    chmod +x "${ao_bin}"
  fi
  restart_unit "${ao_unit}"
  verify_after_restart "${pre_sessions}" "Pre-rollback session count unavailable (old daemon may be down)"
  for unit in "${web_unit}" "${notifier_unit}" "${attention_reply_unit}"; do
    if [[ "${dry_run}" == "1" || -f "${pre_hermetic_dir}/systemd/${unit}" ]]; then
      restart_unit "${unit}"
      verify_unit_active "${unit}" "${unit}"
    fi
  done
  [[ "${dry_run}" == "1" ]] || rm -f "${state_file}"
  log "Pre-hermetic rollback complete."
}

install_cli_link() {
  run mkdir -p "$(dirname "${ao_bin}")"
  run ln -sfn "${current_link}/bin/ao" "${ao_bin}.tmp"
  run mv -Tf "${ao_bin}.tmp" "${ao_bin}"
}

stage_release_source() {
  local head="$1" stage_dir="$2" source_dir="${stage_dir}/source"
  run mkdir -p "${release_root}"
  cleanup_stale_staging
  run rm -rf "${stage_dir}"
  run git clone --no-checkout "${repo_root}" "${source_dir}"
  run_in "${source_dir}" git checkout --detach "${head}"
  run_in "${source_dir}" git clean -ffdx
}

cleanup_stale_staging() {
  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: prune stale staging dirs in %s\n' "${release_root}"
    return 0
  fi
  [[ -d "${release_root}" ]] || return 0
  find "${release_root}" -mindepth 1 -maxdepth 1 -type d -name '.staging-*' -mmin +60 -prune -exec rm -rf {} +
}

copy_previous_web_dist_if_available() {
  local stage_dir="$1"
  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: reuse previous web dist when available\n'
    return 0
  fi
  if [[ -d "${current_link}/source/frontend/dist" ]]; then
    mkdir -p "${stage_dir}/source/frontend"
    cp -a "${current_link}/source/frontend/dist" "${stage_dir}/source/frontend/dist"
    return 0
  fi
  return 1
}

finalize_release_payload() {
  local stage_dir="$1"
  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: strip build-only git metadata and frontend dependencies from release payload\n'
    return 0
  fi
  rm -rf "${stage_dir}/source/.git" "${stage_dir}/source/frontend/node_modules"
}

activate_release() {
  local final_dir="$1"
  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: atomically point %s at %s\n' "${current_link}" "${final_dir}"
    return 0
  fi
  mkdir -p "${state_dir}"
  local old_current=""
  if [[ -L "${current_link}" ]]; then
    old_current="$(readlink -f "${current_link}" || true)"
  fi
  if [[ -n "${old_current}" && -d "${old_current}" ]]; then
    ln -sfn "${old_current}" "${previous_link}.tmp"
    mv -Tf "${previous_link}.tmp" "${previous_link}"
  fi
  ln -sfn "${final_dir}" "${current_link}.tmp"
  mv -Tf "${current_link}.tmp" "${current_link}"
}

prune_old_releases() {
  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: prune old releases in %s keeping %s plus current/previous\n' "${release_root}" "${release_retention}"
    return 0
  fi
  [[ -d "${release_root}" ]] || return 0
  local keep_current="" keep_previous="" seen=0 entry dir resolved
  [[ -L "${current_link}" ]] && keep_current="$(readlink -f "${current_link}" || true)"
  [[ -L "${previous_link}" ]] && keep_previous="$(readlink -f "${previous_link}" || true)"
  while IFS= read -r -d '' entry; do
    dir="${entry#*$'\t'}"
    resolved="$(readlink -f "${dir}" || true)"
    if [[ -n "${resolved}" && ( "${resolved}" == "${keep_current}" || "${resolved}" == "${keep_previous}" ) ]]; then
      continue
    fi
    seen=$((seen + 1))
    if (( seen > release_retention )); then
      rm -rf "${dir}"
    fi
  done < <(
    find "${release_root}" -mindepth 1 -maxdepth 1 -type d ! -name '.staging-*' -printf '%T@\t%p\0' |
      sort -z -rn
  )
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

env_file_has_nonempty_key() {
  local key="$1" value
  value="$(grep -E "^${key}=" "${slack_env_file}" | tail -n 1 | cut -d= -f2- || true)"
  value="${value%$'\r'}"
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  [[ -n "${value}" ]]
}

verify_slack_configured() {
  if [[ "${dry_run}" == "1" ]]; then
    log "DRY-RUN: would verify Slack notifier and reply config in ${slack_env_file}"
    return 0
  fi
  if [[ ! -r "${slack_env_file}" ]]; then
    printf 'Slack config %s is not readable; refusing to declare deploy healthy with no verified Slack config.\n' "${slack_env_file}" >&2
    return 1
  fi
  local have_webhook=0 have_bot=0 have_channel=0
  env_file_has_nonempty_key SLACK_WEBHOOK_URL && have_webhook=1
  env_file_has_nonempty_key SLACK_BOT_TOKEN && have_bot=1
  if env_file_has_nonempty_key SLACK_CHANNEL ||
    env_file_has_nonempty_key SLACK_CHANNEL_NOTIFY ||
    env_file_has_nonempty_key SLACK_CHANNEL_NEEDS_RESPONSE; then
    have_channel=1
  fi
  if ! env_file_has_nonempty_key SLACK_MEMBER_ID || ! env_file_has_nonempty_key SLACK_SIGNING_SECRET; then
    printf 'Slack config %s is missing SLACK_MEMBER_ID or SLACK_SIGNING_SECRET.\n' "${slack_env_file}" >&2
    return 1
  fi
  if [[ "${have_webhook}" == "1" || ( "${have_bot}" == "1" && "${have_channel}" == "1" ) ]]; then
    log "Slack notifier and reply config verified from ${slack_env_file}"
    return 0
  fi
  printf 'Slack config %s has no usable sink; set SLACK_WEBHOOK_URL or SLACK_BOT_TOKEN plus a Slack channel.\n' "${slack_env_file}" >&2
  return 1
}

retire_legacy_attention_notifier() {
  log "Retiring legacy outbound attention notifier ${legacy_attention_unit} if present."
  run_best_effort systemctl --user disable --now "${legacy_attention_unit}"
  if [[ -e "${legacy_attention_state}" ]]; then
    if [[ "${dry_run}" == "1" ]]; then
      log "Would remove retired outbound attention state: ${legacy_attention_state}"
    elif rm -f "${legacy_attention_state}"; then
      log "Removed retired outbound attention state: ${legacy_attention_state}"
    else
      log "WARN: failed to remove retired outbound attention state: ${legacy_attention_state}"
    fi
  fi
}

verify_after_restart() {
  local expected_sessions="$1"
  local skip_reason="${2:-pre-restart session count unavailable}"

  wait_for_ao_ready
  verify_ao_doctor
  verify_projects_api

  if [[ "${dry_run}" == "1" ]]; then
    run ao session ls --json
  else
    if [[ -n "${expected_sessions}" ]]; then
      local actual_sessions
      actual_sessions="$(session_count)"
      if [[ "${actual_sessions}" != "${expected_sessions}" ]]; then
        printf 'Session re-adoption count mismatch: before=%s after=%s\n' "${expected_sessions}" "${actual_sessions}" >&2
        return 1
      fi
      log "Session re-adoption count preserved: ${actual_sessions}"
    else
      log "${skip_reason}; skipping session re-adoption count comparison."
    fi
  fi

}

rollback_deploy() {
  log "Rolling back ao release via ${previous_link}"
  if [[ "${dry_run}" != "1" && ! -L "${previous_link}" ]]; then
    local fallback_sessions
    fallback_sessions="$(session_count 2>/dev/null || true)"
    rollback_pre_hermetic "${fallback_sessions}"
    return
  fi

  local pre_sessions
  if [[ "${dry_run}" == "1" ]]; then
    pre_sessions=0
  else
    pre_sessions="$(session_count 2>/dev/null || true)"
  fi
  verify_slack_configured

  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: atomically point %s at previous release %s\n' "${current_link}" "${previous_link}"
  else
    local rollback_target current_target
    rollback_target="$(readlink -f "${previous_link}")"
    if [[ ! -f "${rollback_target}/REVISION" ]]; then
      printf 'Rollback release has no REVISION metadata: %s\n' "${rollback_target}" >&2
      return 1
    fi
    if [[ -L "${current_link}" ]]; then
      current_target="$(readlink -f "${current_link}")"
      if [[ "${current_target}" == "${rollback_target}" ]]; then
        printf 'Already on rollback target %s; refusing a no-op rollback.\n' "${rollback_target}" >&2
        return 1
      fi
    fi
    ln -sfn "${rollback_target}" "${current_link}.tmp"
    mv -Tf "${current_link}.tmp" "${current_link}"
  fi

  install_cli_link
  install_units_from_current
  retire_legacy_attention_notifier
  ensure_tmux_server_unit
  ensure_tmux_claim_timer
  local ao_restart_started_at
  ao_restart_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  restart_unit "${ao_unit}"
  verify_after_restart "${pre_sessions}" "Pre-rollback session count unavailable (old daemon may be down)"
  verify_ao_cgroup_is_daemon_only
  verify_ao_sudo_warnings "${ao_restart_started_at}"
  local rolled_revision=""
  if [[ "${dry_run}" != "1" ]]; then
    rolled_revision="$(cat "${current_link}/REVISION")"
    verify_daemon_revision "${rolled_revision}"
    mkdir -p "${state_dir}"
    printf '%s\n' "${rolled_revision}" > "${state_file}"
  fi
  restart_unit "${web_unit}"
  verify_unit_active "${web_unit}" "ao web"
  restart_unit "${notifier_unit}"
  verify_unit_active "${notifier_unit}" "Slack notifier"
  restart_unit "${attention_reply_unit}"
  verify_unit_active "${attention_reply_unit}" "attention reply listener"
  verify_tailnet_web
  report_fleet_safety_warnings
}

deploy() {
  local head base frontend_changed=false frontend_package_metadata_changed=false web_build_needed=false pre_sessions
  local changed_web=""

  if [[ "${dry_run}" != "1" && -L "${current_link}" && ! -x "${ao_bin}" ]]; then
    log "WARN: current ao symlink is missing or not executable at ${ao_bin}; deploy will repair it before restart."
  fi

  head="$(git_head)"
  base="$(default_base_ref || true)"

  log "Deploying ao from ${repo_root}"
  log "Deploy range: ${base:-<unknown/first deploy>}..${head}"
  verify_main_ci_green "${head}"
  verify_slack_configured

  if changed_in_range "${base}" "${head}" "frontend/"; then
    frontend_changed=true
  fi
  # Web INPUTS are wider than the bundle's sources: the server script and the
  # unit/drop-in definition are executed and read by production too (#293 H4).
  changed_web="$(changed_web_input "${base}" "${head}" || true)"
  if changed_in_range "${base}" "${head}" "frontend/package.json" ||
    changed_in_range "${base}" "${head}" "frontend/package-lock.json"; then
    frontend_package_metadata_changed=true
  fi
  if [[ "${frontend_changed}" == "true" || "${frontend_package_metadata_changed}" == "true" ]]; then
    web_build_needed=true
  fi
  if [[ "${dry_run}" != "1" && ! -d "${current_link}/source/frontend/dist" ]]; then
    web_build_needed=true
  fi

  local stage_dir release_dir release_source release_bin release_name frontend_tree previous_frontend_tree
  release_name="${head}-$(date -u +%Y%m%d%H%M%S)-$$"
  stage_dir="${release_root}/.staging-${release_name}"
  release_dir="${release_root}/${release_name}"
  release_source="${stage_dir}/source"
  release_bin="${stage_dir}/bin/ao"

  stage_release_source "${head}" "${stage_dir}"
  run mkdir -p "${stage_dir}/bin"
  frontend_tree="$(git -C "${repo_root}" rev-parse "${head}:frontend" 2>/dev/null || true)"
  if [[ "${dry_run}" != "1" && -f "${current_link}/FRONTEND_TREE" ]]; then
    previous_frontend_tree="$(cat "${current_link}/FRONTEND_TREE")"
  else
    previous_frontend_tree=""
  fi
  if [[ "${dry_run}" != "1" && "${web_build_needed}" != "true" && "${previous_frontend_tree}" != "${frontend_tree}" ]]; then
    log "Previous web bundle provenance does not match this release; rebuilding from staged source."
    web_build_needed=true
  fi

  run_in "${release_source}/backend" go build -o "${release_bin}" ./cmd/ao

  # Record + gate the built revision before restarting: the log line lands in
  # the durable deploy log, and a binary that is unstamped, dirty, or built
  # from a different ref than we are shipping is refused HERE — before the
  # service restarts onto it — so the old daemon and active release pointer
  # remain intact for `--rollback` (#262/#270).
  local built_revision built_modified
  if [[ "${dry_run}" != "1" ]]; then
    built_revision="$(binary_build_setting "${release_bin}" vcs.revision)"
    built_modified="$(binary_build_setting "${release_bin}" vcs.modified)"
    log "Built ao revision: ${built_revision:-<unknown>} (dirty=${built_modified:-unknown})"
  fi
  verify_built_revision_stamped "${built_revision:-}" "${built_modified:-}" "${head}"

  if [[ "${web_build_needed}" == "true" ]]; then
    install_frontend_dependencies "${release_source}"
    log "Building web bundle from staged release source."
    run_in "${release_source}/frontend" npm run build:web
  else
    log "frontend/ unchanged; reusing previous web bundle when available."
    if ! copy_previous_web_dist_if_available "${stage_dir}"; then
      log "Previous web bundle unavailable; building from staged source."
      install_frontend_dependencies "${release_source}"
      run_in "${release_source}/frontend" npm run build:web
    fi
  fi

  if [[ "${dry_run}" != "1" ]]; then
    printf '%s\n' "${head}" > "${stage_dir}/REVISION"
    printf '%s\n' "${repo_root}" > "${stage_dir}/SOURCE_REPO"
    printf '%s\n' "${frontend_tree}" > "${stage_dir}/FRONTEND_TREE"
  else
    printf 'DRY-RUN: write release metadata for %s\n' "${head}"
  fi
  render_release_units "${stage_dir}"
  finalize_release_payload "${stage_dir}"
  run mv "${stage_dir}" "${release_dir}"

  if [[ "${dry_run}" == "1" ]]; then
    pre_sessions=0
  else
    pre_sessions="$(capture_pre_restart_sessions)"
  fi
  backup_pre_hermetic_host
  activate_release "${release_dir}"
  install_cli_link
  install_units_from_current
  retire_legacy_attention_notifier
  # Before the daemon restarts: make sure the tmux server is owned by
  # ao-tmux.service, so the daemon can never be the client that lazily spawns one
  # into ao.service's own cgroup (#293/D1).
  ensure_tmux_server_unit
  ensure_tmux_claim_timer
  local ao_restart_started_at
  ao_restart_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  restart_unit "${ao_unit}"
  verify_after_restart "${pre_sessions}" "Pre-restart session count unavailable (first deploy or old daemon unreachable)"
  verify_daemon_revision "${built_revision:-}"
  verify_ao_cgroup_is_daemon_only
  verify_ao_sudo_warnings "${ao_restart_started_at}"

  # Name the web input that changed. The restart itself is unconditional (the web
  # process must always follow the activated release pointer), but before #293
  # this log claimed "frontend/ unchanged" for a change to the very file the web
  # process executes — which is how an ops-only web fix could be reported as
  # deployed while the old process kept serving.
  if [[ -n "${changed_web}" ]]; then
    log "web inputs changed (${changed_web}); restarting ${web_unit} from the activated release."
  else
    log "no web inputs changed; restarting ${web_unit} so it follows the activated release pointer."
  fi
  restart_unit "${web_unit}"
  verify_unit_active "${web_unit}" "ao web"

  log "Restarting ${notifier_unit} from the activated release."
  restart_unit "${notifier_unit}"
  verify_unit_active "${notifier_unit}" "Slack notifier"

  log "Restarting ${attention_reply_unit} from the activated release; outbound attention notifier remains retired."
  restart_unit "${attention_reply_unit}"
  verify_unit_active "${attention_reply_unit}" "attention reply listener"

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
  prune_old_releases

  log "ao deploy complete."
  report_fleet_safety_warnings
}

with_deploy_lock() {
  if [[ "${dry_run}" == "1" ]]; then
    printf 'DRY-RUN: flock -n %s\n' "$(printf '%q' "${deploy_lock}")"
    "$@"
    return
  fi
  mkdir -p "$(dirname "${deploy_lock}")"
  exec 9>"${deploy_lock}"
  if ! flock -n 9; then
    printf 'Another ao deploy or rollback already holds %s; refusing to run concurrently.\n' "${deploy_lock}" >&2
    return 1
  fi
  "$@"
}

# Test hook: let the suite source this script and exercise individual functions
# (notably the fleet-fatal systemctl guard) without running a deploy or a rollback
# against the host it happens to be running on.
if [[ -n "${AO_DEPLOY_LIB_ONLY:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi

if [[ "${rollback}" == "true" ]]; then
  with_deploy_lock rollback_deploy
else
  with_deploy_lock deploy
fi
