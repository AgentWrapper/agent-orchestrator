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
  type AgentLaunchConfig,
  type AgentSessionInfo,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
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
const CRUSH_COMMAND_TIMEOUT_MS = 30_000;
const ANSI_ESCAPE_RE = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  "g",
);
const CRUSH_PERMISSION_PROMPT_RE = /^Allow\?\s*\[[Yy]\/[Nn]\/always\]\s*$/;

interface CrushAgentConfig {
  crushSessionId?: unknown;
}

interface CrushSessionMetadataJson {
  id?: unknown;
  uuid?: unknown;
  title?: unknown;
  summary?: unknown;
}

interface CrushSessionShowJson extends CrushSessionMetadataJson {
  meta?: unknown;
}

function asCrushSessionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseCrushSessionShowJson(text: string): CrushSessionShowJson | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as CrushSessionShowJson) : null;
  } catch {
    return null;
  }
}

function getCrushSessionMetadata(sessionInfo: CrushSessionShowJson | null): CrushSessionMetadataJson {
  if (!sessionInfo) return {};

  const nestedMeta =
    sessionInfo.meta && typeof sessionInfo.meta === "object"
      ? (sessionInfo.meta as CrushSessionMetadataJson)
      : {};

  return {
    id: nestedMeta.id ?? sessionInfo.id,
    uuid: nestedMeta.uuid ?? sessionInfo.uuid,
    title: nestedMeta.title ?? sessionInfo.title,
    summary: nestedMeta.summary ?? sessionInfo.summary,
  };
}

async function fetchCrushSessionInfo(sessionId: string): Promise<CrushSessionShowJson | null> {
  try {
    const { stdout } = await execFileAsync("crush", ["session", "show", sessionId, "--json"], {
      timeout: CRUSH_COMMAND_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      shell: isWindows(),
      windowsHide: true,
    });
    return parseCrushSessionShowJson(stdout);
  } catch {
    return null;
  }
}

function buildCrushPromptInputCommand(config: AgentLaunchConfig): string | null {
  const taskPrompt = typeof config.prompt === "string" ? config.prompt : "";
  if (taskPrompt.length === 0) return null;

  const escapedTaskPrompt = shellEscape(taskPrompt);
  if (config.systemPromptFile) {
    return `{ cat ${shellEscape(config.systemPromptFile)}; printf '\n\n'; printf '%s\n' ${escapedTaskPrompt}; }`;
  }

  if (config.systemPrompt) {
    return `{ printf '%s\n' ${shellEscape(config.systemPrompt)}; printf '\n'; printf '%s\n' ${escapedTaskPrompt}; }`;
  }

  return `printf '%s\n' ${escapedTaskPrompt}`;
}

function classifyCrushTerminalOutput(terminalOutput: string): ActivityState {
  const normalizedOutput = terminalOutput.replaceAll(ANSI_ESCAPE_RE, "").trim();
  if (!normalizedOutput) return "idle";

  const lines = normalizedOutput.split("\n").map((line) => line.trim());
  const lastLine = lines[lines.length - 1] ?? "";
  const lastNonEmptyLine = [...lines].reverse().find(Boolean) ?? "";

  if (/^[>$#]\s*$/.test(lastLine)) return "idle";
  if (CRUSH_PERMISSION_PROMPT_RE.test(lastNonEmptyLine)) return "waiting_input";
  if (/error|failed|exception/i.test(lastLine)) return "blocked";

  return "active";
}

export const manifest = {
  name: pluginName,
  slot: "agent" as const,
  description: packageJson.description,
  version: packageJson.version,
  displayName: "Crush",
};

function createCrushAgent(): Agent {
  return {
    name: pluginName,
    processName: pluginName,
    promptDelivery: "inline",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const sessionId = asCrushSessionId(
        (config.projectConfig.agentConfig as CrushAgentConfig | undefined)?.crushSessionId,
      );
      const promptInputCommand = buildCrushPromptInputCommand(config);
      if (promptInputCommand) {
        const sessionFlag = sessionId ? ` --session ${shellEscape(sessionId)}` : "";
        const continueCommand = sessionId
          ? `crush --session ${shellEscape(sessionId)}`
          : "crush --continue";
        return `${promptInputCommand} | crush run --quiet${sessionFlag} && ${continueCommand}`;
      }
      if (!sessionId) {
        return "crush";
      }
      return `crush --session ${shellEscape(sessionId)}`;
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      env["PATH"] = buildAgentPath(process.env["PATH"]);
      env["GH_PATH"] = PREFERRED_GH_PATH;

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyCrushTerminalOutput(terminalOutput);
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
        classifyCrushTerminalOutput(output),
      );
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          if (isWindows()) return false;
          const { stdout: ttyOut } = await execFileAsync(
            "tmux",
            ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
            { timeout: CRUSH_COMMAND_TIMEOUT_MS },
          );
          const ttys = ttyOut
            .trim()
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
            timeout: CRUSH_COMMAND_TIMEOUT_MS,
          });
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)(?:crush|run-crush\.js)(?:\s|$)/;
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
      const sessionId = asCrushSessionId(session.metadata?.crushSessionId);
      if (!sessionId) return null;

      const sessionInfo = await fetchCrushSessionInfo(sessionId);
      const sessionMeta = getCrushSessionMetadata(sessionInfo);
      const parsedSessionId =
        asCrushSessionId(sessionMeta.uuid) ?? asCrushSessionId(sessionMeta.id);
      const summary =
        typeof sessionMeta.title === "string" && sessionMeta.title.trim().length > 0
          ? sessionMeta.title.trim()
          : typeof sessionMeta.summary === "string" && sessionMeta.summary.trim().length > 0
            ? sessionMeta.summary.trim()
            : null;

      return {
        agentSessionId: parsedSessionId ?? sessionId,
        summary,
        summaryIsFallback: summary ? false : undefined,
        ...(parsedSessionId && parsedSessionId !== sessionId
          ? { metadata: { crushSessionId: parsedSessionId } }
          : {}),
      };
    },

    async getRestoreCommand(session: Session, _project: ProjectConfig): Promise<string | null> {
      const sessionId = asCrushSessionId(session.metadata?.crushSessionId);
      if (!sessionId) return null;
      return `crush --session ${shellEscape(sessionId)}`;
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
  return createCrushAgent();
}

export function detect(): boolean {
  try {
    return Boolean(which.sync("crush"));
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
