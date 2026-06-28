import {
  shellEscape,
  normalizeAgentPermissionMode,
  isWindows,
  resolveDriver,
  resolveProvider,
  resolveProviderKey,
  loadGlobalConfig,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type CostEstimate,
  type PluginModule,
  type ProjectConfig,
  type ProcessProbeResult,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@aoagents/ao-core";
import { execFileSync } from "node:child_process";
import { readFile, stat, open, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  classifyTerminalOutput,
  findLatestSessionFile,
  getClaudeActivityState,
  isClaudeProcessAlive,
  resolveWorkspaceForClaude,
  toClaudeProjectPath,
} from "./activity-detection.js";

export { resetPsCache, resolveWorkspaceForClaude, toClaudeProjectPath } from "./activity-detection.js";

// =============================================================================
// Metadata Updater Hook Script
// =============================================================================

/** Hook script content that updates session metadata on git/gh commands.
 *  Exported for integration testing. */
export const METADATA_UPDATER_SCRIPT = `#!/usr/bin/env bash
# Metadata Updater Hook for Agent Orchestrator
#
# This PostToolUse hook automatically updates session metadata when:
# - gh pr create: extracts PR URL and writes to metadata
# - git checkout -b / git switch -c: extracts branch name and writes to metadata
# - gh pr merge: updates status to "merged"

set -euo pipefail

# Configuration
AO_DATA_DIR="\${AO_DATA_DIR:-$HOME/.ao-sessions}"

# Read hook input from stdin
input=$(cat)

# Extract fields from JSON (using jq if available, otherwise basic parsing)
if command -v jq &>/dev/null; then
  tool_name=$(echo "$input" | jq -r '.tool_name // empty')
  command=$(echo "$input" | jq -r '.tool_input.command // empty')
  output=$(echo "$input" | jq -r '.tool_response // empty')
  exit_code=$(echo "$input" | jq -r '.exit_code // 0')
else
  # Fallback: basic JSON parsing without jq
  tool_name=$(echo "$input" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  command=$(echo "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  output=$(echo "$input" | grep -o '"tool_response"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  exit_code=$(echo "$input" | grep -o '"exit_code"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$' || echo "0")
fi

# Only process successful commands (exit code 0)
if [[ "$exit_code" -ne 0 ]]; then
  echo '{}'
  exit 0
fi

# Only process Bash tool calls
if [[ "$tool_name" != "Bash" ]]; then
  echo '{}' # Empty JSON output
  exit 0
fi

# Validate AO_SESSION is set
if [[ -z "\${AO_SESSION:-}" ]]; then
  echo '{"systemMessage": "AO_SESSION environment variable not set, skipping metadata update"}'
  exit 0
fi

# Construct metadata file path
# AO_DATA_DIR is already set to the project-specific sessions directory
# V2 storage uses .json extension
metadata_file="$AO_DATA_DIR/\${AO_SESSION}.json"

# Fallback to bare filename for pre-migration layouts
if [[ ! -f "$metadata_file" ]]; then
  metadata_file="$AO_DATA_DIR/$AO_SESSION"
fi

# Ensure metadata file exists
if [[ ! -f "$metadata_file" ]]; then
  echo '{"systemMessage": "Metadata file not found: '"$AO_DATA_DIR/\${AO_SESSION}"'"}'
  exit 0
fi

# Detect if metadata file is JSON format
is_json_metadata() {
  local first_char
  first_char=$(head -c1 "$metadata_file" 2>/dev/null)
  [[ "$first_char" == "{" ]]
}

# Update a single key in metadata (handles both JSON and key=value formats)
update_metadata_key() {
  local key="$1"
  local value="$2"
  local temp_file="\${metadata_file}.tmp"

  if is_json_metadata; then
    # JSON format
    if command -v jq &>/dev/null; then
      jq --arg k "$key" --arg v "$value" '.[$k] = $v' "$metadata_file" > "$temp_file"
      mv "$temp_file" "$metadata_file"
    else
      # jq unavailable — use node (hard dep) for safe nested JSON update
      node -e "
        const fs = require('fs');
        const d = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
        d[process.argv[2]] = process.argv[3];
        fs.writeFileSync(process.argv[4], JSON.stringify(d, null, 2));
      " "$metadata_file" "$key" "$value" "$temp_file"
      mv "$temp_file" "$metadata_file"
    fi
  else
    # Key=value format (legacy)
    local escaped_value=$(echo "$value" | sed 's/[&|\\/]/\\\\&/g')
    if grep -q "^$key=" "$metadata_file" 2>/dev/null; then
      sed "s|^$key=.*|$key=$escaped_value|" "$metadata_file" > "$temp_file"
    else
      cp "$metadata_file" "$temp_file"
      echo "$key=$value" >> "$temp_file"
    fi
    mv "$temp_file" "$metadata_file"
  fi
}

# ============================================================================
# Command Detection and Parsing
# ============================================================================

# Strip leading directory-change prefixes so that commands like
#   cd ~/.worktrees/project && gh pr create ...
# are correctly detected. Agents frequently cd into a worktree first.
# Store the regex pattern in a variable for clarity (avoids shell quoting confusion).
# Uses space-padded (&&|;) to avoid breaking on paths containing & or ; chars.
cd_prefix_pattern='^[[:space:]]*cd[[:space:]]+.*[[:space:]]+(&&|;)[[:space:]]+(.*)'
clean_command="$command"
while [[ "$clean_command" =~ ^[[:space:]]*cd[[:space:]] ]]; do
  if [[ "$clean_command" =~ $cd_prefix_pattern ]]; then
    clean_command="\${BASH_REMATCH[2]}"
  else
    break
  fi
done

# Detect: gh pr create
if [[ "$clean_command" =~ ^gh[[:space:]]+pr[[:space:]]+create ]]; then
  sanitized_output=$(printf '%s' "$output" | sed -E $'s/\x1B\\[[0-9;]*[A-Za-z]//g')
  # Extract PR URL from output
  pr_url=""
  # GitHub PR URLs are whitespace-delimited in gh output after ANSI stripping.
  if [[ "$sanitized_output" =~ (https://github[.]com/[^[:space:]]+/[^[:space:]]+/pull/[0-9]+) ]]; then
    pr_url="\${BASH_REMATCH[1]}"
  fi

  if [[ -n "$pr_url" ]]; then
    update_metadata_key "pr" "$pr_url"
    # Append to prs field (comma-separated list of all PR URLs for this session).
    # Supports multiple PRs per session — same repo or different repos.
    existing_prs=""
    if is_json_metadata; then
      if command -v jq &>/dev/null; then
        existing_prs=$(jq -r '.prs // empty' "$metadata_file" 2>/dev/null || echo "")
      else
        existing_prs=$(node -e "
          const fs = require('fs');
          const d = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
          process.stdout.write(d.prs || '');
        " "$metadata_file" 2>/dev/null || echo "")
      fi
    else
      existing_prs=$(grep '^prs=' "$metadata_file" 2>/dev/null | cut -d'=' -f2- || echo "")
    fi
    if [[ -z "$existing_prs" ]]; then
      new_prs="$pr_url"
    else
      # Only append if not already present (exact comma-delimited match to avoid /pull/1 matching /pull/10)
      if ! echo ",$existing_prs," | grep -qF ",$pr_url,"; then
        new_prs="$existing_prs,$pr_url"
      else
        new_prs="$existing_prs"
      fi
    fi
    update_metadata_key "prs" "$new_prs"
    update_metadata_key "status" "pr_open"
    echo '{"systemMessage": "Updated metadata: PR created at '"$pr_url"'"}'
    exit 0
  fi
fi

# Detect: git checkout -b <branch> or git switch -c <branch>
if [[ "$clean_command" =~ ^git[[:space:]]+checkout[[:space:]]+-b[[:space:]]+([^[:space:]]+) ]] || \\
   [[ "$clean_command" =~ ^git[[:space:]]+switch[[:space:]]+-c[[:space:]]+([^[:space:]]+) ]]; then
  branch="\${BASH_REMATCH[1]}"

  if [[ -n "$branch" ]]; then
    update_metadata_key "branch" "$branch"
    echo '{"systemMessage": "Updated metadata: branch = '"$branch"'"}'
    exit 0
  fi
fi

# Detect: git checkout <branch> (without -b) or git switch <branch> (without -c)
# Only update if the branch name looks like a feature branch (contains / or -)
if [[ "$clean_command" =~ ^git[[:space:]]+checkout[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]] || \\
   [[ "$clean_command" =~ ^git[[:space:]]+switch[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]]; then
  branch="\${BASH_REMATCH[1]}"

  # Avoid updating for checkout of commits/tags
  if [[ -n "$branch" && "$branch" != "HEAD" ]]; then
    update_metadata_key "branch" "$branch"
    echo '{"systemMessage": "Updated metadata: branch = '"$branch"'"}'
    exit 0
  fi
fi

# Detect: gh pr merge
if [[ "$clean_command" =~ ^gh[[:space:]]+pr[[:space:]]+merge ]]; then
  update_metadata_key "status" "merged"
  echo '{"systemMessage": "Updated metadata: status = merged"}'
  exit 0
fi

# No matching command, exit silently
echo '{}'
exit 0
`;

// =============================================================================
// Metadata Updater Hook Script — Node.js (Windows)
// =============================================================================

/**
 * Node.js equivalent of METADATA_UPDATER_SCRIPT for Windows.
 * Reads JSON from stdin, parses it with Node built-ins, and updates the
 * key=value metadata file.  No bash, jq, grep, sed, or chmod needed.
 * Exported for testing.
 */
export const METADATA_UPDATER_SCRIPT_NODE = `#!/usr/bin/env node
// Metadata Updater Hook for Agent Orchestrator (Node.js — Windows)
//
// This PostToolUse hook automatically updates session metadata when:
// - gh pr create: extracts PR URL and writes to metadata
// - git checkout -b / git switch -c: extracts branch name and writes to metadata
// - gh pr merge: updates status to "merged"

const { readFileSync, writeFileSync, renameSync, existsSync, realpathSync } = require("node:fs");
const { join, sep, resolve: resolvePath } = require("node:path");
const os = require("node:os");

const AO_DATA_DIR = process.env.AO_DATA_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".ao-sessions");
const AO_SESSION = process.env.AO_SESSION || "";

// Read hook input from stdin (fd 0 is cross-platform, no /dev/stdin needed)
let inputRaw = "";
try {
  inputRaw = readFileSync(0, "utf-8");
} catch {
  inputRaw = "";
}

let input;
try {
  input = JSON.parse(inputRaw || "{}");
} catch {
  process.stdout.write("{}\\n");
  process.exit(0);
}

const toolName = input.tool_name || "";
const command = (input.tool_input && input.tool_input.command) || "";
const output = input.tool_response || "";
const exitCode = typeof input.exit_code === "number" ? input.exit_code : 0;

// Only process successful commands
if (exitCode !== 0) {
  process.stdout.write("{}\\n");
  process.exit(0);
}

// Only process Bash tool calls
if (toolName !== "Bash") {
  process.stdout.write("{}\\n");
  process.exit(0);
}

// Validate AO_SESSION is set
if (!AO_SESSION) {
  process.stdout.write(JSON.stringify({ systemMessage: "AO_SESSION environment variable not set, skipping metadata update" }) + "\\n");
  process.exit(0);
}

// Validate AO_SESSION contains no path traversal components
if (AO_SESSION.includes("/") || AO_SESSION.includes("\\\\") || AO_SESSION.includes("..")) {
  process.stdout.write(JSON.stringify({ systemMessage: "AO_SESSION contains invalid path characters, skipping metadata update" }) + "\\n");
  process.exit(0);
}

// Validate AO_DATA_DIR is within an allowed base directory (mirrors ao-metadata-helper.sh)
const home = os.homedir();
let resolvedAoDir;
try { resolvedAoDir = realpathSync(AO_DATA_DIR); } catch { resolvedAoDir = resolvePath(AO_DATA_DIR); }
const allowedBases = [join(home, ".ao"), join(home, ".agent-orchestrator"), os.tmpdir()];
if (!allowedBases.some((a) => resolvedAoDir === a || resolvedAoDir.startsWith(a + sep))) {
  process.stdout.write(JSON.stringify({ systemMessage: "AO_DATA_DIR is outside allowed directories, skipping metadata update" }) + "\\n");
  process.exit(0);
}

const metadataFile = join(AO_DATA_DIR, AO_SESSION);

if (!existsSync(metadataFile)) {
  process.stdout.write(JSON.stringify({ systemMessage: "Metadata file not found: " + metadataFile }) + "\\n");
  process.exit(0);
}

/**
 * Update or append a key=value line in the metadata file (atomic via temp file).
 */
function updateMetadataKey(key, value) {
  const lines = readFileSync(metadataFile, "utf-8").split("\\n");
  let found = false;
  const updated = lines.map((line) => {
    if (line.startsWith(key + "=")) {
      found = true;
      return key + "=" + value;
    }
    return line;
  });
  if (!found) {
    // Insert before the trailing empty line (if any) so the file ends cleanly
    updated.push(key + "=" + value);
  }
  const tmpFile = metadataFile + ".tmp." + process.pid;
  writeFileSync(tmpFile, updated.join("\\n"), "utf-8");
  renameSync(tmpFile, metadataFile);
}

// Strip leading cd ... && / cd ... ; prefixes (agents frequently cd into a
// worktree before running the real command)
let cleanCommand = command;
const cdPrefixRe = /^\\s*cd\\s+\\S.*?\\s+(?:&&|;)\\s+(.*)/;
let m;
while ((m = cdPrefixRe.exec(cleanCommand)) !== null && /^\\s*cd\\s/.test(cleanCommand)) {
  cleanCommand = m[1];
}

// Detect: gh pr create
if (/^gh\\s+pr\\s+create/.test(cleanCommand)) {
  const prMatch = output.match(/https:\\/\\/github[.]com\\/[^/]+\\/[^/]+\\/pull\\/\\d+/);
  if (prMatch) {
    const prUrl = prMatch[0];
    let existingPrs = "";
    try {
      const raw = readFileSync(metadataFile, "utf-8");
      if (metadataFile.endsWith(".json")) {
        existingPrs = JSON.parse(raw).prs || "";
      } else {
        const prsLine = raw.split("\\n").find((l) => l.startsWith("prs="));
        existingPrs = prsLine ? prsLine.slice(4) : "";
      }
    } catch {}
    const newPrs = !existingPrs
      ? prUrl
      : existingPrs.split(",").map((u) => u.trim()).includes(prUrl)
        ? existingPrs
        : existingPrs + "," + prUrl;
    updateMetadataKey("pr", prUrl);
    updateMetadataKey("prs", newPrs);
    updateMetadataKey("status", "pr_open");
    process.stdout.write(JSON.stringify({ systemMessage: "Updated metadata: PR created at " + prUrl }) + "\\n");
    process.exit(0);
  }
}

// Detect: git checkout -b <branch> or git switch -c <branch>
const checkoutNewBranch = cleanCommand.match(/^git\\s+checkout\\s+-b\\s+(\\S+)/) ||
  cleanCommand.match(/^git\\s+switch\\s+-c\\s+(\\S+)/);
if (checkoutNewBranch) {
  const branch = checkoutNewBranch[1];
  if (branch) {
    updateMetadataKey("branch", branch);
    process.stdout.write(JSON.stringify({ systemMessage: "Updated metadata: branch = " + branch }) + "\\n");
    process.exit(0);
  }
}

// Detect: git checkout <branch> or git switch <branch> (without -b/-c)
// Only update if branch looks like a feature branch (contains / or -)
const checkoutBranch = cleanCommand.match(/^git\\s+checkout\\s+([^\\s-]+[/-][^\\s]+)/) ||
  cleanCommand.match(/^git\\s+switch\\s+([^\\s-]+[/-][^\\s]+)/);
if (checkoutBranch) {
  const branch = checkoutBranch[1];
  if (branch && branch !== "HEAD") {
    updateMetadataKey("branch", branch);
    process.stdout.write(JSON.stringify({ systemMessage: "Updated metadata: branch = " + branch }) + "\\n");
    process.exit(0);
  }
}

// Detect: gh pr merge
if (/^gh\\s+pr\\s+merge/.test(cleanCommand)) {
  updateMetadataKey("status", "merged");
  process.stdout.write(JSON.stringify({ systemMessage: "Updated metadata: status = merged" }) + "\\n");
  process.exit(0);
}

// No matching command
process.stdout.write("{}\\n");
process.exit(0);
`;

// =============================================================================
// Activity Updater Hook Script
// =============================================================================

/**
 * Bash hook script that translates Claude Code lifecycle hooks into AO activity
 * JSONL entries. Registered on every event whose firing carries activity
 * information (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 * PermissionRequest, Notification, Stop, SubagentStop, StopFailure, PreCompact,
 * PostCompact, SubagentStart, PostToolBatch).
 *
 * Reads the JSON payload from stdin, parses `hook_event_name`, maps it to an
 * activity state, and appends a single JSONL entry to
 * `$CLAUDE_PROJECT_DIR/.ao/activity.jsonl` with `source: "hook"`.
 *
 * Notification is filtered by `notification_type` — only `permission_prompt`
 * and `idle_prompt` map to `waiting_input`; `auth_success`/`elicitation_*` etc.
 * are skipped because they don't represent a stuck-on-the-user transition.
 *
 * The script always exits 0 (never blocks Claude). Unknown events exit
 * silently. Exported for integration testing.
 */
export const ACTIVITY_UPDATER_SCRIPT = `#!/usr/bin/env bash
# Activity Updater Hook for Agent Orchestrator
#
# Records Claude Code lifecycle events to {workspace}/.ao/activity.jsonl so
# the dashboard / lifecycle reducer derives activity state from authoritative
# platform events instead of regex over rendered terminal output. (#1941)

set -uo pipefail

input=$(cat)

if command -v jq &>/dev/null; then
  event=$(printf '%s' "$input" | jq -r '.hook_event_name // empty')
  notif_type=$(printf '%s' "$input" | jq -r '.notification_type // empty')
  tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty')
  error_type=$(printf '%s' "$input" | jq -r '.error_type // empty')
else
  event=$(printf '%s' "$input" | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
  notif_type=$(printf '%s' "$input" | grep -o '"notification_type"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
  tool_name=$(printf '%s' "$input" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
  error_type=$(printf '%s' "$input" | grep -o '"error_type"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
fi

state=""
trigger=""
case "$event" in
  SessionStart|Stop|SubagentStop)
    state="ready"
    trigger="$event"
    ;;
  UserPromptSubmit|PreToolUse|PostToolUse|PostToolUseFailure|PreCompact|PostCompact|SubagentStart|PostToolBatch)
    state="active"
    trigger="$event"
    ;;
  PermissionRequest)
    state="waiting_input"
    if [[ -n "$tool_name" ]]; then
      trigger="PermissionRequest ($tool_name)"
    else
      trigger="PermissionRequest"
    fi
    ;;
  Notification)
    if [[ "$notif_type" == "permission_prompt" || "$notif_type" == "idle_prompt" ]]; then
      state="waiting_input"
      trigger="Notification ($notif_type)"
    else
      # auth_success / elicitation_* / unrecognized — not an activity transition
      echo '{}'
      exit 0
    fi
    ;;
  StopFailure)
    state="blocked"
    if [[ -n "$error_type" ]]; then
      trigger="StopFailure ($error_type)"
    else
      trigger="StopFailure"
    fi
    ;;
  *)
    echo '{}'
    exit 0
    ;;
esac

workspace="\${CLAUDE_PROJECT_DIR:-$(pwd)}"
log_dir="$workspace/.ao"
log_file="$log_dir/activity.jsonl"

mkdir -p "$log_dir" 2>/dev/null || { echo '{}'; exit 0; }

# Node is a hard runtime dep of Claude Code, so node -p is always available
# and gives millisecond-precision ISO timestamps matching the rest of the
# activity-JSONL log. Fall back to seconds-precision date for the unlikely
# case where node is unavailable (still valid ISO 8601).
ts=$(node -p 'new Date().toISOString()' 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

# Escape JSON-special characters in the trigger value. Triggers are bounded
# today to event/tool/error names (no control chars in practice) but escape
# defensively — \\ and " for content, plus the five common control chars
# (\\n \\r \\t \\b \\f) so the JSONL line stays parseable for any future
# trigger source. Matches what Node's JSON.stringify produces in the .cjs
# variant so both implementations stay in lockstep.
escape_json() {
  local s="$1"
  s="\${s//\\\\/\\\\\\\\}"
  s="\${s//\\"/\\\\\\"}"
  s="\${s//$'\\n'/\\\\n}"
  s="\${s//$'\\r'/\\\\r}"
  s="\${s//$'\\t'/\\\\t}"
  s="\${s//$'\\b'/\\\\b}"
  s="\${s//$'\\f'/\\\\f}"
  printf '%s' "$s"
}

if [[ "$state" == "waiting_input" || "$state" == "blocked" ]]; then
  esc_trigger=$(escape_json "$trigger")
  printf '{"ts":"%s","state":"%s","source":"hook","trigger":"%s"}\\n' "$ts" "$state" "$esc_trigger" >> "$log_file"
else
  printf '{"ts":"%s","state":"%s","source":"hook"}\\n' "$ts" "$state" >> "$log_file"
fi

echo '{}'
exit 0
`;

/**
 * Node.js equivalent of ACTIVITY_UPDATER_SCRIPT for Windows. No bash, no jq,
 * no shebang interpretation; relies only on Node built-ins. Exported for
 * testing.
 */
export const ACTIVITY_UPDATER_SCRIPT_NODE = `#!/usr/bin/env node
// Activity Updater Hook for Agent Orchestrator (Node.js — Windows). See
// ACTIVITY_UPDATER_SCRIPT for the canonical bash version. (#1941)

const { appendFileSync, mkdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

let inputRaw = "";
try {
  inputRaw = readFileSync(0, "utf-8");
} catch {
  process.stdout.write("{}\\n");
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(inputRaw || "{}");
} catch {
  process.stdout.write("{}\\n");
  process.exit(0);
}

const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
const notifType = typeof payload.notification_type === "string" ? payload.notification_type : "";
const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
const errorType = typeof payload.error_type === "string" ? payload.error_type : "";

let state = "";
let trigger = "";
switch (event) {
  case "SessionStart":
  case "Stop":
  case "SubagentStop":
    state = "ready";
    trigger = event;
    break;
  case "UserPromptSubmit":
  case "PreToolUse":
  case "PostToolUse":
  case "PostToolUseFailure":
  case "PreCompact":
  case "PostCompact":
  case "SubagentStart":
  case "PostToolBatch":
    state = "active";
    trigger = event;
    break;
  case "PermissionRequest":
    state = "waiting_input";
    trigger = toolName ? \`PermissionRequest (\${toolName})\` : "PermissionRequest";
    break;
  case "Notification":
    if (notifType === "permission_prompt" || notifType === "idle_prompt") {
      state = "waiting_input";
      trigger = \`Notification (\${notifType})\`;
    } else {
      process.stdout.write("{}\\n");
      process.exit(0);
    }
    break;
  case "StopFailure":
    state = "blocked";
    trigger = errorType ? \`StopFailure (\${errorType})\` : "StopFailure";
    break;
  default:
    process.stdout.write("{}\\n");
    process.exit(0);
}

const workspace = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const logDir = join(workspace, ".ao");
const logFile = join(logDir, "activity.jsonl");

try {
  mkdirSync(logDir, { recursive: true });
} catch {
  process.stdout.write("{}\\n");
  process.exit(0);
}

const ts = new Date().toISOString();
const entry =
  state === "waiting_input" || state === "blocked"
    ? { ts, state, source: "hook", trigger }
    : { ts, state, source: "hook" };

try {
  appendFileSync(logFile, JSON.stringify(entry) + "\\n", "utf-8");
} catch {
  // Best-effort — never block Claude on log append failure
}

process.stdout.write("{}\\n");
process.exit(0);
`;

// =============================================================================
// Orchestrator Discipline Hook Scripts (Maestro — fresh-install parity)
// =============================================================================
//
// Three PreToolUse hooks that keep the orchestrator/worker discipline working on
// ANY machine, not just the developer's ~/.claude. They are written into every
// per-session .claude/ (like the activity/metadata updaters) and self-gate so
// they only act inside an AO *orchestrator* worktree (.../worktrees/<name>-orchestrator)
// — workers, the user's own Claude session, and the source repos are never touched.
//
// They are Node (.cjs), not bash: Node is a hard runtime dependency of Claude
// Code (see ACTIVITY_UPDATER_SCRIPT) while `jq` is not, so a Node port enforces
// the discipline on a fresh install with exact JSON parsing, zero `jq` reliance,
// and one variant per platform. The hook command is
// `node "$CLAUDE_PROJECT_DIR/.claude/<name>.cjs"` (same shape as the Windows
// activity-updater), so it resolves correctly from any sub-cwd and needs no
// engine-relative path lookup. Each always exits 0 (allow) unless it emits a deny.

/**
 * PreToolUse(Edit|Write) — block the orchestrator from editing SOURCE inline,
 * forcing it to delegate to a worker. Portable Node port of
 * orchestrator-no-inline-code.sh. Exported for testing.
 */
export const ORCHESTRATOR_NO_INLINE_CODE_SCRIPT = `#!/usr/bin/env node
// PreToolUse (Edit|Write) — ENFORCE the orchestrator pattern: orchestrators
// coordinate + delegate; they must NOT edit source code inline. Workers
// implement. Portable Node port of orchestrator-no-inline-code.sh (no jq; exact
// JSON parse; cross-platform). Fires only when the SESSION cwd is an AO
// orchestrator worktree (.../worktrees/<name>-orchestrator) AND the edit target
// is a source file. Everything else (.md/.yaml/.json/.sh, scratchpad, .claude,
// .maestro, every WORKER worktree) is always allowed.
const fs = require("node:fs");
const path = require("node:path");

let payload = {};
try {
  payload = JSON.parse(fs.readFileSync(0, "utf-8") || "{}");
} catch {
  process.exit(0);
}

const cwd =
  (typeof payload.cwd === "string" && payload.cwd) ||
  process.env.CLAUDE_PROJECT_DIR ||
  process.cwd();

// Scope: ONLY AO-managed agent sessions, which always run inside a per-session
// worktree (.../worktrees/<name>). The user's own session and the source repos
// run elsewhere — never block those.
if (!cwd.includes("/worktrees/")) process.exit(0);
// Within AO worktrees, enforce ONLY on the orchestrator (basename ends in
// "-orchestrator"). Workers implement, so they are always allowed.
if (!path.basename(cwd).endsWith("-orchestrator")) process.exit(0);

const fp =
  payload.tool_input && typeof payload.tool_input.file_path === "string"
    ? payload.tool_input.file_path
    : "";
if (!fp) process.exit(0);

// Always-allowed locations (ops, scratch, config, hooks themselves, tmp).
if (
  fp.includes("/scratchpad/") ||
  fp.includes("/.claude/") ||
  fp.includes("/.maestro/") ||
  fp.startsWith("/tmp/") ||
  fp.startsWith("/private/tmp/") ||
  fp.startsWith("/var/folders/")
) {
  process.exit(0);
}

// Allowlist: ops files only — everything else is source → DENY
const ALLOWED_EXTS = new Set([
  ".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc",
  ".yaml", ".yml", ".json", ".jsonc", ".json5", ".toml",
  ".ini", ".cfg", ".conf", ".properties", ".env",
  ".sh", ".bash", ".zsh", ".fish",
  ".csv", ".tsv",
]);
const ALLOWED_BASENAMES = new Set([
  "Dockerfile", "Makefile", ".gitignore", ".gitattributes",
  ".dockerignore", ".editorconfig", ".npmrc", ".nvmrc",
  ".env", "LICENSE", "README",
]);
const basename = fp.split("/").pop() || "";
const dotIdx = basename.lastIndexOf(".");
const ext = dotIdx >= 0 ? basename.slice(dotIdx) : "";
// Allow .env.* files (e.g. .env.local, .env.production)
const isAllowedBasename = ALLOWED_BASENAMES.has(basename) || basename.startsWith(".env");
if (!isAllowedBasename && !ALLOWED_EXTS.has(ext)) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Orchestrators must DELEGATE code work to a visible worker (ao spawn / ao send) — do not edit source inline. Only ops files (docs .md, config .yaml/.json/.toml, scripts .sh) and the scratchpad/.claude/.maestro dirs are editable here. Scope the change, spawn a worker, then review + merge its branch.",
      },
    }),
  );
}
process.exit(0);
`;

/**
 * PreToolUse(Bash) — block the orchestrator from writing/reverting SOURCE via the
 * shell (git checkout/restore, sed -i, redirect/tee into a source file). Portable
 * Node port of orchestrator-no-source-shell.sh. Exported for testing.
 */
export const ORCHESTRATOR_NO_SOURCE_SHELL_SCRIPT = `#!/usr/bin/env node
// PreToolUse (Bash) — close the loophole: orchestrators must NOT touch source
// CODE via the shell. Complements orchestrator-no-inline-code (Edit/Write only).
// Portable Node port of orchestrator-no-source-shell.sh (no jq). Blocks, for
// ORCHESTRATOR worktrees only: git checkout/restore of a source file, sed -i on
// a source file, and shell redirect ( > / >> ) or tee into a source file.
// ALLOWED: git merge/commit/log/show/diff/status, grep/cat reads, and ALL
// non-source files. Workers untouched.
const fs = require("node:fs");
const path = require("node:path");

let payload = {};
try {
  payload = JSON.parse(fs.readFileSync(0, "utf-8") || "{}");
} catch {
  process.exit(0);
}

const cwd =
  (typeof payload.cwd === "string" && payload.cwd) ||
  process.env.CLAUDE_PROJECT_DIR ||
  process.cwd();
if (!cwd.includes("/worktrees/")) process.exit(0);
if (!path.basename(cwd).endsWith("-orchestrator")) process.exit(0);

const cmd =
  payload.tool_input && typeof payload.tool_input.command === "string"
    ? payload.tool_input.command
    : "";
if (!cmd) process.exit(0);

// A source-file reference: a dot + known code extension at a word boundary.
const SRC = /\\.(swift|ts|tsx|rs|js|jsx|mjs|cjs|go|kt|kts|java|scala|py|pyi|pyx|rb|php|phtml|vue|svelte|astro|c|cc|cpp|cxx|h|hpp|hxx|m|mm|cs|dart|lua|r|pl|ex|exs|erl|clj|graphql|gql|proto|css|scss|sass|less|html|htm|sql)\\b/;

function deny(what) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Orchestrators must DELEGATE code — no writing/reverting SOURCE via shell (" +
          what +
          "). git merge/commit/log/show/diff + reads are fine; code changes (incl. file-level reverts) go to a worker (ao spawn / ao send) or are done by merging a worker branch. (.md/.yaml/.json/.sh + scratchpad still ok.)",
      },
    }),
  );
  process.exit(0);
}

// git checkout/restore of a source file (file-level) — NOT a branch checkout.
if (/\\bgit\\s+(checkout|restore)\\b/.test(cmd) && SRC.test(cmd)) {
  deny("git checkout/restore of source");
}
// sed -i editing a source file.
if (/\\bsed\\s+-i/.test(cmd) && SRC.test(cmd)) {
  deny("sed -i on source");
}
// redirect ( > / >> ) writing a source file.
if (/>>?\\s*[^\\s|;&<>]*\\.(swift|ts|tsx|rs|js|jsx|mjs|cjs|go|kt|kts|java|scala|py|pyi|pyx|rb|php|phtml|vue|svelte|astro|c|cc|cpp|cxx|h|hpp|hxx|m|mm|cs|dart|lua|r|pl|ex|exs|erl|clj|graphql|gql|proto|css|scss|sass|less|html|htm|sql)\\b/.test(cmd)) {
  deny("redirect into source");
}
// tee writing a source file.
if (/tee\\s+[^|]*\\.(swift|ts|tsx|rs|js|jsx|mjs|cjs|go|kt|kts|java|scala|py|pyi|pyx|rb|php|phtml|vue|svelte|astro|c|cc|cpp|cxx|h|hpp|hxx|m|mm|cs|dart|lua|r|pl|ex|exs|erl|clj|graphql|gql|proto|css|scss|sass|less|html|htm|sql)\\b/.test(cmd)) {
  deny("tee into source");
}
process.exit(0);
`;

/**
 * PreToolUse(Bash) on `ao spawn` — query rlm (maestro-search) over past/deleted
 * agent transcripts and surface the top snippets as additionalContext so the
 * orchestrator seeds the new worker with prior context. Portable Node port of
 * pre-spawn-rlm.sh with NO hardcoded binary path. NON-BLOCKING. Exported for testing.
 */
export const PRE_SPAWN_RLM_SCRIPT = `#!/usr/bin/env node
// PreToolUse (Bash) — before an 'ao spawn', query rlm (maestro-search) over past/
// deleted-agent transcripts and surface the top prior-context snippets as
// additionalContext, so the orchestrator seeds the new worker with what was
// learned before. NON-BLOCKING: always allows the spawn; any error → silent
// exit 0. Portable Node port of pre-spawn-rlm.sh with NO hardcoded binary path:
// resolve order is MAESTRO_SEARCH_BIN env → PATH → Maestro.app bundle → ~/.local/bin.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

let payload = {};
try {
  payload = JSON.parse(fs.readFileSync(0, "utf-8") || "{}");
} catch {
  process.exit(0);
}

const cmd =
  payload.tool_input && typeof payload.tool_input.command === "string"
    ? payload.tool_input.command
    : "";
if (cmd.indexOf("ao spawn") === -1) process.exit(0);

// Resolve maestro-search WITHOUT any hardcoded path (fresh-install parity).
function isExec(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function resolveSearch() {
  const envBin = process.env.MAESTRO_SEARCH_BIN;
  if (envBin && isExec(envBin)) return envBin;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir && isExec(path.join(dir, "maestro-search"))) {
      return path.join(dir, "maestro-search");
    }
  }
  const home = process.env.HOME || "";
  const candidates = [
    "/Applications/Maestro.app/Contents/MacOS/maestro-search",
    home ? path.join(home, "Applications/Maestro.app/Contents/MacOS/maestro-search") : "",
    home ? path.join(home, ".local/bin/maestro-search") : "",
  ];
  for (const c of candidates) {
    if (c && isExec(c)) return c;
  }
  return "";
}
const MS = resolveSearch();
if (!MS) process.exit(0);

// Keywords: --title plus the first 40 lines of --prompt-file (or --prompt text).
function cap(re) {
  const m = cmd.match(re);
  return m ? m[1] : "";
}
let kw = cap(/--title\\s+"([^"]*)"/);
const pf = cap(/--prompt-file\\s+"([^"]*)"/);
if (pf && fs.existsSync(pf)) {
  try {
    kw = kw + " " + fs.readFileSync(pf, "utf-8").split("\\n").slice(0, 40).join(" ");
  } catch {
    // ignore an unreadable prompt file
  }
} else {
  kw = kw + " " + cap(/--prompt\\s+"([^"]*)"/);
}
kw = kw
  .replace(/[^A-Za-zА-Яа-я0-9 ]+/g, " ")
  .replace(/\\s+/g, " ")
  .trim()
  .slice(0, 300);
if (!kw) process.exit(0);

let res = "";
try {
  res = execFileSync(MS, ["query", kw, "--limit", "8"], {
    encoding: "utf-8",
    timeout: 8000,
    maxBuffer: 1048576,
  });
} catch {
  process.exit(0);
}
res = (res || "").slice(0, 4000);
if (!res.trim()) process.exit(0);

const ctx =
  "[rlm pre-spawn — prior context from past/deleted agents; seed the worker with what's relevant before it starts]\\n" +
  res +
  "\\n\\nReminder: record this delegation on .maestro/tasks.md (in progress).";
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: ctx },
  }),
);
process.exit(0);
`;

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "claude-code",
  slot: "agent" as const,
  description: "Agent plugin: Claude Code CLI",
  version: "0.1.0",
  displayName: "Claude Code",
};

// =============================================================================
// JSONL Helpers
// =============================================================================

interface JsonlLine {
  type?: string;
  summary?: string;
  message?: { content?: string; role?: string };
  // Cost/usage fields
  costUSD?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

/**
 * Read only the last chunk of a JSONL file to extract the last entry's type
 * and the file's modification time. This is optimized for polling — it avoids
 * reading the entire file (which `getSessionInfo()` does for full cost/summary).
 * Now uses the shared readLastJsonlEntry utility from @aoagents/ao-core.
 */

/**
 * Parse only the last `maxBytes` of a JSONL file.
 * Summaries and recent activity are always near the end, so reading the whole
 * file (which can be 100MB+) is wasteful. For files smaller than maxBytes,
 * readFile is used directly. For large files, only the tail is read via a
 * file handle to avoid loading the entire file into memory.
 */
async function parseJsonlFileTail(filePath: string, maxBytes = 131_072): Promise<JsonlLine[]> {
  let content: string;
  let offset: number;
  try {
    const { size = 0 } = await stat(filePath);
    offset = Math.max(0, size - maxBytes);
    if (offset === 0) {
      // Small file (or unknown size) — read it whole
      content = await readFile(filePath, "utf-8");
    } else {
      // Large file — read only the tail via a file handle
      const handle = await open(filePath, "r");
      try {
        const length = size - offset;
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, offset);
        content = buffer.toString("utf-8");
      } finally {
        await handle.close();
      }
    }
  } catch {
    return [];
  }
  // Skip potentially truncated first line only when we started mid-file.
  // If offset === 0 we read from the start so the first line is complete.
  const firstNewline = content.indexOf("\n");
  const safeContent = offset > 0 && firstNewline >= 0 ? content.slice(firstNewline + 1) : content;
  const lines: JsonlLine[] = [];
  for (const line of safeContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        lines.push(parsed as JsonlLine);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return lines;
}

/** Extract auto-generated summary from JSONL (last "summary" type entry) */
function extractSummary(lines: JsonlLine[]): { summary: string; isFallback: boolean } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line?.type === "summary" && line.summary) {
      return { summary: line.summary, isFallback: false };
    }
  }
  // Fallback: first user message truncated to 120 chars
  for (const line of lines) {
    if (
      line?.type === "user" &&
      line.message?.content &&
      typeof line.message.content === "string"
    ) {
      const msg = line.message.content.trim();
      if (msg.length > 0) {
        return {
          summary: msg.length > 120 ? msg.substring(0, 120) + "..." : msg,
          isFallback: true,
        };
      }
    }
  }
  return null;
}

/** Aggregate cost estimate from JSONL usage events */
function extractCost(lines: JsonlLine[]): CostEstimate | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedReadTokens = 0;
  let cacheCreationTokens = 0;
  let totalCost = 0;

  for (const line of lines) {
    // Handle direct cost fields — prefer costUSD; only use estimatedCostUsd
    // as fallback to avoid double-counting when both are present.
    if (typeof line.costUSD === "number") {
      totalCost += line.costUSD;
    } else if (typeof line.estimatedCostUsd === "number") {
      totalCost += line.estimatedCostUsd;
    }
    // Handle token counts — prefer the structured `usage` object when present;
    // only fall back to flat `inputTokens`/`outputTokens` fields to avoid
    // double-counting if a line contains both.
    if (line.usage) {
      inputTokens += line.usage.input_tokens ?? 0;
      cachedReadTokens += line.usage.cache_read_input_tokens ?? 0;
      cacheCreationTokens += line.usage.cache_creation_input_tokens ?? 0;
      outputTokens += line.usage.output_tokens ?? 0;
    } else {
      if (typeof line.inputTokens === "number") {
        inputTokens += line.inputTokens;
      }
      if (typeof line.outputTokens === "number") {
        outputTokens += line.outputTokens;
      }
    }
  }

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    totalCost === 0 &&
    cachedReadTokens === 0 &&
    cacheCreationTokens === 0
  ) {
    return undefined;
  }

  if (totalCost === 0) {
    totalCost =
      (inputTokens / 1_000_000) * 3.0 +
      (outputTokens / 1_000_000) * 15.0 +
      (cachedReadTokens / 1_000_000) * 0.3 +
      (cacheCreationTokens / 1_000_000) * 3.75;
  }

  return {
    inputTokens: inputTokens + cachedReadTokens + cacheCreationTokens,
    outputTokens,
    estimatedCostUsd: totalCost,
  };
}

// =============================================================================
// Hook Setup Helper
// =============================================================================

/**
 * Single hook registration: which event, which variant (matcher), which
 * command to invoke, and a substring used to find-and-update an existing
 * entry so repeated setup calls are idempotent.
 */
interface HookRegistration {
  event: string;
  matcher: string;
  command: string;
  timeout: number;
  /** Substring(s) of `command` that identify a pre-existing entry to update. */
  identifiers: ReadonlyArray<string>;
}

/**
 * Set the registration's hook in the `event`'s hook array, updating any
 * existing entry whose command contains one of `identifiers` (idempotent).
 *
 * Tolerates malformed pre-existing settings: if `hooks[event]` is not an
 * array (object, string, missing) we start a fresh array rather than
 * throwing on `.push`.
 *
 * Only refreshes the entry-level `matcher` when the entry contains a single
 * hook def (ours). When a user has co-located their own hook def in the
 * same `{ matcher, hooks: [...] }` object, we leave their matcher alone and
 * only update our def's `command`/`timeout` so their hook keeps firing on
 * the matchers they chose.
 */
function upsertHookEntry(
  hooks: Record<string, unknown>,
  reg: HookRegistration,
): void {
  const existing = hooks[reg.event];
  const entries: Array<unknown> = Array.isArray(existing) ? existing : [];

  let foundEntryIdx = -1;
  let foundDefIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const hooksList = (entry as Record<string, unknown>)["hooks"];
    if (!Array.isArray(hooksList)) continue;
    for (let j = 0; j < hooksList.length; j++) {
      const def = hooksList[j];
      if (typeof def !== "object" || def === null || Array.isArray(def)) continue;
      const cmd = (def as Record<string, unknown>)["command"];
      if (typeof cmd === "string" && reg.identifiers.some((id) => cmd.includes(id))) {
        foundEntryIdx = i;
        foundDefIdx = j;
        break;
      }
    }
    if (foundEntryIdx >= 0) break;
  }

  if (foundEntryIdx === -1) {
    entries.push({
      matcher: reg.matcher,
      hooks: [{ type: "command", command: reg.command, timeout: reg.timeout }],
    });
  } else {
    const entry = entries[foundEntryIdx] as Record<string, unknown>;
    const hooksList = entry["hooks"] as Array<Record<string, unknown>>;
    hooksList[foundDefIdx]!["command"] = reg.command;
    hooksList[foundDefIdx]!["timeout"] = reg.timeout;
    // Only refresh the matcher when the entry is clearly owned by AO
    // (single hook def == ours). With multiple defs the entry is shared
    // with a user hook; changing the matcher would change when their hook
    // fires.
    if (hooksList.length === 1) {
      entry["matcher"] = reg.matcher;
    }
  }

  hooks[reg.event] = entries;
}

/** Commands for the three orchestrator-discipline hooks (Maestro). */
interface DisciplineCommands {
  noInline: string;
  noSourceShell: string;
  preSpawn: string;
}

/**
 * Build the list of hooks to register for this workspace. Scripts installed:
 *   - metadata-updater: PostToolUse(Bash) only — extracts gh/git side-effects.
 *   - activity-updater: every event that carries activity information, so
 *     dashboard / lifecycle reducer state derives from platform events
 *     instead of regex over rendered terminal output (#1941).
 *   - orchestrator discipline (Maestro): PreToolUse(Edit|Write) blocks inline
 *     source edits by an orchestrator; PreToolUse(Bash) blocks source writes via
 *     the shell and seeds prior rlm context before `ao spawn`. These self-gate
 *     to orchestrator worktrees, so they are harmless no-ops everywhere else.
 *
 * Activity events use matcher "" — match every variant. PermissionRequest's
 * tool-name and Notification's notification_type are filtered inside the
 * script itself so the registered set stays small.
 */
function buildHookRegistrations(
  metadataCommand: string,
  activityCommand: string,
  discipline: DisciplineCommands,
): HookRegistration[] {
  const METADATA_IDS = [
    "metadata-updater.sh",
    "metadata-updater.cjs",
    "metadata-updater.js",
  ] as const;
  const ACTIVITY_IDS = ["activity-updater.sh", "activity-updater.cjs"] as const;

  const regs: HookRegistration[] = [
    {
      event: "PostToolUse",
      matcher: "Bash",
      command: metadataCommand,
      timeout: 5000,
      identifiers: METADATA_IDS,
    },
  ];

  // Activity-updater events. Every event that the activity-updater script
  // knows how to map (see ACTIVITY_UPDATER_SCRIPT) must be registered here;
  // unregistered events fire no hook, so unrecognized hooks waste no time.
  const activityEvents = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "Notification",
    "PermissionRequest",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
  ];
  for (const event of activityEvents) {
    regs.push({
      event,
      matcher: "",
      command: activityCommand,
      // Hook execution is best-effort and the activity-updater is intentionally
      // O(few ms): JSON parse, one append, exit. A short timeout keeps a stuck
      // hook from slowing a turn down.
      timeout: 2000,
      identifiers: ACTIVITY_IDS,
    });
  }

  // Orchestrator-discipline hooks (Maestro fresh-install parity). Timeouts are
  // in seconds (Claude Code's unit): the gate checks are O(ms), and pre-spawn
  // rlm runs maestro-search with its own internal 8s cap. Each self-gates to
  // orchestrator worktrees, so they no-op for workers / non-Maestro ao users.
  regs.push(
    {
      event: "PreToolUse",
      matcher: "Edit|Write",
      command: discipline.noInline,
      timeout: 10,
      identifiers: ["orchestrator-no-inline-code.cjs", "orchestrator-no-inline-code.sh"],
    },
    {
      event: "PreToolUse",
      matcher: "Bash",
      command: discipline.noSourceShell,
      timeout: 10,
      identifiers: ["orchestrator-no-source-shell.cjs", "orchestrator-no-source-shell.sh"],
    },
    {
      event: "PreToolUse",
      matcher: "Bash",
      command: discipline.preSpawn,
      timeout: 25,
      identifiers: ["pre-spawn-rlm.cjs", "pre-spawn-rlm.sh"],
    },
  );

  return regs;
}

/**
 * Install Claude Code workspace hooks. Writes both helper scripts
 * (metadata-updater + activity-updater) and merges hook registrations into
 * `.claude/settings.json` — preserving any user-installed hooks, updating our
 * own in place on repeated calls.
 */
async function setupHookInWorkspace(workspacePath: string): Promise<void> {
  const claudeDir = join(workspacePath, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  try {
    await mkdir(claudeDir, { recursive: true });
  } catch {
    // Directory may already exist; ignore
  }

  let metadataCommand: string;
  let activityCommand: string;
  if (isWindows()) {
    const metadataPath = join(claudeDir, "metadata-updater.cjs");
    const activityPath = join(claudeDir, "activity-updater.cjs");
    await writeFile(metadataPath, METADATA_UPDATER_SCRIPT_NODE, "utf-8");
    await writeFile(activityPath, ACTIVITY_UPDATER_SCRIPT_NODE, "utf-8");
    // .cjs forces CJS regardless of workspace package.json "type"; node
    // invocation is required on Windows because shebangs aren't honoured.
    // $CLAUDE_PROJECT_DIR (set by Claude Code to the worktree root) keeps the
    // command identical across worktrees while resolving from any sub-cwd.
    metadataCommand = 'node "$CLAUDE_PROJECT_DIR/.claude/metadata-updater.cjs"';
    activityCommand = 'node "$CLAUDE_PROJECT_DIR/.claude/activity-updater.cjs"';
  } else {
    const metadataPath = join(claudeDir, "metadata-updater.sh");
    const activityPath = join(claudeDir, "activity-updater.sh");
    await writeFile(metadataPath, METADATA_UPDATER_SCRIPT, "utf-8");
    await writeFile(activityPath, ACTIVITY_UPDATER_SCRIPT, "utf-8");
    await chmod(metadataPath, 0o755);
    await chmod(activityPath, 0o755);
    // $CLAUDE_PROJECT_DIR (set by Claude Code to the worktree root) keeps the
    // command identical across worktrees while resolving from any sub-cwd.
    metadataCommand = '"$CLAUDE_PROJECT_DIR/.claude/metadata-updater.sh"';
    activityCommand = '"$CLAUDE_PROJECT_DIR/.claude/activity-updater.sh"';
  }

  // Orchestrator-discipline hooks (Maestro fresh-install parity). Always Node
  // (.cjs) on every platform — Node is a hard dependency of Claude Code, so one
  // variant enforces the discipline without jq. Invoked as `node "<path>.cjs"`,
  // so no execute bit is needed (unlike the bash activity/metadata updaters).
  // The scripts self-gate to orchestrator worktrees; writing them everywhere is
  // safe and keeps the command string identical across symlinked .claude/ dirs.
  await writeFile(
    join(claudeDir, "orchestrator-no-inline-code.cjs"),
    ORCHESTRATOR_NO_INLINE_CODE_SCRIPT,
    "utf-8",
  );
  await writeFile(
    join(claudeDir, "orchestrator-no-source-shell.cjs"),
    ORCHESTRATOR_NO_SOURCE_SHELL_SCRIPT,
    "utf-8",
  );
  await writeFile(
    join(claudeDir, "pre-spawn-rlm.cjs"),
    PRE_SPAWN_RLM_SCRIPT,
    "utf-8",
  );
  const discipline: DisciplineCommands = {
    noInline: 'node "$CLAUDE_PROJECT_DIR/.claude/orchestrator-no-inline-code.cjs"',
    noSourceShell: 'node "$CLAUDE_PROJECT_DIR/.claude/orchestrator-no-source-shell.cjs"',
    preSpawn: 'node "$CLAUDE_PROJECT_DIR/.claude/pre-spawn-rlm.cjs"',
  };

  let existingSettings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const content = await readFile(settingsPath, "utf-8");
      existingSettings = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Invalid JSON or read error — start fresh
    }
  }

  const hooks = (existingSettings["hooks"] as Record<string, unknown>) ?? {};
  for (const reg of buildHookRegistrations(metadataCommand, activityCommand, discipline)) {
    upsertHookEntry(hooks, reg);
  }
  existingSettings["hooks"] = hooks;

  await writeFile(settingsPath, JSON.stringify(existingSettings, null, 2) + "\n", "utf-8");
}

// =============================================================================
// Agent Implementation
// =============================================================================

function createClaudeCodeAgent(): Agent {
  return {
    name: "claude-code",
    processName: "claude",
    // Static capability descriptor (provider-independent scaling seam). Numbers
    // reflect the Claude Code CLI / Claude model family: 1M-token context, 32MB
    // max request body, 500MB max file, and the directly-readable file types.
    limits: {
      contextTokens: 1_000_000,
      maxRequestBytes: 33_554_432,
      maxFileBytes: 524_288_000,
      supportedFileTypes: ["pdf", "png", "jpg", "jpeg", "gif", "webp", "txt"],
    },
    getLaunchCommand(config: AgentLaunchConfig): string {
      // Note: CLAUDECODE is unset via getEnvironment() (set to ""), not here.
      // This command must be safe for both shell and execFile contexts.
      const parts: string[] = ["claude"];

      const permissionMode = normalizeAgentPermissionMode(config.permissions);
      if (permissionMode === "permissionless" || permissionMode === "auto-edit") {
        parts.push("--dangerously-skip-permissions");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      if (config.systemPromptFile) {
        if (isWindows()) {
          // Windows: $(cat ...) is bash syntax, not understood by PowerShell/cmd.exe.
          // Read the file synchronously and inline the content instead.
          const content = readFileSync(config.systemPromptFile, "utf-8");
          parts.push("--append-system-prompt", shellEscape(content));
        } else {
          // Unix: use shell command substitution to read from file at launch time.
          // This avoids tmux truncation when inlining 2000+ char prompts.
          // The double quotes allow $() expansion; inner path is single-quoted for safety.
          parts.push("--append-system-prompt", `"$(cat ${shellEscape(config.systemPromptFile)})"`);
        }
      } else if (config.systemPrompt) {
        parts.push("--append-system-prompt", shellEscape(config.systemPrompt));
      }

      // The positional [prompt] argument auto-submits as the first user turn
      // and keeps Claude in interactive mode. -p / --print is what triggers
      // headless one-shot exit, not the presence of a prompt.
      if (config.prompt) {
        parts.push("--", shellEscape(config.prompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};

      // Unset CLAUDECODE to avoid nested agent conflicts
      env["CLAUDECODE"] = "";

      // Set session info for introspection
      env["AO_SESSION_ID"] = config.sessionId;

      // NOTE: AO_PROJECT_ID is NOT set here - it's the caller's responsibility
      // to set it based on their metadata path scheme:
      // - spawn.ts sets it to projectId for project-specific directories
      // - start.ts omits it for orchestrator (flat directories)
      // - session manager omits it (flat directories)

      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      // runtime-sdk parity. The tmux runtime gets the task/model from the launch
      // command (getLaunchCommand: positional [prompt], --model). The SDK runtime
      // has no launch command — sdk-host reads these from the environment instead.
      // Without AO_SDK_INITIAL_PROMPT a spawned SDK session starts idle (host
      // signals READY but never submits the first turn, so it does no work). The
      // host defaults permission mode to bypassPermissions (autonomous), matching
      // AO workers; AO_SDK_RESUME is set by the caller when resuming.
      if (config.prompt) {
        env["AO_SDK_INITIAL_PROMPT"] = config.prompt;
      }
      // Persona/rules persistence for the SDK runtime. The tmux runtime delivers
      // the system prompt via the launch command's --append-system-prompt; the
      // SDK runtime has NO launch command, so it reads the persona file path from
      // this env var and appends it to the Claude Code preset on EVERY request
      // (sdk-host readAppendSystemPrompt). This is what makes the orchestrator/
      // worker persona survive resume — turn-1 (AO_SDK_INITIAL_PROMPT) is not
      // re-submitted on host restart, but the system prompt always is. We pass the
      // FILE path (not the content) to avoid env bloat: the file is already on
      // disk (worker-prompt-*.md / orchestrator-prompt-*.md) and outlives the spawn.
      if (config.systemPromptFile) {
        env["AO_SDK_SYSTEM_PROMPT_FILE"] = config.systemPromptFile;
      }
      if (config.model) {
        env["AO_SDK_MODEL"] = config.model;
        // Resolve the provider through the central ModelRegistry (registry-first,
        // prefix-fallback) instead of ad-hoc `startsWith` checks, and hand the
        // result to the sdk-host as AO_SDK_PROVIDER so the host dispatches the
        // driver from the registry rather than re-guessing from the model string.
        // For the current Claude/GLM/MiMo models this yields exactly the same
        // routing the prefix checks did. The strip list in runtime-sdk/index.ts
        // keeps AO_SDK_PROVIDER (and the keys below) per-session so they never
        // leak from an orchestrator into its workers.
        const provider = resolveProvider(config.model);
        const runtimeDriver = resolveDriver(config.model);
        env["AO_SDK_PROVIDER"] = provider;
        // GLM (ZhipuAI): inject the API key, resolved env → Keychain → config.yaml
        // (resolveProviderKey). env-first preserves the previous behaviour exactly
        // (the daemon is spawned by the app with AO_GLM_API_KEY set); the Keychain
        // and YAML steps are additive fallbacks.
        if (provider === "zhipu") {
          const glmKey = resolveProviderKey("zhipu", loadGlobalConfig(), process.env);
          if (glmKey) env["AO_GLM_API_KEY"] = glmKey;
        }
        // MiMo (Xiaomi): same pattern as GLM.
        if (provider === "mimo") {
          const mimoKey = resolveProviderKey("mimo", loadGlobalConfig(), process.env);
          if (mimoKey) env["AO_MIMO_API_KEY"] = mimoKey;
        }
        // OpenAI/GPT normally runs through Codex app-server (ChatGPT/Codex auth),
        // not the legacy API-key Responses path. Only inject an API key for a
        // non-Codex OpenAI driver.
        if (provider === "openai" && runtimeDriver !== "codex-app-server") {
          const openaiKey = resolveProviderKey("openai", loadGlobalConfig(), process.env);
          if (openaiKey) env["AO_OPENAI_API_KEY"] = openaiKey;
        }
      }

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      // #1941: Claude activity is derived from platform-event hooks
      // (PermissionRequest / StopFailure / Notification / Stop / ...) which
      // write directly to {workspace}/.ao/activity.jsonl. The terminal-regex
      // layer was structurally fragile (every UI tweak in Claude regressed
      // it; see the 15-commit churn in #1932) so it has been retired in
      // favour of those authoritative events.
      //
      // detectActivity is kept on the Agent interface for other plugins
      // (Aider, OpenCode, Codex fallback) that still rely on terminal output.
      // For Claude, classifyTerminalOutput is a stable "idle" stub — the
      // lifecycle manager only consults this method when getActivityState
      // returned null (no Claude process / no JSONL / no hook entry yet),
      // and in that no-signal case "idle" is the correct conservative
      // answer (we don't write it back to JSONL — recordActivity is also
      // intentionally omitted for Claude).
      return classifyTerminalOutput(terminalOutput);
    },

    // recordActivity is intentionally NOT implemented for the Claude agent
    // (#1941). Hooks write activity entries directly via the activity-updater
    // script, so polling-driven terminal-output classification would only add
    // stale duplicates to .ao/activity.jsonl.

    async isProcessRunning(handle: RuntimeHandle): Promise<ProcessProbeResult> {
      return isClaudeProcessAlive(handle);
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      return getClaudeActivityState(session, readyThresholdMs, (handle) =>
        this.isProcessRunning(handle),
      );
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      // Build the Claude project directory path
      const projectPath = toClaudeProjectPath(await resolveWorkspaceForClaude(session.workspacePath));
      const projectDir = join(homedir(), ".claude", "projects", projectPath);

      // Find the latest session JSONL file
      const sessionFile = await findLatestSessionFile(projectDir);
      if (!sessionFile) return null;

      // Parse only the tail — summaries are always near the end, files can be 100MB+
      const lines = await parseJsonlFileTail(sessionFile);
      if (lines.length === 0) return null;

      // Extract session ID from filename
      const agentSessionId = basename(sessionFile, ".jsonl");

      const summaryResult = extractSummary(lines);
      return {
        summary: summaryResult?.summary ?? null,
        summaryIsFallback: summaryResult?.isFallback,
        agentSessionId,
        metadata: { claudeSessionUuid: agentSessionId },
        cost: extractCost(lines),
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      let sessionUuid = session.metadata?.["claudeSessionUuid"]?.trim();
      if (!sessionUuid) {
        if (!session.workspacePath) return null;

        // Find Claude's project directory for this workspace
        const projectPath = toClaudeProjectPath(await resolveWorkspaceForClaude(session.workspacePath));
        const projectDir = join(homedir(), ".claude", "projects", projectPath);

        // Find the latest session JSONL file
        const sessionFile = await findLatestSessionFile(projectDir);
        if (!sessionFile) return null;

        // Extract session UUID from filename (e.g. "abc123-def456.jsonl" → "abc123-def456")
        sessionUuid = basename(sessionFile, ".jsonl");
      }
      if (!sessionUuid) return null;

      // Build resume command
      const parts: string[] = ["claude", "--resume", shellEscape(sessionUuid)];

      const permissionMode = normalizeAgentPermissionMode(project.agentConfig?.permissions);
      if (permissionMode === "permissionless" || permissionMode === "auto-edit") {
        parts.push("--dangerously-skip-permissions");
      }

      if (project.agentConfig?.model) {
        parts.push("--model", shellEscape(project.agentConfig.model as string));
      }

      return parts.join(" ");
    },

    detectRestorePromptKeys(recentOutput: string): string[] | null {
      // `claude --resume <uuid>` on an old/large session opens a BLOCKING
      // resume selector before the agent is usable:
      //
      //   This session is 1d old and 515.1k tokens.
      //   ❯ 1. Resume from summary (recommended)
      //     2. Resume full session as-is
      //     3. Don't ask me again
      //   Enter to confirm · Esc to cancel
      //
      // Claude Code 2.1.x exposes no flag, settings key, or env to pre-select
      // an option or skip the prompt (verified against 2.1.185), so with no
      // human at the pane we confirm the pre-highlighted default ("Resume from
      // summary") by sending Enter. The five-marker signature is strict enough
      // that it never matches ordinary agent output; the worst a mis-detection
      // could do is submit one empty line (a no-op in Claude's composer).
      const isResumeSelector =
        recentOutput.includes("Resume from summary") &&
        recentOutput.includes("Resume full session as-is") &&
        recentOutput.includes("Don't ask me again") &&
        recentOutput.includes("Enter to confirm") &&
        recentOutput.includes("Esc to cancel");
      return isResumeSelector ? ["Enter"] : null;
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      // Hook commands use $CLAUDE_PROJECT_DIR (the worktree root, set by Claude
      // Code) rather than the literal workspace path: the command string is then
      // identical across worktrees, so symlinked .claude/ dirs all produce the
      // same settings.json (last writer doesn't clobber), AND it resolves
      // correctly when the agent's cwd is a sub-directory of the worktree (a
      // bare relative path like `.claude/...` broke there with "No such file").
      await setupHookInWorkspace(workspacePath);
    },

    async postLaunchSetup(_session: Session): Promise<void> {
      // Hooks are installed pre-launch via setupWorkspaceHooks so that
      // PostToolUse hooks exist before the agent's first tool call.
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createClaudeCodeAgent();
}

export function detect(): boolean {
  try {
    // Use --version instead of `which` for cross-platform compatibility (Windows has no `which`).
    // shell:true on Windows so cmd.exe consults PATHEXT and finds .cmd shims (npm-installed CLIs).
    execFileSync("claude", ["--version"], {
      stdio: "ignore",
      shell: isWindows(),
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
