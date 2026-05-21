import {
  DEFAULT_ACTIVE_WINDOW_MS,
  DEFAULT_READY_THRESHOLD_MS,
  PROCESS_PROBE_INDETERMINATE,
  checkActivityLogState,
  getActivityFallbackState,
  isWindows,
  readLastActivityEntry,
  recordTerminalActivity,
  shellEscape,
  type ActivityDetection,
  type ActivityState,
  type Agent,
  type AgentLaunchConfig,
  type AgentSessionInfo,
  type PluginModule,
  type ProcessProbeResult,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
} from "@aoagents/ao-core";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import which from "which";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
  name: string;
  version: string;
  description: string;
};
const PACKAGE_NAME_PREFIX = "@aoagents/ao-plugin-agent-";
const pluginName = packageJson.name.startsWith(PACKAGE_NAME_PREFIX)
  ? packageJson.name.slice(PACKAGE_NAME_PREFIX.length)
  : packageJson.name;

const execFileAsync = promisify(execFile);
const ANSI_ESCAPE_RE = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  "g",
);

function classifyCnTerminalOutput(terminalOutput: string): ActivityState {
  const normalizedOutput = terminalOutput.replaceAll(ANSI_ESCAPE_RE, "").trim();
  if (!normalizedOutput) return "idle";

  const lines = normalizedOutput.split("\n").map((line) => line.trim());
  const lastLine = lines[lines.length - 1] ?? "";
  const nonEmptyLines = lines.filter(Boolean);
  const lastNonEmptyLine = nonEmptyLines[nonEmptyLines.length - 1] ?? "";
  const previousNonEmptyLine = nonEmptyLines[nonEmptyLines.length - 2] ?? "";
  const lastLineIsBarePrompt = /^[>$#]\s*$/.test(lastLine);
  const latestRelevantLine = lastLineIsBarePrompt ? previousNonEmptyLine : lastNonEmptyLine;
  const latestRelevantText =
    /^>\s*\S/.test(latestRelevantLine) && /Would you like to continue\?/i.test(previousNonEmptyLine)
      ? `${previousNonEmptyLine}\n${latestRelevantLine}`
      : latestRelevantLine;

  if (!latestRelevantLine) return "idle";
  if (/Enter text\.\.\./i.test(latestRelevantLine)) return "idle";
  if (
    /Would you like to continue\?/i.test(latestRelevantText) ||
    /Press enter to continue/i.test(latestRelevantText) ||
    /Press Enter for default/i.test(latestRelevantText) ||
    /Enter your .*API key/i.test(latestRelevantText)
  ) {
    return "waiting_input";
  }
  if (
    /Not authenticated|Please run ['"]?cn login|Authentication required/i.test(latestRelevantText)
  ) {
    return "blocked";
  }
  if (/^\s*(error|failed|exception)\b/i.test(latestRelevantLine)) return "blocked";

  return "active";
}

export const manifest = {
  name: pluginName,
  slot: "agent" as const,
  description: packageJson.description,
  version: packageJson.version,
  displayName: "Continue CLI",
};

function createCnAgent(): Agent {
  return {
    name: pluginName,
    processName: pluginName,

    getLaunchCommand(config: AgentLaunchConfig): string {
      const args: string[] = [];
      if (config.systemPromptFile) {
        args.push("--prompt", shellEscape(config.systemPromptFile));
      }
      if (config.prompt) {
        args.push(shellEscape(config.prompt));
      }

      return args.length > 0 ? `cn ${args.join(" ")}` : "cn";
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      env["CONTINUE_CLI_ENABLE_TELEMETRY"] = "0";
      env["CONTINUE_METRICS_ENABLED"] = "0";
      env["CONTINUE_ALLOW_ANONYMOUS_TELEMETRY"] = "0";

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyCnTerminalOutput(terminalOutput);
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;
      const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);

      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (running === PROCESS_PROBE_INDETERMINATE) return null;
      if (!running) return { state: "exited", timestamp: exitedAt };

      let activityResult: Awaited<ReturnType<typeof readLastActivityEntry>> = null;
      if (session.workspacePath) {
        activityResult = await readLastActivityEntry(session.workspacePath);
        const activityState = checkActivityLogState(activityResult);
        if (activityState) return activityState;
      }

      const fallback = getActivityFallbackState(activityResult, activeWindowMs, threshold);
      if (fallback) return fallback;

      return null;
    },

    async recordActivity(session: Session, terminalOutput: string): Promise<void> {
      if (!session.workspacePath) return;
      await recordTerminalActivity(session.workspacePath, terminalOutput, (output: string) =>
        classifyCnTerminalOutput(output),
      );
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<ProcessProbeResult> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          if (isWindows()) return PROCESS_PROBE_INDETERMINATE;

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
          const processRe = /(?:^|\/)(?:cn|cn\.js)(?:\s|$)/;
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
            if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EPERM") {
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

    async getSessionInfo(_session: Session): Promise<AgentSessionInfo | null> {
      return null;
    },

    async getRestoreCommand(_session: Session, _project: ProjectConfig): Promise<string | null> {
      return null;
    },

  };
}

export function create(): Agent {
  return createCnAgent();
}

export function detect(): boolean {
  try {
    return Boolean(which.sync("cn"));
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
