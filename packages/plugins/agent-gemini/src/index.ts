import {
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  shellEscape,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  recordTerminalActivity,
  PROCESS_PROBE_INDETERMINATE,
  isWindows,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type ProcessProbeResult,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
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
const GEMINI_WAITING_PROMPT_RE =
  /(?:\b(?:allow|approve|confirm|continue|proceed)\b.*\?|\[[YyNn]\/ ?[YyNn]\]|\([YyNn]\/ ?[YyNn]\)|[Yy]es\/?[Nn]o|[Yy]\/[Nn])/i;

function getConfiguredModel(config: AgentLaunchConfig): string | null {
  const launchModel = typeof config.model === "string" ? config.model.trim() : "";
  if (launchModel) return launchModel;

  const rawProjectModel = config.projectConfig.agentConfig?.["model"];
  const projectModel = typeof rawProjectModel === "string" ? rawProjectModel.trim() : "";
  return projectModel || null;
}

function addPromptPart(parts: string[], raw: string | undefined): void {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value) parts.push(`printf %s ${shellEscape(value)}`);
}

function getPromptArgument(config: AgentLaunchConfig): string | null {
  const parts: string[] = [];
  const systemPromptFile =
    typeof config.systemPromptFile === "string" ? config.systemPromptFile.trim() : "";
  if (systemPromptFile) {
    parts.push(`cat ${shellEscape(systemPromptFile)}`);
  }
  addPromptPart(parts, config.systemPrompt);
  addPromptPart(parts, config.prompt);

  if (parts.length === 0) return null;
  return `"$(${parts.join("; printf '\\n\\n'; ")})"`;
}

function classifyGeminiTerminalOutput(terminalOutput: string): ActivityState {
  const normalizedOutput = terminalOutput.replaceAll(ANSI_ESCAPE_RE, "").trim();
  if (!normalizedOutput) return "idle";

  const lines = normalizedOutput.split("\n").map((line) => line.trim());
  const lastLine = lines[lines.length - 1] ?? "";
  const lastNonEmptyLine = [...lines].reverse().find(Boolean) ?? "";

  if (/^[>$#]\s*$/.test(lastLine)) return "idle";
  if (GEMINI_WAITING_PROMPT_RE.test(lastNonEmptyLine)) return "waiting_input";
  if (/error|failed|exception/i.test(lastLine)) return "blocked";

  return "active";
}

export const manifest = {
  name: pluginName,
  slot: "agent" as const,
  description: packageJson.description,
  version: packageJson.version,
  displayName: "Gemini",
};

function createGeminiAgent(): Agent {
  return {
    name: pluginName,
    processName: pluginName,

    getLaunchCommand(config: AgentLaunchConfig): string {
      const args = ["gemini"];
      const model = getConfiguredModel(config);
      if (model) {
        args.push("--model", shellEscape(model));
      }
      const promptArgument = getPromptArgument(config);
      if (promptArgument) {
        args.push("--prompt-interactive", promptArgument);
      }
      return args.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      // PATH and GH_PATH are injected by session-manager for all agents.

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyGeminiTerminalOutput(terminalOutput);
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
      if (running === false) return { state: "exited", timestamp: exitedAt };

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
        classifyGeminiTerminalOutput(output),
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
          const processRe = /(?:^|\/)(?:gemini|gemini\.js)(?:\s|$)/;
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
            if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ESRCH") {
              return false;
            }
            return PROCESS_PROBE_INDETERMINATE;
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

    async setupWorkspaceHooks(_workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      // PATH wrappers are installed by session-manager for all agents.
    },

    async postLaunchSetup(_session: Session): Promise<void> {
      // PATH wrappers are re-ensured by session-manager.
    },
  };
}

export function create(): Agent {
  return createGeminiAgent();
}

export function detect(): boolean {
  try {
    return Boolean(which.sync("gemini"));
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
