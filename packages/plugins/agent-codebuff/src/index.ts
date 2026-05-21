import {
  DEFAULT_ACTIVE_WINDOW_MS,
  DEFAULT_READY_THRESHOLD_MS,
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
const CODEBUFF_EXECUTABLE = "codebuff";
const CODEBUFF_SESSION_METADATA_KEY = "codebuffConversationId";
const ANSI_ESCAPE_RE = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  "g",
);

const CODEBUFF_INPUT_PROMPT_RE = /enter a coding task or \/ for commands/i;
const CODEBUFF_CONFIRM_PROMPT_RE =
  /(?:\?|\b)(?:allow|approve|confirm|continue|proceed|run|execute)\b.*(?:\[[YyNn][/][YyNn]\]|\([YyNn][/][YyNn]\)|[Yy]\/[Nn]|[Nn]\/[Yy]|yes\/no|y\/n)\s*:?\s*$/i;

function getCodebuffConversationId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getConfiguredConversationId(config: AgentLaunchConfig): string | null {
  return getCodebuffConversationId(
    config.projectConfig.agentConfig?.[CODEBUFF_SESSION_METADATA_KEY],
  );
}

function getSessionConversationId(session: Session): string | null {
  return getCodebuffConversationId(session.metadata?.[CODEBUFF_SESSION_METADATA_KEY]);
}

function readSystemPromptFile(systemPromptFile: string | null): string | null {
  if (!systemPromptFile) return null;
  try {
    const content = readFileSync(systemPromptFile, "utf8");
    return content.trim().length > 0 ? content : null;
  } catch {
    return null;
  }
}

function buildInitialPromptArgument(config: AgentLaunchConfig): string | null {
  const prompt =
    typeof config.prompt === "string" && config.prompt.trim().length > 0 ? config.prompt : null;
  const systemPrompt =
    typeof config.systemPrompt === "string" && config.systemPrompt.trim().length > 0
      ? config.systemPrompt
      : null;
  const systemPromptFile =
    typeof config.systemPromptFile === "string" && config.systemPromptFile.trim().length > 0
      ? config.systemPromptFile
      : null;

  const fileSystemPrompt = readSystemPromptFile(systemPromptFile);
  const promptParts = [fileSystemPrompt ?? systemPrompt, prompt].filter(
    (part): part is string => Boolean(part),
  );
  if (promptParts.length > 0) {
    return shellEscape(promptParts.join("\n\n"));
  }
  return null;
}

function classifyCodebuffTerminalOutput(terminalOutput: string): ActivityState {
  const normalizedOutput = terminalOutput.replaceAll(ANSI_ESCAPE_RE, "").trim();
  if (!normalizedOutput) return "idle";

  const lines = normalizedOutput.split("\n").map((line) => line.trim());
  const lastLine = lines[lines.length - 1] ?? "";
  const lastNonEmptyLine = [...lines].reverse().find(Boolean) ?? "";

  if (/^[>$#]\s*$/.test(lastLine)) return "idle";
  if (CODEBUFF_INPUT_PROMPT_RE.test(lastNonEmptyLine)) return "waiting_input";
  if (CODEBUFF_CONFIRM_PROMPT_RE.test(lastNonEmptyLine)) return "waiting_input";
  if (/error|failed|exception/i.test(lastLine)) return "blocked";

  return "active";
}

export const manifest = {
  name: pluginName,
  slot: "agent" as const,
  description: packageJson.description,
  version: packageJson.version,
  displayName: "Codebuff",
};

function createCodebuffAgent(): Agent {
  return {
    name: pluginName,
    processName: pluginName,
    getLaunchCommand(config: AgentLaunchConfig): string {
      const args: string[] = [];
      const conversationId = getConfiguredConversationId(config);
      if (conversationId) {
        args.push("--continue", shellEscape(conversationId));
      }

      const promptArg = buildInitialPromptArgument(config);
      if (promptArg) {
        args.push(promptArg);
      }

      return args.length > 0 ? `${CODEBUFF_EXECUTABLE} ${args.join(" ")}` : CODEBUFF_EXECUTABLE;
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
      return classifyCodebuffTerminalOutput(terminalOutput);
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
        this.detectActivity(output),
      );
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          // tmux and ps -eo are Unix-only; stale tmux handles are not probed on Windows.
          if (isWindows()) return false;
          const { stdout: ttyOut } = await execFileAsync(
            "tmux",
            ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
            { timeout: 30_000 },
          );
          const ttys = ttyOut
            .trim()
            .split("\n")
            .map((tty) => tty.trim())
            .filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
            timeout: 30_000,
          });
          const ttySet = new Set(ttys.map((tty) => tty.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/|\s)codebuff(?:\s|$)/;
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
      const conversationId = getSessionConversationId(session);
      if (!conversationId) return null;
      return {
        agentSessionId: conversationId,
        summary: null,
      };
    },

    async getRestoreCommand(session: Session, _project: ProjectConfig): Promise<string | null> {
      const conversationId = getSessionConversationId(session);
      if (!conversationId) return null;
      return `${CODEBUFF_EXECUTABLE} --continue ${shellEscape(conversationId)}`;
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
  return createCodebuffAgent();
}

export function detect(): boolean {
  try {
    return Boolean(which.sync(CODEBUFF_EXECUTABLE));
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
