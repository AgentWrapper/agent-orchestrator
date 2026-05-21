import {
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  shellEscape,
  buildAgentPath,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  recordTerminalActivity,
  setupPathWrapperWorkspace,
  PREFERRED_GH_PATH,
  isWindows,
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
  type AgentSpecificConfig,
} from "@aoagents/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

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
const AUGGIE_CONFIRM_PROMPT_RE =
  /(?:\?|>)?\s*(?:do you want to|would you like to|allow|approve|confirm|continue|proceed).*(?:\?|\b[yY]\/\b[nN]|\b[nN]\/\b[yY]|\[\s*[yYnN][^\]]*\])\s*:?$/i;
const AUGGIE_INPUT_PROMPT_RE = /^(?:>|@[^\s]+:\S+\$)\s*$/;
const AUGGIE_AUTH_PROMPT_RE =
  /(?:login to continue|press return to open your browser|authenticate with augment)/i;

interface AuggieAgentConfig extends AgentSpecificConfig {
  auggieSessionId?: string;
}

function asAuggieSessionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmed)) return null;
  return trimmed;
}

function resolveConfiguredSessionId(config: AgentLaunchConfig): string | null {
  return asAuggieSessionId(
    (config.projectConfig.agentConfig as AuggieAgentConfig | undefined)?.auggieSessionId,
  );
}

function resolveConfiguredModel(config: AgentLaunchConfig): string | null {
  const raw =
    config.model ?? (config.projectConfig.agentConfig as AuggieAgentConfig | undefined)?.model;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function buildAuggieCommand(config: AgentLaunchConfig, sessionId?: string | null): string {
  const args = ["auggie", "--allow-indexing"];
  const model = resolveConfiguredModel(config);
  if (model) {
    args.push("--model", shellEscape(model));
  }
  if (sessionId) {
    args.push("--resume", shellEscape(sessionId));
  }
  return args.join(" ");
}

function classifyAuggieTerminalOutput(terminalOutput: string): ActivityState {
  const normalizedOutput = terminalOutput.replaceAll(ANSI_ESCAPE_RE, "").trim();
  if (!normalizedOutput) return "idle";

  const lines = normalizedOutput.split("\n").map((line) => line.trim());
  const lastLine = lines[lines.length - 1] ?? "";
  const lastNonEmptyLine = [...lines].reverse().find(Boolean) ?? "";

  if (AUGGIE_INPUT_PROMPT_RE.test(lastLine)) return "idle";
  if (AUGGIE_AUTH_PROMPT_RE.test(normalizedOutput)) return "waiting_input";
  if (AUGGIE_CONFIRM_PROMPT_RE.test(lastNonEmptyLine)) return "waiting_input";
  if (/error|failed|exception/i.test(lastLine)) return "blocked";

  return "active";
}

export const manifest = {
  name: pluginName,
  slot: "agent" as const,
  description: packageJson.description,
  version: packageJson.version,
  displayName: "Auggie",
};

function createAuggieAgent(): Agent {
  return {
    name: pluginName,
    processName: pluginName,
    promptDelivery: "post-launch",

    getLaunchCommand(config: AgentLaunchConfig): string {
      return buildAuggieCommand(config, resolveConfiguredSessionId(config));
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      // NOTE: AO_PROJECT_ID is the caller's responsibility (spawn.ts sets it)
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      env["PATH"] = buildAgentPath(process.env["PATH"]);
      env["GH_PATH"] = PREFERRED_GH_PATH;
      env["AUGMENT_DISABLE_AUTO_UPDATE"] = "1";

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyAuggieTerminalOutput(terminalOutput);
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
        classifyAuggieTerminalOutput(output),
      );
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
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
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)(?:auggie|augment\.mjs)(?:\s|$)/;
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
      const sessionId = asAuggieSessionId(session.metadata?.auggieSessionId);
      if (!sessionId) return null;
      return {
        agentSessionId: sessionId,
        summary: null,
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      const sessionId = asAuggieSessionId(session.metadata?.auggieSessionId);
      if (!sessionId) return null;
      return buildAuggieCommand(
        {
          sessionId: session.id,
          projectConfig: project,
          workspacePath: session.workspacePath ?? undefined,
          issueId: session.issueId ?? undefined,
        },
        sessionId,
      );
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
  return createAuggieAgent();
}

export function detect(): boolean {
  try {
    execFileSync("auggie", ["--version"], {
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
