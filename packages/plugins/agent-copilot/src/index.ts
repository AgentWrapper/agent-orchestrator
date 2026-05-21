import {
  DEFAULT_ACTIVE_WINDOW_MS,
  DEFAULT_READY_THRESHOLD_MS,
  PROCESS_PROBE_INDETERMINATE,
  checkActivityLogState,
  getActivityFallbackState,
  isWindows,
  normalizeAgentPermissionMode,
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
  type ProcessProbeResult,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@aoagents/ao-core";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
const COPILOT_EXECUTABLE = "copilot";
const COPILOT_PROCESS_RE = /(?:^|\/)copilot(?:\s|$)/;
const COPILOT_SESSION_NAMESPACE = "ao-agent-copilot";
const UUID_VERSION_8_CUSTOM = 0x80;

const ANSI_ESCAPE_RE = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  "g",
);

function makeCopilotSessionId(sessionId: string): string {
  const bytes = createHash("sha256")
    .update(`${COPILOT_SESSION_NAMESPACE}:${sessionId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | UUID_VERSION_8_CUSTOM;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function classifyCopilotTerminalOutput(terminalOutput: string): ActivityState {
  const normalizedOutput = terminalOutput.replaceAll(ANSI_ESCAPE_RE, "").trim();
  if (!normalizedOutput) return "idle";

  const lines = normalizedOutput.split("\n").map((line) => line.trim());
  const lastLine = lines[lines.length - 1] ?? "";
  const lastNonEmptyLine = [...lines].reverse().find(Boolean) ?? "";
  const lowerOutput = normalizedOutput.toLowerCase();
  const lowerLastLine = lastLine.toLowerCase();

  if (/^[>$#]\s*$/.test(lastLine)) return "idle";
  if (
    lowerOutput.includes("confirm folder trust") ||
    lowerOutput.includes("do you trust the files in this folder?")
  ) {
    return "waiting_input";
  }
  if (lowerOutput.includes("current selection:") && lowerOutput.includes("enter to select")) {
    return "waiting_input";
  }
  if (
    lowerOutput.includes("permission needed:") ||
    lowerOutput.includes("path permission needed:")
  ) {
    return "waiting_input";
  }
  if (
    /\b(run command|allow command|approve|deny)\b/i.test(lastNonEmptyLine) &&
    /\?\s*$/.test(lastNonEmptyLine)
  ) {
    return "waiting_input";
  }
  if (
    lowerOutput.includes("no prompt provided") ||
    lowerOutput.includes("not authenticated") ||
    lowerOutput.includes("authentication failed") ||
    lowerOutput.includes("could not locate copilot cli") ||
    lowerOutput.includes("cannot find github copilot cli") ||
    /^error\b/i.test(lastLine) ||
    lowerLastLine.startsWith("error:")
  ) {
    return "blocked";
  }

  return "active";
}

function getConfiguredModel(config: AgentLaunchConfig): string | undefined {
  const agentConfig = config.projectConfig.agentConfig as AgentSpecificConfig | undefined;
  return config.model ?? agentConfig?.model;
}

function getConfiguredPermissionMode(config: AgentLaunchConfig): string | undefined {
  const agentConfig = config.projectConfig.agentConfig as AgentSpecificConfig | undefined;
  return config.permissions ?? agentConfig?.permissions;
}

function buildInitialPrompt(config: AgentLaunchConfig): string | null {
  const parts: string[] = [];

  if (config.systemPromptFile) {
    try {
      const systemPrompt = readFileSync(config.systemPromptFile, "utf-8").trim();
      if (systemPrompt) parts.push(systemPrompt);
    } catch {
      // Continue with the task prompt if the system prompt file is unexpectedly unavailable.
    }
  } else if (config.systemPrompt?.trim()) {
    parts.push(config.systemPrompt.trim());
  }

  if (config.prompt?.trim()) {
    parts.push(`## User Request\n${config.prompt.trim()}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

function buildCopilotCommand(
  config: AgentLaunchConfig,
  options: { restoreSessionId?: string } = {},
): string {
  const parts = [COPILOT_EXECUTABLE, "--no-auto-update"];
  const copilotSessionId = options.restoreSessionId ?? makeCopilotSessionId(config.sessionId);
  if (options.restoreSessionId) {
    parts.push(`--resume=${shellEscape(copilotSessionId)}`);
  } else {
    parts.push("--name", shellEscape(copilotSessionId));
  }

  const model = getConfiguredModel(config);
  if (model) {
    parts.push("--model", shellEscape(model));
  }

  const permissionMode = normalizeAgentPermissionMode(getConfiguredPermissionMode(config));
  if (permissionMode === "permissionless") {
    parts.push("--allow-all");
  } else if (permissionMode === "auto-edit") {
    parts.push("--allow-tool=write");
  }

  if (!options.restoreSessionId) {
    const initialPrompt = buildInitialPrompt(config);
    if (initialPrompt) {
      parts.push("--interactive", shellEscape(initialPrompt));
    }
  }

  return parts.join(" ");
}

export const manifest = {
  name: pluginName,
  slot: "agent" as const,
  description: packageJson.description,
  version: packageJson.version,
  displayName: "GitHub Copilot CLI",
};

function createCopilotAgent(): Agent {
  return {
    name: pluginName,
    processName: pluginName,
    promptDelivery: "inline",

    getLaunchCommand(config: AgentLaunchConfig): string {
      return buildCopilotCommand(config);
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      env["COPILOT_AUTO_UPDATE"] = "false";

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyCopilotTerminalOutput(terminalOutput);
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
      if (running === PROCESS_PROBE_INDETERMINATE) return null;

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
        classifyCopilotTerminalOutput(output),
      );
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<ProcessProbeResult> {
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
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (COPILOT_PROCESS_RE.test(args)) {
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

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      return {
        agentSessionId: makeCopilotSessionId(session.id),
        summary: null,
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      return buildCopilotCommand(
        {
          sessionId: session.id,
          projectConfig: project,
          workspacePath: session.workspacePath ?? undefined,
          issueId: session.issueId ?? undefined,
        },
        { restoreSessionId: makeCopilotSessionId(session.id) },
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
  return createCopilotAgent();
}

export function detect(): boolean {
  try {
    return Boolean(which.sync(COPILOT_EXECUTABLE));
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
