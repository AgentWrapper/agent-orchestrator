import {
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  PROCESS_PROBE_INDETERMINATE,
  shellEscape,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  recordTerminalActivity,
  setupPathWrapperWorkspace,
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
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import which from "which";
import packageJson from "../package.json" with { type: "json" };

const PACKAGE_NAME_PREFIX = "@aoagents/ao-plugin-agent-";
const pluginName = packageJson.name.startsWith(PACKAGE_NAME_PREFIX)
  ? packageJson.name.slice(PACKAGE_NAME_PREFIX.length)
  : packageJson.name;

const execFileAsync = promisify(execFile);
const GROK_EXECUTABLE = "grok";
const GROK_STARTUP_READY_TIMEOUT_MS = 30_000;
const GROK_STARTUP_POLL_MS = 500;
const ANSI_ESCAPE_RE = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  "g",
);
const GROK_CONFIRM_PROMPT_RE =
  /(?:allow|approve|do you want to continue|continue anyway|proceed).*(?:y\/n|yes\/no|\[[YyNn]\/ ?[YyNn]\]|\([YyNn]\/ ?[YyNn]\)|\?)\s*:?$/i;
const GROK_AUTH_PROMPT_RE = /(?:sign in with grok|open this url to sign in|oauth2\/authorize)/i;

interface GrokAgentConfig {
  grokSessionId?: unknown;
  model?: unknown;
  grokSandbox?: unknown;
}

function asGrokSessionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/\p{C}/u.test(trimmed)) return null;
  return trimmed.length <= 512 ? trimmed : null;
}

function getConfiguredGrokSessionId(config: AgentLaunchConfig): string | null {
  return asGrokSessionId(
    (config.projectConfig.agentConfig as GrokAgentConfig | undefined)?.grokSessionId,
  );
}

function getConfiguredModel(config: AgentLaunchConfig): string | null {
  const model =
    config.model ?? (config.projectConfig.agentConfig as GrokAgentConfig | undefined)?.model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

function getConfiguredSandbox(config: AgentLaunchConfig): string | null {
  const sandbox = (config.projectConfig.agentConfig as GrokAgentConfig | undefined)?.grokSandbox;
  return typeof sandbox === "string" && sandbox.trim() ? sandbox.trim() : null;
}

function buildGrokCommand(config: AgentLaunchConfig, sessionId?: string | null): string {
  const restoreSessionId = sessionId ?? getConfiguredGrokSessionId(config);
  const parts = [GROK_EXECUTABLE, "--no-alt-screen"];
  if (!restoreSessionId) {
    parts.push("--worktree");
  }
  const model = getConfiguredModel(config);
  if (model) {
    parts.push("--model", shellEscape(model));
  }
  if (config.systemPromptFile) {
    parts.push("--rules", shellEscape(`@${config.systemPromptFile}`));
  } else if (config.systemPrompt) {
    parts.push("--rules", shellEscape(config.systemPrompt));
  }
  if (restoreSessionId) {
    parts.push("--resume", shellEscape(restoreSessionId));
  }
  return parts.join(" ");
}

async function captureTmuxOutput(handle: RuntimeHandle): Promise<string> {
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-t", handle.id, "-p", "-S", "-120"],
    { timeout: 5_000 },
  );
  return stdout;
}

async function waitForGrokWorktreeReady(session: Session): Promise<void> {
  const handle = session.runtimeHandle;
  if (!handle || handle.runtimeName !== "tmux" || !handle.id) return;
  if (isWindows()) return;
  if (asGrokSessionId(session.metadata?.grokSessionId)) return;

  const startedAt = Date.now();
  while (Date.now() - startedAt < GROK_STARTUP_READY_TIMEOUT_MS) {
    const output = await captureTmuxOutput(handle);
    if (/Worktree ready:/i.test(output)) return;
    await sleep(GROK_STARTUP_POLL_MS);
  }
}

function classifyGrokTerminalOutput(terminalOutput: string): ActivityState {
  const normalizedOutput = terminalOutput.replaceAll(ANSI_ESCAPE_RE, "").trim();
  if (!normalizedOutput) return "idle";

  const lines = normalizedOutput.split("\n").map((line) => line.trim());
  const lastLine = lines[lines.length - 1] ?? "";
  const lastNonEmptyLine = [...lines].reverse().find(Boolean) ?? "";

  if (/^[>$#›]\s*$/.test(lastLine)) return "idle";
  if (GROK_AUTH_PROMPT_RE.test(normalizedOutput)) return "waiting_input";
  if (GROK_CONFIRM_PROMPT_RE.test(lastNonEmptyLine)) return "waiting_input";
  if (/\b(error|failed|exception|not authenticated|device not configured)\b/i.test(lastLine))
    return "blocked";

  return "active";
}

export const manifest = {
  name: pluginName,
  slot: "agent" as const,
  description: packageJson.description,
  version: packageJson.version,
  displayName: "Grok",
};

function createGrokAgent(): Agent {
  return {
    name: pluginName,
    processName: pluginName,
    promptDelivery: "post-launch",

    getLaunchCommand(config: AgentLaunchConfig): string {
      return buildGrokCommand(config);
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      const sandbox = getConfiguredSandbox(config);
      if (sandbox) {
        env["GROK_SANDBOX"] = sandbox;
      }

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyGrokTerminalOutput(terminalOutput);
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
        classifyGrokTerminalOutput(output),
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
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|[\s/])\.?grok(?:\s|$)/;
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

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      const grokSessionId = asGrokSessionId(session.metadata?.grokSessionId);
      if (!grokSessionId) return null;
      return {
        agentSessionId: grokSessionId,
        summary: null,
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      const grokSessionId = asGrokSessionId(session.metadata?.grokSessionId);
      if (!grokSessionId) return null;
      return buildGrokCommand(
        {
          sessionId: session.id,
          projectConfig: project,
          workspacePath: session.workspacePath ?? undefined,
          issueId: session.issueId ?? undefined,
        },
        grokSessionId,
      );
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupPathWrapperWorkspace(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (session.workspacePath) {
        await setupPathWrapperWorkspace(session.workspacePath);
      }
      await waitForGrokWorktreeReady(session);
    },
  };
}

export function create(): Agent {
  return createGrokAgent();
}

export function detect(): boolean {
  try {
    return Boolean(which.sync(GROK_EXECUTABLE));
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
