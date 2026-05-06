import {
  shellEscape,
  readLastJsonlEntry,
  normalizeAgentPermissionMode,
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type CostEstimate,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@aoagents/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { readdir, readFile, stat, open, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

/**
 * Convert a workspace path to Claude's project directory path.
 * Claude stores sessions at ~/.claude/projects/{encoded-path}/
 *
 * Verified against Claude Code's actual on-disk slugs: every non-alphanumeric
 * character (other than `-`) is replaced with `-`. That includes `/`, `.`,
 * and crucially `_` — AO's per-project data dirs are named like
 * `<sanitized>_<hash>`, and without underscore folding the slug AO computes
 * misses the directory Claude actually wrote (issue #1611).
 *
 * Windows drive letters keep their special handling: `C:\Users\...` → strip
 * the colon, then encode → `C-Users-...`.
 *
 * Exported for testing purposes.
 */
export function toClaudeProjectPath(workspacePath: string): string {
  // Handle Windows drive letters (C:\Users\... → C-Users-...)
  const normalized = workspacePath.replace(/\\/g, "/").replace(/:/g, "");
  return normalized.replace(/[^a-zA-Z0-9-]/g, "-");
}

/** Find the most recently modified .jsonl session file in a directory */
async function findLatestSessionFile(projectDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }

  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));
  if (jsonlFiles.length === 0) return null;

  // Sort by mtime descending
  const withStats = await Promise.all(
    jsonlFiles.map(async (f) => {
      const fullPath = join(projectDir, f);
      try {
        const s = await stat(fullPath);
        return { path: fullPath, mtime: s.mtimeMs };
      } catch {
        return { path: fullPath, mtime: 0 };
      }
    }),
  );
  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats[0]?.path ?? null;
}

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
// Process Detection
// =============================================================================

/**
 * TTL cache for `ps -eo pid,tty,args` output. Without this, listing N sessions
 * would spawn N concurrent `ps` processes, each taking 30+ seconds on machines
 * with many processes. The cache ensures `ps` is called at most once per TTL
 * window regardless of how many sessions are being enriched.
 */
let psCache: { output: string; timestamp: number; promise?: Promise<string> } | null = null;
const PS_CACHE_TTL_MS = 5_000;

/** Reset the ps cache. Exported for testing only. */
export function resetPsCache(): void {
  psCache = null;
}

async function getCachedProcessList(): Promise<string> {
  const now = Date.now();
  if (psCache && now - psCache.timestamp < PS_CACHE_TTL_MS) {
    // Cache hit — return resolved output or wait for in-flight request
    if (psCache.promise) return psCache.promise;
    return psCache.output;
  }

  // Cache miss or expired — start a single `ps` call and share the promise.
  // Guard both callbacks so they only update psCache if it still belongs to
  // this request — a newer request may have replaced it while we were waiting.
  const promise = execFileAsync("ps", ["-eo", "pid,tty,args"], {
    timeout: 5_000,
  }).then(({ stdout }) => {
    if (psCache?.promise === promise) {
      psCache = { output: stdout, timestamp: Date.now() };
    }
    return stdout;
  });

  // Store the in-flight promise so concurrent callers share it
  psCache = { output: "", timestamp: now, promise };

  try {
    return await promise;
  } catch {
    // On failure, clear cache so the next caller retries — but only if
    // psCache still points to this request (avoid clobbering a newer entry)
    if (psCache?.promise === promise) {
      psCache = null;
    }
    return "";
  }
}

/**
 * Check if a process named "claude" is running in the given runtime handle's context.
 * Uses ps to find processes by TTY (for tmux) or by PID.
 */
async function findClaudeProcess(handle: RuntimeHandle): Promise<number | null> {
  try {
    // For tmux runtime, get the pane TTY and find claude on it
    if (handle.runtimeName === "tmux" && handle.id) {
      const { stdout: ttyOut } = await execFileAsync(
        "tmux",
        ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
        { timeout: 5_000 },
      );
      // Iterate all pane TTYs (multi-pane sessions) — succeed on any match
      const ttys = ttyOut
        .trim()
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);
      if (ttys.length === 0) return null;

      const psOut = await getCachedProcessList();
      if (!psOut) return null;

      const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
      // Match "claude" as a word boundary — prevents false positives on
      // names like "claude-code" or paths that merely contain the substring.
      const processRe = /(?:^|\/)claude(?:\s|$)/;
      for (const line of psOut.split("\n")) {
        const cols = line.trimStart().split(/\s+/);
        if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
        const args = cols.slice(2).join(" ");
        if (processRe.test(args)) {
          return parseInt(cols[0] ?? "0", 10);
        }
      }
      return null;
    }

    // For process runtime, check if the PID stored in handle data is alive
    const rawPid = handle.data["pid"];
    const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // Signal 0 = check existence
        return pid;
      } catch (err: unknown) {
        // EPERM means the process exists but we lack permission to signal it
        if (err instanceof Error && "code" in err && err.code === "EPERM") {
          return pid;
        }
        return null;
      }
    }

    // No reliable way to identify the correct process for this session
    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// Terminal Output Patterns for detectActivity
// =============================================================================

/** Classify Claude Code's activity state from terminal output (pure, sync). */
function classifyTerminalOutput(terminalOutput: string): ActivityState {
  // Empty output — can't determine state
  if (!terminalOutput.trim()) return "idle";

  const lines = terminalOutput.trim().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";

  // Check the last line FIRST — if the prompt is visible, the agent is idle
  // regardless of historical output (e.g. "Reading file..." from earlier).
  // The ❯ is Claude Code's prompt character.
  if (/^[❯>$#]\s*$/.test(lastLine)) return "idle";

  // Check the bottom of the buffer for permission prompts BEFORE checking
  // full-buffer active indicators. Historical "Thinking"/"Reading" text in
  // the buffer must not override a current permission prompt at the bottom.
  const tail = lines.slice(-5).join("\n");
  if (/Do you want to proceed\?/i.test(tail)) return "waiting_input";
  if (/\(Y\)es.*\(N\)o/i.test(tail)) return "waiting_input";
  if (/bypass.*permissions/i.test(tail)) return "waiting_input";

  // Everything else is "active" — the agent is processing, waiting for
  // output, or showing content. Specific patterns (e.g. "esc to interrupt",
  // "Thinking", "Reading") all map to "active" so no need to check them
  // individually.
  return "active";
}

// =============================================================================
// Hook Setup Helper
// =============================================================================

/**
 * Shared helper to setup PostToolUse hooks in a workspace.
 * Writes metadata-updater.sh script and updates settings.json.
 *
 * @param workspacePath - Path to the workspace directory
 * @param hookCommand - Command string for the hook (can use variables like $CLAUDE_PROJECT_DIR)
 */
async function setupHookInWorkspace(workspacePath: string, hookCommand: string): Promise<void> {
  const claudeDir = join(workspacePath, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const hookScriptPath = join(claudeDir, "metadata-updater.sh");

  // Create .claude directory if it doesn't exist
  try {
    await mkdir(claudeDir, { recursive: true });
  } catch {
    // Directory might already exist
  }

  // Write the metadata updater script
  await writeFile(hookScriptPath, METADATA_UPDATER_SCRIPT, "utf-8");
  await chmod(hookScriptPath, 0o755); // Make executable

  // Read existing settings if present
  let existingSettings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const content = await readFile(settingsPath, "utf-8");
      existingSettings = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Invalid JSON or read error — start fresh
    }
  }

  // Merge hooks configuration
  const hooks = (existingSettings["hooks"] as Record<string, unknown>) ?? {};
  const postToolUse = (hooks["PostToolUse"] as Array<unknown>) ?? [];

  // Check if our hook is already configured
  let hookIndex = -1;
  let hookDefIndex = -1;
  for (let i = 0; i < postToolUse.length; i++) {
    const hook = postToolUse[i];
    if (typeof hook !== "object" || hook === null || Array.isArray(hook)) continue;
    const h = hook as Record<string, unknown>;
    const hooksList = h["hooks"];
    if (!Array.isArray(hooksList)) continue;
    for (let j = 0; j < hooksList.length; j++) {
      const hDef = hooksList[j];
      if (typeof hDef !== "object" || hDef === null || Array.isArray(hDef)) continue;
      const def = hDef as Record<string, unknown>;
      if (typeof def["command"] === "string" && def["command"].includes("metadata-updater.sh")) {
        hookIndex = i;
        hookDefIndex = j;
        break;
      }
    }
    if (hookIndex >= 0) break;
  }

  // Add or update our hook
  if (hookIndex === -1) {
    // No metadata hook exists, add it
    postToolUse.push({
      matcher: "Bash",
      hooks: [
        {
          type: "command",
          command: hookCommand,
          timeout: 5000,
        },
      ],
    });
  } else {
    // Hook exists, update the command
    const hook = postToolUse[hookIndex] as Record<string, unknown>;
    const hooksList = hook["hooks"] as Array<Record<string, unknown>>;
    hooksList[hookDefIndex]["command"] = hookCommand;
  }

  hooks["PostToolUse"] = postToolUse;
  existingSettings["hooks"] = hooks;

  // Write updated settings
  await writeFile(settingsPath, JSON.stringify(existingSettings, null, 2) + "\n", "utf-8");
}

// =============================================================================
// Agent Implementation
// =============================================================================

function createClaudeCodeAgent(): Agent {
  return {
    name: "claude-code",
    processName: "claude",
    promptDelivery: "post-launch",

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
        // Use shell command substitution to read from file at launch time.
        // This avoids tmux truncation when inlining 2000+ char prompts.
        // The double quotes allow $() expansion; inner path is single-quoted for safety.
        parts.push("--append-system-prompt", `"$(cat ${shellEscape(config.systemPromptFile)})"`);
      } else if (config.systemPrompt) {
        parts.push("--append-system-prompt", shellEscape(config.systemPrompt));
      }

      // NOTE: prompt is NOT included here — it's delivered post-launch via
      // runtime.sendMessage() to keep Claude in interactive mode.
      // Using -p causes one-shot mode (Claude exits after responding).

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

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyTerminalOutput(terminalOutput);
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      const pid = await findClaudeProcess(handle);
      return pid !== null;
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

      // Check if process is running first
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      // Process is running - check JSONL session file for activity
      if (!session.workspacePath) {
        // No workspace path — cannot determine activity without it
        return null;
      }

      const projectPath = toClaudeProjectPath(session.workspacePath);
      const projectDir = join(homedir(), ".claude", "projects", projectPath);

      const sessionFile = await findLatestSessionFile(projectDir);
      if (!sessionFile) {
        // No session file yet — process is running but no conversation started.
        // Treat as idle (waiting for first task).
        return { state: "idle", timestamp: session.createdAt };
      }

      const entry = await readLastJsonlEntry(sessionFile);
      if (!entry) {
        // Empty file or read error — cannot determine activity
        return null;
      }

      const ageMs = Date.now() - entry.modifiedAt.getTime();
      const timestamp = entry.modifiedAt;

      const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);
      switch (entry.lastType) {
        case "user":
        case "tool_use":
        case "progress":
          if (ageMs <= activeWindowMs) return { state: "active", timestamp };
          return { state: ageMs > threshold ? "idle" : "ready", timestamp };

        case "assistant":
        case "system":
        case "summary":
        case "result":
          return { state: ageMs > threshold ? "idle" : "ready", timestamp };

        case "permission_request":
          return { state: "waiting_input", timestamp };

        case "error":
          return { state: "blocked", timestamp };

        default:
          if (ageMs <= activeWindowMs) return { state: "active", timestamp };
          return { state: ageMs > threshold ? "idle" : "ready", timestamp };
      }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      // Build the Claude project directory path
      const projectPath = toClaudeProjectPath(session.workspacePath);
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
        const projectPath = toClaudeProjectPath(session.workspacePath);
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

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      // Relative path so that symlinked .claude/ dirs across worktrees
      // all produce the same settings.json (last writer doesn't clobber).
      await setupHookInWorkspace(workspacePath, ".claude/metadata-updater.sh");
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;

      await setupHookInWorkspace(session.workspacePath, ".claude/metadata-updater.sh");
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
    // Use --version instead of `which` for cross-platform compatibility (Windows has no `which`)
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
