import {
  shellEscape,
  normalizeAgentPermissionMode,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  recordTerminalActivity,
  hasRecentCommits,
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  isWindows,
  PROCESS_PROBE_INDETERMINATE,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type ProcessProbeResult,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@aoagents/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { stat, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { constants, readFileSync } from "node:fs";

const execFileAsync = promisify(execFile);

// =============================================================================
// Aider Activity Detection Helpers
// =============================================================================

/**
 * Get modification time of Aider chat history file.
 */
async function getChatHistoryMtime(workspacePath: string): Promise<Date | null> {
  try {
    const chatFile = join(workspacePath, ".aider.chat.history.md");
    await access(chatFile, constants.R_OK);
    const stats = await stat(chatFile);
    return stats.mtime;
  } catch {
    return null;
  }
}

// =============================================================================
// Session Info Helpers
// =============================================================================

/**
 * Extract a summary from Aider's chat history file.
 * Reads the first user message (lines starting with "#### " in the markdown format)
 * and truncates to 120 characters.
 */
async function extractAiderSummary(workspacePath: string): Promise<string | null> {
  try {
    const chatFile = join(workspacePath, ".aider.chat.history.md");
    const content = await readFile(chatFile, "utf-8");

    // Aider chat history uses "#### " prefix for user messages
    for (const line of content.split("\n")) {
      if (line.startsWith("#### ")) {
        const msg = line.slice(5).trim();
        if (msg.length > 0) {
          return msg.length > 120 ? msg.substring(0, 120) + "..." : msg;
        }
      }
    }
  } catch {
    // File doesn't exist or read error
  }
  return null;
}

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "aider",
  slot: "agent" as const,
  description: "Agent plugin: Aider",
  version: "0.1.0",
  displayName: "Aider",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createAiderAgent(): Agent {
  return {
    name: "aider",
    processName: "aider",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["aider"];

      const permissionMode = normalizeAgentPermissionMode(config.permissions);
      if (permissionMode === "permissionless" || permissionMode === "auto-edit") {
        parts.push("--yes");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      if (config.systemPromptFile) {
        if (isWindows()) {
          const content = readFileSync(config.systemPromptFile, "utf-8");
          parts.push("--system-prompt", shellEscape(content));
        } else {
          parts.push("--system-prompt", `"$(cat ${shellEscape(config.systemPromptFile)})"`);
        }
      } else if (config.systemPrompt) {
        parts.push("--system-prompt", shellEscape(config.systemPrompt));
      }

      if (config.prompt) {
        parts.push("--message", shellEscape(config.prompt));
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

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput.trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";

      // Aider's input prompt — agent is idle, waiting for user command
      if (/^[>$#]\s*$/.test(lastLine)) return "idle";
      // Aider-specific prompt patterns
      if (/^aider>\s*$/.test(lastLine)) return "idle";

      // Check the last few lines for permission/confirmation prompts
      const tail = lines.slice(-5).join("\n");
      if (/\(Y\)es.*\(N\)o/i.test(tail)) return "waiting_input";
      if (/Allow creation of/i.test(tail)) return "waiting_input";
      if (/Add .+ to the chat\?/i.test(tail)) return "waiting_input";
      if (/\[Yes\].*\[No\]/i.test(tail)) return "waiting_input";
      if (/proceed\?/i.test(tail)) return "waiting_input";

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
      if (running === PROCESS_PROBE_INDETERMINATE) return null;
      if (!running) return { state: "exited", timestamp: exitedAt };

      // Process is running - check for activity signals
      if (!session.workspacePath) return null;

      // 1. Check AO activity JSONL first (written by recordActivity from terminal output).
      //    This is the only source of waiting_input/blocked states for Aider.
      const activityResult = await readLastActivityEntry(session.workspacePath);
      const activityState = checkActivityLogState(activityResult);
      if (activityState) return activityState;

      // 2. Fallback: check for recent git commits (Aider auto-commits changes)
      const hasCommits = await hasRecentCommits(session.workspacePath);
      if (hasCommits) return { state: "active" };

      // 3. Fallback: check chat history file modification time
      const chatMtime = await getChatHistoryMtime(session.workspacePath);
      if (chatMtime) {
        const ageMs = Date.now() - chatMtime.getTime();
        const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);
        if (ageMs <= activeWindowMs) return { state: "active", timestamp: chatMtime };
        if (ageMs <= threshold) return { state: "ready", timestamp: chatMtime };
        return { state: "idle", timestamp: chatMtime };
      }

      // 4. Fallback: use JSONL entry with age-based decay when chat history is unavailable.
      const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);
      const fallback = getActivityFallbackState(activityResult, activeWindowMs, threshold);
      if (fallback) return fallback;

      return null;
    },

    async recordActivity(session: Session, terminalOutput: string): Promise<void> {
      if (!session.workspacePath) return;
      await recordTerminalActivity(session.workspacePath, terminalOutput, (output) =>
        this.detectActivity(output),
      );
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<ProcessProbeResult> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          // ps -eo is Unix-only; guard against stale tmux handles on Windows
          if (isWindows()) return false;
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
          if (!psOut) return PROCESS_PROBE_INDETERMINATE;
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)aider(?:\s|$)/;
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
        return PROCESS_PROBE_INDETERMINATE;
      }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      const summary = await extractAiderSummary(session.workspacePath);
      if (!summary) return null;

      return {
        summary,
        summaryIsFallback: true,
        agentSessionId: null,
        // Aider doesn't expose token/cost data
      };
    },

    // Aider doesn't support session resume — return null so caller falls back to getLaunchCommand
    async getRestoreCommand(): Promise<string | null> {
      return null;
    },

    async setupWorkspaceHooks(_workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      // PATH wrappers are installed by session-manager for all agents.
    },

    async postLaunchSetup(_session: Session): Promise<void> {
      // PATH wrappers are re-ensured by session-manager.
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createAiderAgent();
}

export function detect(): boolean {
  try {
    execFileSync("aider", ["--version"], {
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
