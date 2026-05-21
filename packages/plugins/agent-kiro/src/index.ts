import {
  DEFAULT_ACTIVE_WINDOW_MS,
  DEFAULT_READY_THRESHOLD_MS,
  PREFERRED_GH_PATH,
  buildAgentPath,
  checkActivityLogState,
  getActivityFallbackState,
  isWindows,
  readLastActivityEntry,
  recordTerminalActivity,
  setupPathWrapperWorkspace,
  shellEscape,
  type ActivityDetection,
  type ActivityState,
  type Agent,
  type AgentLaunchConfig,
  type AgentSessionInfo,
  type AgentSpecificConfig,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@aoagents/ao-core";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
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
const KIRO_EXECUTABLE = "kiro-cli";
const KIRO_COMMAND_TIMEOUT_MS = 30_000;

interface KiroAgentConfig extends AgentSpecificConfig {
  kiroSessionId?: unknown;
}

function asValidKiroSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmed)) return null;
  return trimmed;
}

const ANSI_ESCAPE_RE = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  "g",
);

function readSystemPromptFile(systemPromptFile: string | undefined): string | null {
  if (!systemPromptFile) return null;
  try {
    return readFileSync(systemPromptFile, "utf8");
  } catch {
    return null;
  }
}

function buildInitialInput(config: AgentLaunchConfig): string | null {
  const parts = [
    readSystemPromptFile(config.systemPromptFile) ?? config.systemPrompt,
    config.prompt,
  ]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

function appendInitialInput(command: string, config: AgentLaunchConfig): string {
  const input = buildInitialInput(config);
  if (!input) return command;
  return `${command} ${shellEscape(input)}`;
}

function classifyKiroTerminalOutput(terminalOutput: string): ActivityState {
  const normalizedOutput = terminalOutput.replaceAll(ANSI_ESCAPE_RE, "").trim();
  if (!normalizedOutput) return "idle";

  const lines = normalizedOutput.split("\n").map((line) => line.trim());
  const lastLine = lines[lines.length - 1] ?? "";
  const lastNonEmptyLine = [...lines].reverse().find(Boolean) ?? "";

  if (/^[>$#]\s*$/.test(lastLine)) return "idle";
  if (
    /\b(yes|trust|no)\b/i.test(lastNonEmptyLine) &&
    /\b(approval|permission|approve|trust)\b/i.test(normalizedOutput)
  ) {
    return "waiting_input";
  }
  if (
    /\b(awaiting approval|requires approval|requires permission|permission required)\b/i.test(
      normalizedOutput,
    )
  ) {
    return "waiting_input";
  }
  if (/\b(error|failed|exception)\b/i.test(lastLine)) return "blocked";

  return "active";
}

export const manifest = {
  name: pluginName,
  slot: "agent" as const,
  description: packageJson.description,
  version: packageJson.version,
  displayName: "Kiro",
};

function createKiroAgent(): Agent {
  return {
    name: pluginName,
    processName: KIRO_EXECUTABLE,

    getLaunchCommand(config: AgentLaunchConfig): string {
      const sessionId = asValidKiroSessionId(
        (config.projectConfig.agentConfig as KiroAgentConfig | undefined)?.kiroSessionId,
      );
      if (!sessionId) {
        return appendInitialInput(`${KIRO_EXECUTABLE} chat`, config);
      }
      return appendInitialInput(
        `${KIRO_EXECUTABLE} chat --resume-id ${shellEscape(sessionId)}`,
        config,
      );
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      env["PATH"] = buildAgentPath(process.env["PATH"]);
      env["GH_PATH"] = PREFERRED_GH_PATH;
      env["KIRO_LOG_NO_COLOR"] = "1";

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyKiroTerminalOutput(terminalOutput);
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
        classifyKiroTerminalOutput(output),
      );
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          // tmux and ps are POSIX-only. A stale tmux handle on Windows
          // (e.g. cross-platform session import) would otherwise throw
          // and misclassify a live process as exited.
          if (isWindows()) return false;
          const { stdout: ttyOut } = await execFileAsync(
            "tmux",
            ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
            { timeout: KIRO_COMMAND_TIMEOUT_MS },
          );
          const ttys = ttyOut
            .trim()
            .split("\n")
            .map((tty) => tty.trim())
            .filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
            timeout: KIRO_COMMAND_TIMEOUT_MS,
          });
          const ttySet = new Set(ttys.map((tty) => tty.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)kiro-cli(?:\s|$)/;
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
        return false;
      }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      const sessionId = asValidKiroSessionId(session.metadata?.kiroSessionId);
      if (!sessionId) return null;
      return {
        agentSessionId: sessionId,
        summary: null,
      };
    },

    async getRestoreCommand(session: Session, _project: ProjectConfig): Promise<string | null> {
      const sessionId = asValidKiroSessionId(session.metadata?.kiroSessionId);
      if (!sessionId) return null;
      return `${KIRO_EXECUTABLE} chat --resume-id ${shellEscape(sessionId)}`;
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupPathWrapperWorkspace(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;
      await setupPathWrapperWorkspace(session.workspacePath);
    },
  };
}

export function create(): Agent {
  return createKiroAgent();
}

export function detect(): boolean {
  try {
    return Boolean(which.sync(KIRO_EXECUTABLE));
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
