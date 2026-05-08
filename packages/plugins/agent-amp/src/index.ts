import {
  DEFAULT_ACTIVE_WINDOW_MS,
  DEFAULT_READY_THRESHOLD_MS,
  checkActivityLogState,
  getActivityFallbackState,
  readLastActivityEntry,
  recordTerminalActivity,
  shellEscape,
  type Agent,
  type AgentLaunchConfig,
  type AgentSessionInfo,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type RuntimeHandle,
  type Session,
} from "@aoagents/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "amp",
  slot: "agent" as const,
  description: "Agent plugin: Amp CLI",
  version: "0.1.0",
  displayName: "Amp",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createAmpAgent(): Agent {
  return {
    name: "amp",
    processName: "amp",
    promptDelivery: "post-launch",

    getLaunchCommand(config: AgentLaunchConfig): string {
      // Amp uses threads for conversation continuity.
      // On first launch: `amp threads new --execute --dangerously-allow-all`
      // The prompt is sent post-launch via runtime.sendMessage().
      const threadId = (config.projectConfig.agentConfig as Record<string, unknown> | undefined)
        ?.ampThreadId as string | undefined;

      if (threadId) {
        // Resume existing thread
        // --dangerously-allow-all: required for non-interactive operation (see new-thread path)
        return [
          "amp",
          "threads",
          "continue",
          shellEscape(threadId),
          "--execute",
          "--dangerously-allow-all",
          "--no-ide",
        ].join(" ");
      }

      // New thread
      // --dangerously-allow-all is always set: Amp requires it for non-interactive
      // (piped stdin) operation regardless of permissionMode. There is no safer flag.
      return ["amp", "threads", "new", "--execute", "--dangerously-allow-all", "--no-ide"].join(
        " ",
      );
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }
      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";
      // Amp-specific patterns
      if (/\bwaiting for\b|\bconfirm\b|\bapprove\b|\bpermission required\b/i.test(terminalOutput)) {
        return "waiting_input";
      }
      // Match Amp's own fatal/unrecoverable error messages, not compiler output
      if (/\bamp:\s*(error|fatal)\b|^\s*Error:\s/m.test(terminalOutput)) {
        return "blocked";
      }
      return "active";
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;
      const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);

      // 1. Process check — always first
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      // 2. Check AO activity JSONL for actionable states (waiting_input/blocked)
      let activityResult: Awaited<ReturnType<typeof readLastActivityEntry>> = null;
      if (session.workspacePath) {
        activityResult = await readLastActivityEntry(session.workspacePath);
        const activityState = checkActivityLogState(activityResult);
        if (activityState) return activityState;
      }

      // 3. JSONL entry fallback — age-based decay (active → ready → idle)
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
          const processRe = /(?:^|\/)\.?amp(?:\s|$)/;
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
            if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EPERM") {
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

    async getSessionInfo(_session: Session): Promise<AgentSessionInfo | null> {
      // Amp doesn't expose a JSONL session file for introspection
      return null;
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createAmpAgent();
}

export function detect(): boolean {
  try {
    execFileSync("amp", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
