import {
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  shellEscape,
  readLastJsonlEntry,
  normalizeAgentPermissionMode,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@composio/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { readdir, readFile, stat, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "cursor",
  slot: "agent" as const,
  description: "Agent plugin: Cursor AI CLI",
  version: "0.1.0",
  displayName: "Cursor",
};

// =============================================================================
// Session Path Helpers
// =============================================================================

/**
 * Convert a workspace path to Cursor's project directory path.
 * Cursor stores sessions at ~/.cursor/projects/{encoded-path}/
 *
 * Encoding pattern (similar to Claude Code):
 * - Leading slash is removed or replaced
 * - Path separators and dots are replaced with dashes
 *
 * TODO: Verify exact encoding scheme used by Cursor CLI
 */
export function toCursorProjectPath(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  // Strip leading slash from Unix paths (drive letter paths keep the letter)
  const stripped = normalized.replace(/^\//, "");
  return stripped.replace(/:/g, "").replace(/[/.]/g, "-");
}

/**
 * Find the most recently modified session file in Cursor's project directory.
 * Cursor may store sessions as JSONL or JSON files.
 */
async function findLatestSessionFile(projectDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }

  // Look for session files - Cursor may use .jsonl, .json, or other formats
  const sessionFiles = entries.filter(
    (f) => (f.endsWith(".jsonl") || f.endsWith(".json")) && !f.startsWith("agent-"),
  );
  if (sessionFiles.length === 0) return null;

  const withStats = await Promise.all(
    sessionFiles.map(async (f) => {
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
  costUSD?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

/**
 * Parse only the last `maxBytes` of a JSONL file for efficiency.
 */
async function parseJsonlFileTail(
  filePath: string,
  maxBytes = 131_072,
): Promise<JsonlLine[]> {
  let content: string;
  let offset: number;
  try {
    const { size = 0 } = await stat(filePath);
    offset = Math.max(0, size - maxBytes);
    if (offset === 0) {
      content = await readFile(filePath, "utf-8");
    } else {
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

/** Extract auto-generated summary from JSONL */
function extractSummary(
  lines: JsonlLine[],
): { summary: string; isFallback: boolean } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line?.type === "summary" && line.summary) {
      return { summary: line.summary, isFallback: false };
    }
  }
  // Fallback: first user message truncated to 120 chars
  for (const line of lines) {
    if (line?.type === "user" && line.message?.content && typeof line.message.content === "string") {
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
function extractCost(lines: JsonlLine[]): { inputTokens: number; outputTokens: number; estimatedCostUsd: number } | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCost = 0;

  for (const line of lines) {
    if (typeof line.costUSD === "number") {
      totalCost += line.costUSD;
    }
    if (line.usage) {
      inputTokens += line.usage.input_tokens ?? 0;
      outputTokens += line.usage.output_tokens ?? 0;
    }
  }

  if (inputTokens === 0 && outputTokens === 0 && totalCost === 0) {
    return undefined;
  }

  return { inputTokens, outputTokens, estimatedCostUsd: totalCost };
}

// =============================================================================
// Process Detection
// =============================================================================

let psCache: { output: string; timestamp: number; promise?: Promise<string> } | null = null;
const PS_CACHE_TTL_MS = 5_000;

export function resetPsCache(): void {
  psCache = null;
}

async function getCachedProcessList(): Promise<string> {
  const now = Date.now();
  if (psCache && now - psCache.timestamp < PS_CACHE_TTL_MS) {
    if (psCache.promise) return psCache.promise;
    return psCache.output;
  }

  const promise = execFileAsync("ps", ["-eo", "pid,tty,args"], { timeout: 5_000 })
    .then(({ stdout }) => {
      if (psCache?.promise === promise) {
        psCache = { output: stdout, timestamp: Date.now() };
      }
      return stdout;
    });

  psCache = { output: "", timestamp: now, promise };

  try {
    return await promise;
  } catch {
    if (psCache?.promise === promise) {
      psCache = null;
    }
    return "";
  }
}

/**
 * Find Cursor process by TTY (for tmux) or by PID stored in handle.
 */
async function findCursorProcess(handle: RuntimeHandle): Promise<number | null> {
  try {
    if (handle.runtimeName === "tmux" && handle.id) {
      const { stdout: ttyOut } = await execFileAsync("tmux", [
        "list-panes",
        "-t",
        handle.id,
        "-F",
        "#{pane_tty}",
      ], { timeout: 5_000 });

      const ttys = ttyOut.trim().split("\n").map((t) => t.trim()).filter(Boolean);
      if (ttys.length === 0) return null;

      const psOut = await getCachedProcessList();
      if (!psOut) return null;

      const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
      // Match "cursor" as a word boundary
      const processRe = /(?:^|\/)cursor(?:\s|$)/;

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

    const rawPid = handle.data["pid"];
    const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return pid;
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "EPERM") {
          return pid;
        }
        return null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// Terminal Output Classification
// =============================================================================

/**
 * Classify Cursor's activity state from terminal output.
 */
function classifyTerminalOutput(terminalOutput: string): ActivityState {
  if (!terminalOutput.trim()) return "idle";

  const lines = terminalOutput.trim().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";

  // Check for Cursor's prompt character
  if (/^[❯>$#]\s*$/.test(lastLine)) return "idle";

  // Check for permission/confirmation prompts
  const tail = lines.slice(-5).join("\n");
  if (/Do you want to proceed\?/i.test(tail)) return "waiting_input";
  if (/\(Y\)es.*\(N\)o/i.test(tail)) return "waiting_input";
  if (/Allow .+\?/i.test(tail)) return "waiting_input";
  if (/approval required/i.test(tail)) return "waiting_input";

  return "active";
}

// =============================================================================
// Agent Implementation
// =============================================================================

function createCursorAgent(): Agent {
  return {
    name: "cursor",
    processName: "cursor",
    promptDelivery: "post-launch",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["cursor"];

      // Cursor agent mode
      parts.push("--agent");

      // Model selection if specified
      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      // System prompt from file (to avoid truncation)
      if (config.systemPromptFile) {
        parts.push("--system-prompt", `"$(cat ${shellEscape(config.systemPromptFile)})"`);
      } else if (config.systemPrompt) {
        parts.push("--system-prompt", shellEscape(config.systemPrompt));
      }

      // Permission mode
      const permissionMode = normalizeAgentPermissionMode(config.permissions);
      if (permissionMode === "permissionless" || permissionMode === "auto-edit") {
        parts.push("--dangerously-skip-permissions");
      }

      // NOTE: prompt is delivered post-launch via runtime.sendMessage()
      // to keep Cursor in interactive mode

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};

      // Set session info for introspection
      env["AO_SESSION_ID"] = config.sessionId;

      // Prevent nested agent conflicts
      env["CURSOR_SESSION"] = "";

      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyTerminalOutput(terminalOutput);
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      const pid = await findCursorProcess(handle);
      return pid !== null;
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };

      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      if (!session.workspacePath) {
        return null;
      }

      // Look for Cursor session files
      const projectPath = toCursorProjectPath(session.workspacePath);
      const projectDir = join(homedir(), ".cursor", "projects", projectPath);

      const sessionFile = await findLatestSessionFile(projectDir);
      if (!sessionFile) {
        return { state: "idle", timestamp: session.createdAt };
      }

      const entry = await readLastJsonlEntry(sessionFile);
      if (!entry) {
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

      const projectPath = toCursorProjectPath(session.workspacePath);
      const projectDir = join(homedir(), ".cursor", "projects", projectPath);

      const sessionFile = await findLatestSessionFile(projectDir);
      if (!sessionFile) return null;

      const lines = await parseJsonlFileTail(sessionFile);
      if (lines.length === 0) return null;

      const agentSessionId = basename(sessionFile, ".jsonl");
      const summaryResult = extractSummary(lines);

      return {
        summary: summaryResult?.summary ?? null,
        summaryIsFallback: summaryResult?.isFallback,
        agentSessionId,
        cost: extractCost(lines),
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      if (!session.workspacePath) return null;

      // Find Cursor session file for this workspace
      const projectPath = toCursorProjectPath(session.workspacePath);
      const projectDir = join(homedir(), ".cursor", "projects", projectPath);

      const sessionFile = await findLatestSessionFile(projectDir);
      if (!sessionFile) return null;

      // Extract session ID from filename
      const sessionUuid = basename(sessionFile, ".jsonl");
      if (!sessionUuid) return null;

      const parts: string[] = ["cursor", "--resume", shellEscape(sessionUuid)];

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
      // TODO: Implement Cursor workspace hooks if needed
      // Cursor may have a similar .cursor/settings.json for hook configuration
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;
      // TODO: Any post-launch setup specific to Cursor
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createCursorAgent();
}

export function detect(): boolean {
  try {
    // Check if cursor CLI is available
    execFileSync("cursor", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
