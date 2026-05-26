#!/bin/bash

set -euo pipefail

SKIP_SMOKE=false
SMOKE_ONLY=false
FORCE_REBUILD=false
TARGET_BRANCH="${AO_UPDATE_BRANCH:-main}"

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-smoke)
      SKIP_SMOKE=true
      ;;
    --smoke-only)
      SMOKE_ONLY=true
      ;;
    --force-rebuild)
      FORCE_REBUILD=true
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ao update [--skip-smoke] [--smoke-only] [--force-rebuild]

Fast-forwards the local Agent Orchestrator install repo to main, installs deps,
clean-rebuilds all workspace packages, refreshes the ao launcher, and runs smoke tests.

The rebuild runs whenever the compiled output is out of sync with the source at
the current commit — not only when new commits are pulled. This catches a manual
`git pull`, a branch switch, an interrupted earlier build, or a manual clean.

Options:
  --skip-smoke    Skip smoke tests after rebuild
  --smoke-only    Run smoke tests without fetching or rebuilding
  --force-rebuild Rebuild even when the build is already up to date
EOF
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 1
      ;;
  esac
  shift
done

if [ "$SKIP_SMOKE" = true ] && [ "$SMOKE_ONLY" = true ]; then
  printf 'Conflicting options: use either --skip-smoke or --smoke-only, not both.\n' >&2
  exit 1
fi

is_repo_root() {
  local candidate="$1"
  [ -f "$candidate/packages/ao/bin/ao.js" ] && [ -d "$candidate/packages/cli" ]
}

find_repo_root_from() {
  local dir="$1"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if is_repo_root "$dir"; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

resolve_repo_root() {
  if [ -n "${AO_REPO_ROOT:-}" ]; then
    printf '%s\n' "$AO_REPO_ROOT"
    return 0
  fi

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  find_repo_root_from "$script_dir" || find_repo_root_from "$PWD"
}

if ! REPO_ROOT="$(resolve_repo_root)"; then
  printf 'Unable to find Agent Orchestrator repo root. Fix: run via ao update or set AO_REPO_ROOT.\n' >&2
  exit 1
fi

# Records the commit the compiled output was last built from. Lives under
# node_modules (gitignored) so it never dirties the working tree, and is rewritten
# only after a fully successful build + launcher refresh. Comparing it to HEAD is
# how we tell "dist is in sync with src at this commit" without fragile mtime checks.
BUILD_SHA_FILE="$REPO_ROOT/node_modules/.ao-build-sha"
BUILD_OUTPUT_SENTINELS=(
  "$REPO_ROOT/packages/core/dist/index.js"
  "$REPO_ROOT/packages/cli/dist/index.js"
  "$REPO_ROOT/packages/web/.next/BUILD_ID"
  "$REPO_ROOT/packages/plugins/agent-aider/dist/index.js"
  "$REPO_ROOT/packages/plugins/agent-claude-code/dist/index.js"
  "$REPO_ROOT/packages/plugins/agent-codex/dist/index.js"
  "$REPO_ROOT/packages/plugins/agent-cursor/dist/index.js"
  "$REPO_ROOT/packages/plugins/agent-grok/dist/index.js"
  "$REPO_ROOT/packages/plugins/agent-kimicode/dist/index.js"
  "$REPO_ROOT/packages/plugins/agent-opencode/dist/index.js"
  "$REPO_ROOT/packages/plugins/notifier-composio/dist/index.js"
  "$REPO_ROOT/packages/plugins/notifier-dashboard/dist/index.js"
  "$REPO_ROOT/packages/plugins/notifier-desktop/dist/index.js"
  "$REPO_ROOT/packages/plugins/notifier-discord/dist/index.js"
  "$REPO_ROOT/packages/plugins/notifier-openclaw/dist/index.js"
  "$REPO_ROOT/packages/plugins/notifier-slack/dist/index.js"
  "$REPO_ROOT/packages/plugins/notifier-webhook/dist/index.js"
  "$REPO_ROOT/packages/plugins/runtime-process/dist/index.js"
  "$REPO_ROOT/packages/plugins/runtime-tmux/dist/index.js"
  "$REPO_ROOT/packages/plugins/scm-github/dist/index.js"
  "$REPO_ROOT/packages/plugins/scm-gitlab/dist/index.js"
  "$REPO_ROOT/packages/plugins/terminal-iterm2/dist/index.js"
  "$REPO_ROOT/packages/plugins/terminal-web/dist/index.js"
  "$REPO_ROOT/packages/plugins/tracker-github/dist/index.js"
  "$REPO_ROOT/packages/plugins/tracker-gitlab/dist/index.js"
  "$REPO_ROOT/packages/plugins/tracker-linear/dist/index.js"
  "$REPO_ROOT/packages/plugins/workspace-clone/dist/index.js"
  "$REPO_ROOT/packages/plugins/workspace-worktree/dist/index.js"
)

read_built_sha() {
  if [ -f "$BUILD_SHA_FILE" ]; then
    cat "$BUILD_SHA_FILE" 2>/dev/null || true
  fi
}

write_built_sha() {
  mkdir -p "$(dirname "$BUILD_SHA_FILE")" 2>/dev/null || true
  printf '%s\n' "$1" > "$BUILD_SHA_FILE" 2>/dev/null || true
}

all_build_outputs_present() {
  local sentinel
  for sentinel in "${BUILD_OUTPUT_SENTINELS[@]}"; do
    if [ ! -f "$sentinel" ]; then
      missing_build_output="$sentinel"
      return 1
    fi
  done
  missing_build_output=""
  return 0
}

require_command() {
  local name="$1"
  local fix_hint="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    printf 'Missing required command: %s. Fix: %s\n' "$name" "$fix_hint" >&2
    exit 1
  fi
}

run_cmd() {
  printf -- '-> %s\n' "$*"
  "$@"
}

has_remote() {
  git remote get-url "$1" >/dev/null 2>&1
}

get_remote_url() {
  git remote get-url "$1" 2>/dev/null || true
}

get_github_repo_slug() {
  local remote_name="$1"
  local remote_url
  remote_url="$(get_remote_url "$remote_name")"

  case "$remote_url" in
    https://github.com/*)
      remote_url="${remote_url#https://github.com/}"
      ;;
    http://github.com/*)
      remote_url="${remote_url#http://github.com/}"
      ;;
    ssh://git@github.com/*)
      remote_url="${remote_url#ssh://git@github.com/}"
      ;;
    git@github.com:*)
      remote_url="${remote_url#git@github.com:}"
      ;;
    *)
      return 1
      ;;
  esac

  remote_url="${remote_url%.git}"
  printf '%s\n' "$remote_url"
}

resolve_update_remote() {
  if has_remote upstream; then
    printf 'upstream\n'
    return
  fi

  printf 'origin\n'
}

maybe_sync_origin_with_upstream() {
  local origin_repo
  local upstream_repo

  if ! has_remote origin || ! has_remote upstream; then
    return
  fi

  if ! command -v gh >/dev/null 2>&1; then
    printf 'Skipping fork sync: gh is not installed. Local update will use upstream/%s directly.\n' \
      "$TARGET_BRANCH"
    return
  fi

  origin_repo="$(get_github_repo_slug origin)" || return
  upstream_repo="$(get_github_repo_slug upstream)" || return

  printf '\nSyncing %s/%s with %s/%s via gh...\n' \
    "$origin_repo" "$TARGET_BRANCH" "$upstream_repo" "$TARGET_BRANCH"

  if ! run_cmd gh repo sync "$origin_repo" --source "$upstream_repo" --branch "$TARGET_BRANCH"; then
    printf 'WARNING: Failed to sync %s/%s from %s/%s via gh. Continuing with upstream/%s for the local update.\n' \
      "$origin_repo" "$TARGET_BRANCH" "$upstream_repo" "$TARGET_BRANCH" "$TARGET_BRANCH" >&2
  fi
}

run_smoke_tests() {
  printf '\nRunning smoke tests...\n'
  run_cmd node "$REPO_ROOT/packages/ao/bin/ao.js" --version
  run_cmd node "$REPO_ROOT/packages/ao/bin/ao.js" doctor --help
  run_cmd node "$REPO_ROOT/packages/ao/bin/ao.js" update --help
}

ensure_repo_clean() {
  local reason="$1"
  local status_output
  status_output="$(git status --porcelain)"
  if [ -n "$status_output" ]; then
    printf '%s\n' "$reason" >&2
    exit 1
  fi
}

ensure_on_target_branch() {
  local current_branch
  current_branch="$(git branch --show-current)"
  if [ "$current_branch" != "$TARGET_BRANCH" ]; then
    printf 'Current branch is %s, expected %s. Fix: git switch %s && rerun ao update.\n' \
      "$current_branch" "$TARGET_BRANCH" "$TARGET_BRANCH" >&2
    exit 1
  fi
}

printf 'Agent Orchestrator Update\n\n'

require_command node "install Node.js 20+"

cd "$REPO_ROOT"

UPDATE_REMOTE="$(resolve_update_remote)"

if [ "$SMOKE_ONLY" = false ]; then
  require_command git "install git 2.25+"
  require_command pnpm "enable corepack or run npm install -g pnpm"
  require_command npm "install npm with Node.js"

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'The update command must run inside the Agent Orchestrator git checkout.\n' >&2
    exit 1
  fi

  ensure_repo_clean "Working tree is dirty. Fix: commit or stash local changes before running ao update."
  ensure_on_target_branch

  maybe_sync_origin_with_upstream

  run_cmd git fetch "$UPDATE_REMOTE" "$TARGET_BRANCH"

  local_sha="$(git rev-parse HEAD)"
  remote_sha="$(git rev-parse "$UPDATE_REMOTE/$TARGET_BRANCH")"
  if [ "$local_sha" != "$remote_sha" ]; then
    run_cmd git pull --ff-only "$UPDATE_REMOTE" "$TARGET_BRANCH"
    # HEAD moved; rebuild decision below must compare against the new commit.
    local_sha="$(git rev-parse HEAD)"
  fi

  # Decide whether to rebuild. Gating purely on "did the SHA advance" misses the
  # common case where dist is stale at the current commit — a manual git pull, a
  # branch switch, an interrupted earlier build, or a manual clean. Rebuild when
  # the user forces it, the output is missing, or it wasn't built from HEAD.
  built_sha="$(read_built_sha)"
  missing_build_output=""
  all_build_outputs_present || true
  rebuild_reason=""
  if [ "$FORCE_REBUILD" = true ]; then
    rebuild_reason="forced via --force-rebuild"
  elif [ -n "$missing_build_output" ]; then
    rebuild_reason="build output missing ($missing_build_output)"
  elif [ "$built_sha" != "$local_sha" ]; then
    rebuild_reason="build is stale (last built ${built_sha:-unknown}, HEAD is $local_sha)"
  fi

  if [ -z "$rebuild_reason" ]; then
    printf '\nAlready on latest version; build is up to date.\n'
  else
    printf '\nRebuilding: %s\n' "$rebuild_reason"
    run_cmd pnpm install

    run_cmd pnpm -r --if-present clean
    run_cmd pnpm build

    printf '\nRefreshing ao launcher...\n'
    (
      cd "$REPO_ROOT/packages/ao"
      npm_link_error="$(mktemp)"
      if npm link --force 2>"$npm_link_error"; then
        rm -f "$npm_link_error"
      elif [ -t 0 ]; then
        rm -f "$npm_link_error"
        printf '  Launcher refresh failed. Retrying with sudo...\n'
        if ! sudo npm link --force; then
          printf 'ERROR: sudo npm link --force failed. Inspect npm output above.\n' >&2
          exit 1
        fi
      else
        cat "$npm_link_error" >&2
        rm -f "$npm_link_error"
        printf 'ERROR: Launcher refresh failed. Run manually: cd %s/packages/ao && sudo npm link --force\n' "$REPO_ROOT"
        exit 1
      fi
    )

    ensure_repo_clean "Update modified tracked files. Inspect git status, review the changes, and rerun after restoring a clean checkout if needed."

    # Only reached on a fully successful build + launcher refresh + clean tree.
    # Recording HEAD here lets the next run skip the rebuild when nothing changed.
    write_built_sha "$local_sha"
  fi
fi

if [ "$SKIP_SMOKE" = false ]; then
  run_smoke_tests
fi

printf '\nUpdate complete.\n'
