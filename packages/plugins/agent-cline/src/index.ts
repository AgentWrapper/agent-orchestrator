import {
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  PROCESS_PROBE_INDETERMINATE,
  isWindows,
  shellEscape,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  recordTerminalActivity,
  setupPathWrapperWorkspace,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type ProjectConfig,
  type ProcessProbeResult,
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
const CLINE_COMMAND_TIMEOUT_MS = 30_000;
const CLINE_HISTORY_LIMIT = "200";
const ANSI_ESCAPE_RE = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  "g",
);
const CLINE_APPROVAL_PROMPT_RE = /approve\s+"?[\w.-]+"?.*\[[Yy]\/N\]\s*$/i;
const CLINE_CONTINUE_PROMPT_RE =
  /(?:do you want to continue|continue\?|proceed\?).*(?:\[[Yy]\/N\]|[Yy]\/N)\s*$/i;

interface ClineHistoryEntry {
  sessionId?: unknown;
  prompt?: unknown;
  metadata?: {
    title?: unknown;
  };
}

function asValidClineSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return undefined;
  if (/[\0\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

function getConfiguredSessionId(config: AgentLaunchConfig): string | undefined {
  return asValidClineSessionId(config.projectConfig.agentConfig?.["clineSessionId"]);
}

function classifyClineTerminalOutput(terminalOutput: string): ActivityState {
  const normalizedOutput = terminalOutput.replaceAll(ANSI_ESCAPE_RE, "").trim();
  if (!normalizedOutput) return "idle";

  const lines = normalizedOutput.split("\n").map((line) => line.trim());
  const lastLine = lines[lines.length - 1] ?? "";
  const lastNonEmptyLine = [...lines].reverse().find(Boolean) ?? "";

  if (/^>\s*$/.test(lastLine)) return "idle";
  if (/press\s+h\s*\+\s*enter\s+to\s+show\s+shortcuts/i.test(lastNonEmptyLine)) return "idle";
  if (CLINE_APPROVAL_PROMPT_RE.test(lastNonEmptyLine)) return "waiting_input";
  if (CLINE_CONTINUE_PROMPT_RE.test(lastNonEmptyLine)) return "waiting_input";
  if (/\b(?:task\s+(?:completed|finished)|session\s+ended)\b/i.test(lastNonEmptyLine))
    return "ready";
  if (
    /\b(error|failed|exception|not authenticated|requires a tty|requires approval in a tty|denied by user)\b/i.test(
      lastNonEmptyLine,
    )
  ) {
    return "blocked";
  }

  return "active";
}

function parseClineHistory(text: string): ClineHistoryEntry[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed)
      ? (parsed.filter((entry) => entry && typeof entry === "object") as ClineHistoryEntry[])
      : [];
  } catch {
    return [];
  }
}

async function readClineHistory(): Promise<ClineHistoryEntry[]> {
  try {
    const { stdout } = await execFileAsync(
      "cline",
      ["history", "--json", "--limit", CLINE_HISTORY_LIMIT],
      {
        timeout: CLINE_COMMAND_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
    );
    return parseClineHistory(stdout);
  } catch {
    return [];
  }
}

function getHistorySummary(entry: ClineHistoryEntry): {
  summary: string | null;
  summaryIsFallback?: boolean;
} {
  const title = typeof entry.metadata?.title === "string" ? entry.metadata.title.trim() : "";
  if (title) return { summary: title, summaryIsFallback: false };

  const prompt = typeof entry.prompt === "string" ? entry.prompt.trim() : "";
  if (prompt) return { summary: prompt.slice(0, 200), summaryIsFallback: true };

  return { summary: null };
}

export const manifest = {
  name: pluginName,
  slot: "agent" as const,
  description: packageJson.description,
  version: packageJson.version,
  displayName: "Cline",
};

function createClineAgent(): Agent {
  return {
    name: pluginName,
    processName: pluginName,
    promptDelivery: "post-launch",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const sessionId = getConfiguredSessionId(config);
      if (!sessionId) {
        return "cline --tui";
      }
      return `cline --tui --id ${shellEscape(sessionId)}`;
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      // NOTE: AO_PROJECT_ID is the caller's responsibility (spawn.ts sets it)
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyClineTerminalOutput(terminalOutput);
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
        classifyClineTerminalOutput(output),
      );
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<ProcessProbeResult> {
      if (handle.runtimeName === "tmux" && handle.id) {
        if (isWindows()) return false;

        try {
          const { stdout: ttyOut } = await execFileAsync(
            "tmux",
            ["list-panes", "-t", `=${handle.id}`, "-F", "#{pane_tty}"],
            { timeout: CLINE_COMMAND_TIMEOUT_MS, windowsHide: true },
          );
          const ttys = ttyOut
            .trim()
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean);
          if (ttys.length === 0) return PROCESS_PROBE_INDETERMINATE;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
            timeout: CLINE_COMMAND_TIMEOUT_MS,
            windowsHide: true,
          });
          if (!psOut.trim()) return PROCESS_PROBE_INDETERMINATE;

          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|[\s/])cline(?:\s|$)/;
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (processRe.test(args)) {
              return true;
            }
          }
          return false;
        } catch {
          return PROCESS_PROBE_INDETERMINATE;
        }
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
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      const sessionId = asValidClineSessionId(session.metadata["clineSessionId"]);
      if (!sessionId) return null;

      const history = await readClineHistory();
      const entry = history.find((item) => asValidClineSessionId(item.sessionId) === sessionId);
      const { summary, summaryIsFallback } = entry ? getHistorySummary(entry) : { summary: null };

      return {
        agentSessionId: sessionId,
        summary,
        summaryIsFallback,
      };
    },

    async getRestoreCommand(session: Session, _project: ProjectConfig): Promise<string | null> {
      const sessionId = asValidClineSessionId(session.metadata["clineSessionId"]);
      if (!sessionId) return null;
      return `cline --tui --id ${shellEscape(sessionId)}`;
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
  return createClineAgent();
}

export function detect(): boolean {
  try {
    return Boolean(which.sync("cline"));
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
