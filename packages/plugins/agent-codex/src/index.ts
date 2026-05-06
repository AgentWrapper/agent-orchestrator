import {
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  shellEscape,
  readLastJsonlEntry,
  normalizeAgentPermissionMode,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  recordTerminalActivity,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityState,
  type ActivityDetection,
  type CostEstimate,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@aoagents/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat, lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "codex",
  slot: "agent" as const,
  description: "Agent plugin: OpenAI Codex CLI",
  version: "0.1.1",
  displayName: "OpenAI Codex",
};

// =============================================================================
// Workspace Setup (delegates to shared PATH-wrapper hooks from @aoagents/ao-core)
// =============================================================================

// =============================================================================
// Codex Session JSONL Parsing (for getSessionInfo)
// =============================================================================

/** Codex session directory: ~/.codex/sessions/ */
const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const SESSION_MATCH_SCAN_CHUNK_BYTES = 8192;
const SESSION_MATCH_SCAN_LINE_LIMIT = 10;

interface CodexTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cached_tokens?: number;
  reasoning_output_tokens?: number;
  reasoning_tokens?: number;
}

interface CodexJsonlPayload extends CodexTokenUsage {
  id?: string;
  cwd?: string;
  model_provider?: string;
  model?: string;
  turn_id?: string;
  threadId?: string;
  content?: string;
  role?: string;
  type?: string;
  info?: {
    total_token_usage?: CodexTokenUsage;
    last_token_usage?: CodexTokenUsage;
  };
}

/**
 * Recent Codex versions wrap event fields in `payload`, while older fixtures
 * used a flat shape. Accept both so session discovery works against real
 * Codex JSONL and existing tests remain valid.
 */
interface CodexJsonlLine extends CodexJsonlPayload {
  type?: string;
  payload?: CodexJsonlPayload;
  msg?: CodexTokenUsage & { type?: string };
}

function getCodexPayload(entry: CodexJsonlLine): CodexJsonlPayload {
  return entry.payload ?? entry;
}

/**
 * Collect all JSONL files under a directory, recursively.
 * Codex stores sessions in date-sharded directories:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Uses lstat (not stat) so symlinks to directories are never followed,
 * preventing infinite loops from symlink cycles. Max depth is capped at 4
 * (YYYY/MM/DD + 1 buffer) as an additional safety guard.
 */
const MAX_SESSION_SCAN_DEPTH = 4;

async function collectJsonlFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SESSION_SCAN_DEPTH) return [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry.endsWith(".jsonl")) {
      results.push(fullPath);
    } else {
      // Recurse into subdirectories (YYYY/MM/DD structure).
      // Use lstat to avoid following symlinks that could create cycles.
      try {
        const s = await lstat(fullPath);
        if (s.isDirectory()) {
          const nested = await collectJsonlFiles(fullPath, depth + 1);
          results.push(...nested);
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  }
  return results;
}

async function readJsonlPrefixLines(filePath: string, maxLines: number): Promise<string[]> {
  const handle = await open(filePath, "r");
  const lines: string[] = [];
  let partialLine = "";
  // Reuse a single decoder across reads so multi-byte UTF-8 sequences that
  // straddle a chunk boundary (e.g. CJK characters in base_instructions) get
  // buffered correctly instead of producing U+FFFD replacement characters.
  const decoder = new StringDecoder("utf8");

  try {
    while (lines.length < maxLines) {
      const buffer = Buffer.allocUnsafe(SESSION_MATCH_SCAN_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);

      if (bytesRead === 0) {
        partialLine += decoder.end();
        const finalLine = partialLine.trim();
        if (finalLine) lines.push(finalLine);
        break;
      }

      partialLine += decoder.write(buffer.subarray(0, bytesRead));

      let newlineIndex = partialLine.indexOf("\n");
      while (newlineIndex !== -1 && lines.length < maxLines) {
        const line = partialLine.slice(0, newlineIndex).trim();
        if (line) lines.push(line);
        partialLine = partialLine.slice(newlineIndex + 1);
        newlineIndex = partialLine.indexOf("\n");
      }
    }
  } finally {
    await handle.close();
  }

  return lines;
}

/**
 * Check if the first few complete JSONL records of a session file contain a
 * session_meta entry matching the given workspace path. This avoids parsing a
 * truncated session_meta line when Codex embeds large base_instructions.
 */
async function sessionFileMatchesCwd(filePath: string, workspacePath: string): Promise<boolean> {
  try {
    const lines = await readJsonlPrefixLines(filePath, SESSION_MATCH_SCAN_LINE_LIMIT);
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const entry = parsed as CodexJsonlLine;
          const payload = getCodexPayload(entry);
          if (entry.type === "session_meta" && payload.cwd === workspacePath) {
            return true;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Unreadable file
  }
  return false;
}

/**
 * Find Codex session files whose `session_meta` cwd matches the given workspace path.
 * Recursively scans ~/.codex/sessions/ (date-sharded: YYYY/MM/DD/rollout-*.jsonl).
 * Returns the path to the most recently modified matching file, or null.
 */
async function findCodexSessionFile(workspacePath: string): Promise<string | null> {
  const jsonlFiles = await collectJsonlFiles(CODEX_SESSIONS_DIR);
  if (jsonlFiles.length === 0) return null;

  let bestMatch: { path: string; mtime: number } | null = null;

  for (const filePath of jsonlFiles) {
    const matches = await sessionFileMatchesCwd(filePath, workspacePath);
    if (matches) {
      try {
        const s = await stat(filePath);
        if (!bestMatch || s.mtimeMs > bestMatch.mtime) {
          bestMatch = { path: filePath, mtime: s.mtimeMs };
        }
      } catch {
        // Skip if stat fails
      }
    }
  }

  return bestMatch?.path ?? null;
}

/** Aggregated data extracted from a Codex session file via streaming */
interface CodexSessionData {
  model: string | null;
  threadId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

/**
 * Stream a Codex JSONL session file line-by-line and aggregate the data
 * we need (model, threadId, token counts) without loading the entire file
 * into memory. This is critical because Codex rollout files can be 100 MB+.
 */
async function streamCodexSessionData(filePath: string): Promise<CodexSessionData | null> {
  try {
    const data: CodexSessionData = {
      model: null,
      threadId: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
    };
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
        const entry = parsed as CodexJsonlLine;

        const payload = getCodexPayload(entry);

        if (entry.type === "session_meta") {
          if (typeof payload.id === "string" && payload.id) {
            data.threadId = payload.id;
          } else if (typeof payload.threadId === "string" && payload.threadId) {
            data.threadId = payload.threadId;
          }
        }

        if (!data.threadId) {
          if (typeof payload.threadId === "string" && payload.threadId) {
            data.threadId = payload.threadId;
          } else if (typeof entry.threadId === "string" && entry.threadId) {
            data.threadId = entry.threadId;
          }
        }

        if (entry.type === "turn_context" && typeof payload.model === "string" && payload.model) {
          data.model = payload.model;
        } else if (!data.model && typeof payload.model === "string" && payload.model) {
          data.model = payload.model;
        }

        // Token sources are precedence-ordered: total → last → flat → legacy.
        // `continue` ensures only one source is counted per entry.
        // `total_token_usage` is a cumulative snapshot (last-write-wins, so `=`);
        // the rest are per-turn deltas (accumulate with `+=`). Do not "fix" this.
        const totalUsage = payload.info?.total_token_usage;
        if (typeof totalUsage?.input_tokens === "number") {
          data.inputTokens = totalUsage.input_tokens;
          data.outputTokens = totalUsage.output_tokens ?? 0;
          continue;
        }

        const lastUsage = payload.info?.last_token_usage;
        if (typeof lastUsage?.input_tokens === "number") {
          data.inputTokens += lastUsage.input_tokens;
          data.outputTokens += lastUsage.output_tokens ?? 0;
          continue;
        }

        if (typeof payload.input_tokens === "number") {
          data.inputTokens += payload.input_tokens;
          data.outputTokens += payload.output_tokens ?? 0;
          continue;
        }

        if (entry.type === "event_msg" && entry.msg?.type === "token_count") {
          data.inputTokens += entry.msg.input_tokens ?? 0;
          data.outputTokens += entry.msg.output_tokens ?? 0;
          data.cachedTokens += entry.msg.cached_tokens ?? 0;
          data.reasoningTokens += entry.msg.reasoning_tokens ?? 0;
        }
      } catch {
        // Skip malformed lines
      }
    }

    return data;
  } catch {
    return null;
  }
}

// =============================================================================
// Binary Resolution
// =============================================================================

/**
 * Resolve the Codex CLI binary path.
 * Checks (in order): which, common fallback locations.
 * Returns "codex" as final fallback (let the shell resolve it at runtime).
 */
export async function resolveCodexBinary(): Promise<string> {
  // 1. Try `which codex`
  try {
    const { stdout } = await execFileAsync("which", ["codex"], { timeout: 10_000 });
    const resolved = stdout.trim();
    if (resolved) return resolved;
  } catch {
    // Not found via which
  }

  // 2. Check common locations (npm global, Homebrew, Cargo — Codex is now Rust-based)
  const home = homedir();
  const candidates = [
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
    join(home, ".cargo", "bin", "codex"),
    join(home, ".npm", "bin", "codex"),
  ];

  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Not found at this location
    }
  }

  // 3. Fallback: let the shell resolve it
  return "codex";
}

// =============================================================================
// Agent Implementation
// =============================================================================

/** Append approval-policy flags to a command parts array */
function appendApprovalFlags(
  parts: string[],
  permissions: string | undefined,
  allowDangerousBypass = true,
): void {
  const mode = normalizeAgentPermissionMode(permissions);
  if (mode === "permissionless") {
    if (allowDangerousBypass) {
      parts.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      parts.push("--ask-for-approval", "never");
    }
  } else if (mode === "auto-edit") {
    parts.push("--ask-for-approval", "never");
  } else if (mode === "suggest") {
    parts.push("--ask-for-approval", "untrusted");
  }
}

/** Append model and reasoning flags to a command parts array */
function appendModelFlags(parts: string[], model: string | undefined): void {
  if (!model) return;
  parts.push("--model", shellEscape(model));

  // Auto-detect o-series models and enable reasoning via config override.
  // Codex does not have a --reasoning flag; reasoning is controlled via
  // the model_reasoning_effort config key.
  if (/^o[34]/i.test(model)) {
    parts.push("-c", "model_reasoning_effort=high");
  }
}

/** Disable Codex startup update checks/prompts in non-interactive sessions */
function appendNoUpdateCheckFlag(parts: string[]): void {
  parts.push("-c", "check_for_update_on_startup=false");
}

/** TTL for session file path cache (ms). Prevents redundant filesystem scans
 *  when getActivityState and getSessionInfo are called in the same refresh cycle. */
const SESSION_FILE_CACHE_TTL_MS = 30_000;

/** Module-level session file cache shared across the agent instance lifetime.
 *  Keyed by workspace path, stores the resolved file path and an expiry timestamp. */
const sessionFileCache = new Map<string, { path: string | null; expiry: number }>();

/** Find session file with caching to avoid double scans per refresh cycle */
async function findCodexSessionFileCached(workspacePath: string): Promise<string | null> {
  const cached = sessionFileCache.get(workspacePath);
  if (cached && Date.now() < cached.expiry) {
    return cached.path;
  }
  const result = await findCodexSessionFile(workspacePath);
  sessionFileCache.set(workspacePath, {
    path: result,
    expiry: Date.now() + SESSION_FILE_CACHE_TTL_MS,
  });
  return result;
}

function createCodexAgent(): Agent {
  /** Cached resolved binary path (populated by init or first getLaunchCommand) */
  let resolvedBinary: string | null = null;
  /** Guard against concurrent resolveCodexBinary() calls */
  let resolvingBinary: Promise<string> | null = null;

  return {
    name: "codex",
    processName: "codex",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const binary = resolvedBinary ?? "codex";
      const parts: string[] = [shellEscape(binary)];
      appendNoUpdateCheckFlag(parts);

      appendApprovalFlags(parts, config.permissions);
      appendModelFlags(parts, config.model);

      if (config.systemPromptFile) {
        // Codex reads developer instructions from a file via config override
        parts.push("-c", `model_instructions_file=${shellEscape(config.systemPromptFile)}`);
      } else if (config.systemPrompt) {
        // Codex accepts inline developer instructions via config override
        parts.push("-c", `developer_instructions=${shellEscape(config.systemPrompt)}`);
      }

      if (config.prompt) {
        // Use `--` to end option parsing so prompts starting with `-` aren't
        // misinterpreted as flags.
        parts.push("--", shellEscape(config.prompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      // NOTE: AO_PROJECT_ID is the caller's responsibility (spawn.ts sets it)
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      // PATH and GH_PATH are injected by session-manager for all agents.
      // Disable Codex's version check/update prompt for non-interactive AO sessions.
      env["CODEX_DISABLE_UPDATE_CHECK"] = "1";

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput.trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";

      // If Codex is showing its input prompt, it's idle
      if (/^[>$#]\s*$/.test(lastLine)) return "idle";

      // Check last few lines for approval prompts
      const tail = lines.slice(-5).join("\n");
      if (/approval required/i.test(tail)) return "waiting_input";
      if (/\(y\)es.*\(n\)o/i.test(tail)) return "waiting_input";

      // Default to active — specific patterns (esc to interrupt, spinner
      // symbols) all map to "active" so no need to check them individually.
      return "active";
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

      if (!session.workspacePath) return null;

      // 1. Try Codex's native JSONL first — it has richer 6-state detection
      //    (approval_request, error, tool_call, etc.) that terminal parsing can't match.
      const sessionFile = await findCodexSessionFileCached(session.workspacePath);
      if (sessionFile) {
        const entry = await readLastJsonlEntry(sessionFile);
        if (entry) {
          const ageMs = Date.now() - entry.modifiedAt.getTime();
          const timestamp = entry.modifiedAt;

          // Real Codex wraps the semantic type in `payload.type` on event_msg
          // records (e.g. `{"type":"event_msg","payload":{"type":"error",...}}`).
          // Prefer payloadType when present so approval_request/error surface
          // correctly instead of decaying to ready/idle via the event_msg case.
          const effectiveType = entry.payloadType ?? entry.lastType;

          // Map Codex JSONL entry types to activity states.
          // Confirmed types: session_meta, event_msg. Others are best-effort.
          const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);
          switch (effectiveType) {
            case "approval_request":
            case "exec_approval_request":
            case "apply_patch_approval_request":
              return { state: "waiting_input", timestamp };

            case "error":
            case "stream_error":
              return { state: "blocked", timestamp };

            case "task_started":
            case "agent_reasoning":
            case "response_item":
            case "turn_context":
            case "user_input":
            case "tool_call":
            case "exec_command":
            case "exec_command_begin":
            case "exec_command_end":
              if (ageMs <= activeWindowMs) return { state: "active", timestamp };
              return { state: ageMs > threshold ? "idle" : "ready", timestamp };

            case "task_complete":
            case "turn_aborted":
            case "agent_message":
            case "assistant_message":
            case "session_meta":
            case "event_msg":
            case "compacted":
            case "token_count":
              return { state: ageMs > threshold ? "idle" : "ready", timestamp };

            default:
              if (ageMs <= activeWindowMs) return { state: "active", timestamp };
              return { state: ageMs > threshold ? "idle" : "ready", timestamp };
          }
        }

        // Session file exists but no parseable entry — fall through to AO JSONL
        // checks below instead of returning early, so waiting_input/blocked
        // from terminal parsing can still be detected.
      }

      // 2. Fallback: check AO activity JSONL (terminal-derived) for waiting_input/blocked
      //    that the native JSONL may not have captured.
      const activityResult = await readLastActivityEntry(session.workspacePath);
      const activityState = checkActivityLogState(activityResult);
      if (activityState) return activityState;

      // 3. Fallback: use JSONL entry with age-based decay when native session file
      //    is missing or unparseable.
      const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);
      const fallback = getActivityFallbackState(activityResult, activeWindowMs, threshold);
      if (fallback) return fallback;

      // 4. Last resort: native session file exists but nothing else — use its mtime
      if (sessionFile) {
        try {
          const s = await stat(sessionFile);
          const ageMs = Date.now() - s.mtimeMs;
          const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);
          if (ageMs <= activeWindowMs) return { state: "active", timestamp: s.mtime };
          if (ageMs <= threshold) return { state: "ready", timestamp: s.mtime };
          return { state: "idle", timestamp: s.mtime };
        } catch {
          // stat failed — no signal available
        }
      }

      return null;
    },

    async recordActivity(session: Session, terminalOutput: string): Promise<void> {
      if (!session.workspacePath) return;
      await recordTerminalActivity(session.workspacePath, terminalOutput, (output) =>
        this.detectActivity(output),
      );
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          const { stdout: ttyOut } = await execFileAsync(
            "tmux",
            ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
            { timeout: 30_000 },
          );
          const ttys = ttyOut
            .trim()
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
            timeout: 30_000,
          });
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)codex(?:\s|$)/;
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (processRe.test(args)) {
              return true;
            }
          }
          return false;
        }

        const rawPid = handle.data["pid"];
        const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            return true;
          } catch (err: unknown) {
            if (err instanceof Error && "code" in err && err.code === "EPERM") {
              return true;
            }
            return false;
          }
        }

        return false;
      } catch {
        return false;
      }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      const sessionFile = await findCodexSessionFileCached(session.workspacePath);
      if (!sessionFile) return null;

      // Stream the file line-by-line to avoid loading potentially huge
      // rollout files (100 MB+) entirely into memory.
      const data = await streamCodexSessionData(sessionFile);
      if (!data) return null;

      const agentSessionId = basename(sessionFile, ".jsonl");

      let cost: CostEstimate | undefined;
      const totalInputTokens = data.inputTokens + data.cachedTokens;
      if (totalInputTokens > 0 || data.outputTokens > 0 || data.reasoningTokens > 0) {
        const estimatedCostUsd =
          (data.inputTokens / 1_000_000) * 2.5 +
          (data.cachedTokens / 1_000_000) * 0.625 +
          ((data.outputTokens + data.reasoningTokens) / 1_000_000) * 10.0;
        cost = {
          inputTokens: totalInputTokens,
          outputTokens: data.outputTokens,
          estimatedCostUsd,
        };
      }

      return {
        summary: data.model ? `Codex session (${data.model})` : null,
        summaryIsFallback: true,
        agentSessionId,
        metadata: data.threadId
          ? {
              codexThreadId: data.threadId,
              ...(data.model ? { codexModel: data.model } : {}),
            }
          : undefined,
        cost,
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      let threadId = session.metadata?.["codexThreadId"]?.trim();
      let model: string | null = session.metadata?.["codexModel"]?.trim() || null;
      if (!threadId) {
        if (!session.workspacePath) return null;

        // Find the Codex session file for this workspace
        const sessionFile = await findCodexSessionFileCached(session.workspacePath);
        if (!sessionFile) return null;

        // Stream the file line-by-line to avoid loading potentially huge
        // rollout files (100 MB+) entirely into memory.
        const data = await streamCodexSessionData(sessionFile);
        if (!data?.threadId) return null;
        threadId = data.threadId;
        model = data.model;
      }

      // Use Codex's native `resume` subcommand for proper conversation resume.
      // This restores the full thread state, not just a text prompt re-injection.
      // Flags are placed before the positional threadId for CLI parser compatibility.
      const binary = resolvedBinary ?? "codex";
      const parts: string[] = [shellEscape(binary), "resume"];
      appendNoUpdateCheckFlag(parts);

      appendApprovalFlags(parts, project.agentConfig?.permissions);
      const effectiveModel = (project.agentConfig?.model ?? model) as string | undefined;
      appendModelFlags(parts, effectiveModel ?? undefined);

      // Positional threadId goes last, after all flags
      parts.push(shellEscape(threadId));

      return parts.join(" ");
    },

    async setupWorkspaceHooks(_workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      // PATH wrappers are installed by session-manager for all agents.
    },

    async postLaunchSetup(_session: Session): Promise<void> {
      // Resolve binary path on first launch (cached for subsequent calls).
      // Uses a promise guard to prevent concurrent calls from racing.
      if (!resolvedBinary) {
        if (!resolvingBinary) {
          resolvingBinary = resolveCodexBinary();
        }
        try {
          resolvedBinary = await resolvingBinary;
        } finally {
          resolvingBinary = null;
        }
      }
      // PATH wrappers are re-ensured by session-manager.
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createCodexAgent();
}

/** @internal Clear the session file cache. Exported for testing only. */
export function _resetSessionFileCache(): void {
  sessionFileCache.clear();
}

export { CodexAppServerClient } from "./app-server-client.js";
export type {
  AppServerClientOptions,
  ThreadStartParams,
  TurnStartParams,
  NotificationHandler,
  ApprovalHandler,
  ApprovalDecision,
} from "./app-server-client.js";

export function detect(): boolean {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
