#!/bin/bash

set -uo pipefail

FIX_MODE=false

while [ $# -gt 0 ]; do
  case "$1" in
    --fix)
      FIX_MODE=true
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ao doctor [--fix]

Checks install, PATH, binaries, service health, stale temp files, and runtime sanity.

Options:
  --fix    Apply safe fixes for missing launcher links, missing support dirs, and stale temp files
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

REPO_ROOT="${AO_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SCRIPT_LAYOUT="${AO_SCRIPT_LAYOUT:-}"
if [ -z "$SCRIPT_LAYOUT" ]; then
  if [ -f "$REPO_ROOT/package.json" ] && [ -f "$REPO_ROOT/dist/index.js" ] && [ ! -d "$REPO_ROOT/packages" ]; then
    SCRIPT_LAYOUT="package-install"
  else
    SCRIPT_LAYOUT="source-checkout"
  fi
fi
DEFAULT_CONFIG_HOME="${HOME:-$REPO_ROOT}"
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
FIX_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'PASS %s\n' "$1"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf 'WARN %s\n' "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'FAIL %s\n' "$1"
}

fixed() {
  FIX_COUNT=$((FIX_COUNT + 1))
  printf 'FIXED %s\n' "$1"
}

strip_ansi() {
  sed -E $'s/\x1B\\[[0-9;]*[A-Za-z]//g'
}

expand_home() {
  case "$1" in
    ~/*)
      printf '%s/%s' "$DEFAULT_CONFIG_HOME" "${1#~/}"
      ;;
    *)
      printf '%s' "$1"
      ;;
  esac
}

find_config() {
  if [ -n "${AO_CONFIG_PATH:-}" ] && [ -f "$AO_CONFIG_PATH" ]; then
    printf '%s\n' "$AO_CONFIG_PATH"
    return 0
  fi

  local current_dir="$PWD"
  while [ "$current_dir" != "/" ]; do
    if [ -f "$current_dir/agent-orchestrator.yaml" ]; then
      printf '%s\n' "$current_dir/agent-orchestrator.yaml"
      return 0
    fi
    if [ -f "$current_dir/agent-orchestrator.yml" ]; then
      printf '%s\n' "$current_dir/agent-orchestrator.yml"
      return 0
    fi
    current_dir="$(dirname "$current_dir")"
  done

  if [ -f "$REPO_ROOT/agent-orchestrator.yaml" ]; then
    printf '%s\n' "$REPO_ROOT/agent-orchestrator.yaml"
    return 0
  fi

  if [ -f "$DEFAULT_CONFIG_HOME/.agent-orchestrator.yaml" ]; then
    printf '%s\n' "$DEFAULT_CONFIG_HOME/.agent-orchestrator.yaml"
    return 0
  fi

  return 1
}

read_config_value() {
  local key="$1"
  local file="$2"
  local raw
  local value
  raw="$(grep -E "^[[:space:]]*${key}:" "$file" | head -n 1 | cut -d: -f2- || true)"
  raw="$(printf '%s' "$raw" | strip_ansi)"
  raw="${raw%%[[:space:]]#*}"
  value="$(printf '%s' "$raw" | tr -d '"' | xargs 2>/dev/null || true)"
  printf '%s' "$value"
}

ensure_dir() {
  local dir_path="$1"
  local label="$2"
  local fix_hint="$3"
  if [ -d "$dir_path" ]; then
    pass "$label exists at $dir_path"
    return 0
  fi

  if [ "$FIX_MODE" = true ]; then
    if mkdir -p "$dir_path"; then
      fixed "$label created at $dir_path"
      return 0
    fi
    fail "$label could not be created at $dir_path. Fix: $fix_hint"
    return 1
  fi

  warn "$label is missing at $dir_path. Fix: $fix_hint"
}

check_command() {
  local name="$1"
  local required="$2"
  local fix_hint="$3"
  local command_path
  command_path="$(command -v "$name" 2>/dev/null || true)"
  if [ -z "$command_path" ]; then
    if [ "$required" = "required" ]; then
      fail "$name is not in PATH. Fix: $fix_hint"
    else
      warn "$name is not in PATH. Fix: $fix_hint"
    fi
    return 1
  fi

  pass "$name resolves to $command_path"
  return 0
}

check_node() {
  if ! check_command "node" "required" "install Node.js 20+ and reopen your shell"; then
    return
  fi
  local version major
  version="$(node --version 2>/dev/null || true)"
  major="${version#v}"
  major="${major%%.*}"
  if [ -z "$major" ] || [ "$major" -lt 20 ]; then
    fail "Node.js 20+ is required, found ${version:-unknown}. Fix: install Node.js 20+"
    return
  fi
  pass "Node.js version ${version} is supported"
}

check_git() {
  if ! check_command "git" "required" "install git 2.25+ and reopen your shell"; then
    return
  fi
  local version_output version major minor
  version_output="$(git --version 2>/dev/null || true)"
  version_output="$(printf '%s' "$version_output" | strip_ansi)"
  version="$(printf '%s\n' "$version_output" | awk '{print $3}' | head -n 1)"
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"
  if [ -z "$version" ] || [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 25 ]; }; then
    fail "git 2.25+ is required, found ${version:-unknown}. Fix: upgrade git"
    return
  fi
  pass "git version ${version} supports worktrees"
}

check_pnpm() {
  local pnpm_requirement="required"
  local fix_hint="enable corepack or run npm install -g pnpm"
  if [ "$SCRIPT_LAYOUT" = "package-install" ]; then
    pnpm_requirement="optional"
    fix_hint="install pnpm if you plan to use pnpm-managed repos with AO"
  fi

  if ! check_command "pnpm" "$pnpm_requirement" "$fix_hint"; then
    return
  fi
  local version
  version="$(pnpm --version 2>/dev/null || true)"
  pass "pnpm version ${version:-unknown} is available"
}

check_launcher() {
  local ao_path
  ao_path="$(command -v ao 2>/dev/null || true)"
  if [ -n "$ao_path" ]; then
    if [ -x "$ao_path" ]; then
      pass "ao launcher resolves to $ao_path"
      return
    fi
    warn "ao launcher resolves to $ao_path, but its target is missing or not executable"
  fi

  if [ "$SCRIPT_LAYOUT" = "source-checkout" ] && [ "$FIX_MODE" = true ] && command -v npm >/dev/null 2>&1 && [ -d "$REPO_ROOT/packages/ao" ]; then
    if (cd "$REPO_ROOT/packages/ao" && npm link --force >/dev/null 2>&1) && command -v ao >/dev/null 2>&1; then
      fixed "ao launcher refreshed with npm link --force"
      return
    fi
    if [ -t 0 ]; then
      printf '  Launcher refresh failed. Retrying with sudo...\n'
      if (cd "$REPO_ROOT/packages/ao" && sudo npm link --force >/dev/null 2>&1) && command -v ao >/dev/null 2>&1; then
        fixed "ao launcher refreshed with sudo npm link --force"
        return
      fi
      printf 'ERROR: sudo npm link --force failed. Inspect npm output above.\n' >&2
    fi
    warn "ao launcher refresh failed. Fix: cd $REPO_ROOT/packages/ao && sudo npm link --force"
    return
  fi

  if [ "$SCRIPT_LAYOUT" = "package-install" ]; then
    warn "ao launcher is not in PATH. Fix: reinstall with npm install -g @aoagents/ao@latest or run via pnpx @aoagents/ao@latest"
    return
  fi

  warn "ao launcher is not in PATH. Fix: cd $REPO_ROOT && bash scripts/setup.sh"
}

check_tmux() {
  if ! command -v tmux >/dev/null 2>&1; then
    warn "tmux is not installed. Fix: install tmux for the default runtime"
    return
  fi
  if tmux -V >/dev/null 2>&1 && tmux start-server >/dev/null 2>&1; then
    pass "tmux is installed and the server can start"
    return
  fi
  warn "tmux is installed but failed a basic server health check. Fix: restart tmux or reinstall it"
}

check_gh() {
  if ! command -v gh >/dev/null 2>&1; then
    warn "GitHub CLI is not installed. Fix: install gh from https://cli.github.com/"
    return
  fi
  if gh auth status >/dev/null 2>&1; then
    pass "gh is installed and authenticated"
    return
  fi
  warn "gh is installed but not authenticated. Fix: run gh auth login"
}

check_install_layout() {
  if [ "$SCRIPT_LAYOUT" = "package-install" ]; then
    if [ -f "$REPO_ROOT/package.json" ]; then
      pass "CLI package metadata is present at $REPO_ROOT/package.json"
    else
      fail "CLI package metadata is missing at $REPO_ROOT/package.json. Fix: reinstall @aoagents/ao"
    fi

    if [ -f "$REPO_ROOT/dist/index.js" ]; then
      pass "packaged CLI entrypoint exists"
    else
      fail "packaged CLI entrypoint is missing. Fix: reinstall @aoagents/ao"
    fi

    if [ -f "$REPO_ROOT/dist/assets/scripts/ao-doctor.sh" ]; then
      pass "bundled doctor script is available"
    else
      fail "bundled doctor script is missing. Fix: reinstall @aoagents/ao"
    fi

    if [ -f "$REPO_ROOT/dist/assets/scripts/ao-update.sh" ]; then
      pass "bundled update script is available"
    else
      fail "bundled update script is missing. Fix: reinstall @aoagents/ao"
    fi
    return
  fi

  if [ -d "$REPO_ROOT/node_modules" ]; then
    pass "dependencies are installed at $REPO_ROOT/node_modules"
  else
    fail "dependencies are missing at $REPO_ROOT/node_modules. Fix: run pnpm install"
  fi

  if [ -f "$REPO_ROOT/packages/core/dist/index.js" ]; then
    pass "core package is built"
  else
    fail "core package is not built. Fix: run pnpm --filter @aoagents/ao-core build"
  fi

  if [ -f "$REPO_ROOT/packages/cli/dist/index.js" ]; then
    pass "CLI package is built"
  else
    fail "CLI package is not built. Fix: run pnpm --filter @aoagents/ao-cli build"
  fi
}

check_runtime_sanity() {
  if [ "$SCRIPT_LAYOUT" = "package-install" ]; then
    if [ ! -f "$REPO_ROOT/dist/index.js" ]; then
      fail "packaged CLI entrypoint is missing. Fix: reinstall @aoagents/ao"
      return
    fi

    if node "$REPO_ROOT/dist/index.js" --version >/dev/null 2>&1; then
      pass "packaged CLI runtime sanity check passed (ao --version)"
    else
      fail "packaged CLI runtime sanity check failed. Fix: reinstall @aoagents/ao"
    fi
    return
  fi

  if [ ! -f "$REPO_ROOT/packages/ao/bin/ao.js" ]; then
    fail "launcher entrypoint is missing. Fix: reinstall from a clean checkout"
    return
  fi

  if node "$REPO_ROOT/packages/ao/bin/ao.js" --version >/dev/null 2>&1; then
    pass "launcher runtime sanity check passed (ao --version)"
  else
    fail "launcher runtime sanity check failed. Fix: run pnpm build and refresh the launcher"
  fi
}

check_config_dirs() {
  local config_path data_dir worktree_dir
  config_path="$(find_config || true)"
  if [ -z "$config_path" ]; then
    warn "No agent-orchestrator config was found. Fix: run ao init --auto in a target repo"
    return
  fi

  pass "config found at $config_path"
  data_dir="$(read_config_value dataDir "$config_path")"
  worktree_dir="$(read_config_value worktreeDir "$config_path")"

  if [ -z "$data_dir" ]; then
    data_dir="$DEFAULT_CONFIG_HOME/.agent-orchestrator"
  fi
  if [ -z "$worktree_dir" ]; then
    worktree_dir="$DEFAULT_CONFIG_HOME/.worktrees"
  fi

  data_dir="$(expand_home "$data_dir")"
  worktree_dir="$(expand_home "$worktree_dir")"

  ensure_dir "$data_dir" "metadata directory" "mkdir -p $data_dir"
  ensure_dir "$worktree_dir" "worktree directory" "mkdir -p $worktree_dir"
}

check_stale_temp_files() {
  local temp_root stale_count deleted_count
  temp_root="${AO_DOCTOR_TMP_ROOT:-${TMPDIR:-/tmp}/agent-orchestrator}"
  if [ ! -d "$temp_root" ]; then
    pass "temp root exists check skipped because $temp_root does not exist"
    return
  fi

  stale_count="$(find "$temp_root" -maxdepth 1 -type f -mmin +60 \( -name 'ao-*.tmp' -o -name 'ao-*.pid' -o -name 'ao-*.lock' \) | wc -l | tr -d ' ')"
  if [ "$stale_count" = "0" ]; then
    pass "no stale temp files were detected under $temp_root"
    return
  fi

  if [ "$FIX_MODE" = true ]; then
    deleted_count="$(find "$temp_root" -maxdepth 1 -type f -mmin +60 \( -name 'ao-*.tmp' -o -name 'ao-*.pid' -o -name 'ao-*.lock' \) -delete -print | wc -l | tr -d ' ')"
    if [ "$deleted_count" = "$stale_count" ]; then
      fixed "$deleted_count stale temp files removed from $temp_root"
      return
    fi
    warn "Only removed $deleted_count of $stale_count stale temp files from $temp_root. Fix: inspect that directory manually"
    return
  fi

  warn "$stale_count stale temp files older than 60 minutes found under $temp_root. Fix: rerun ao doctor --fix"
}

printf 'Agent Orchestrator Doctor\n\n'

check_node
check_git
check_pnpm
check_launcher
check_tmux
check_gh
check_config_dirs
check_stale_temp_files
check_install_layout
check_runtime_sanity

printf '\nResults: %s PASS, %s WARN, %s FAIL, %s FIXED\n' "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT" "$FIX_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  printf 'Environment needs attention before AO is safe to update or run.\n' >&2
  exit 1
fi

printf 'Environment looks healthy enough to run Agent Orchestrator.\n'
