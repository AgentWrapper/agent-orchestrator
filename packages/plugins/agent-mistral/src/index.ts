import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";
import {
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
  buildAgentPath,
  checkActivityLogState,
  getActivityFallbackState,
  readLastActivityEntry,
  recordTerminalActivity,
  setupPathWrapperWorkspace,
  shellEscape,
} from "@aoagents/ao-core";
import which from "which";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { name: string; version: string };

const PACKAGE_PREFIX = "@aoagents/ao-plugin-agent-";
const VIBE_EXECUTABLE = "vibe";
const COMMAND_TIMEOUT_MS = 2_000;
const ACTIVE_WINDOW_MS = 30_000;
const MAX_METADATA_BYTES = 64 * 1024;

type MistralAgent = Agent & { promptDelivery: "post-launch" };

function pluginNameFromPackageName(packageName: string): string {
  return packageName.startsWith(PACKAGE_PREFIX)
    ? packageName.slice(PACKAGE_PREFIX.length)
    : packageName;
}

const pluginName = pluginNameFromPackageName(packageJson.name);

export const manifest = {
  name: pluginName,
  slot: "agent" as const,
  description: "Agent plugin: Mistral Vibe CLI",
  version: packageJson.version,
  displayName: "Mistral Vibe",
};

export function detect(): boolean {
  try {
    return Boolean(which.sync(VIBE_EXECUTABLE));
  } catch {
    return false;
  }
}

function workspacePathFor(config: AgentLaunchConfig): string {
  return config.workspacePath ?? config.projectConfig.path;
}

function permissionAgentFlag(permissions: AgentLaunchConfig["permissions"]): string | null {
  if (permissions === "permissionless" || permissions === "skip") return "auto-approve";
  if (permissions === "auto-edit") return "accept-edits";
  return null;
}

function buildLaunchCommand(config: AgentLaunchConfig): string {
  const args = [VIBE_EXECUTABLE, "--workdir", shellEscape(workspacePathFor(config)), "--trust"];
  const agent = permissionAgentFlag(config.permissions);
  if (agent) args.push("--agent", shellEscape(agent));
  return args.join(" ");
}

function getConfiguredVibeHome(): string {
  const configured = process.env["VIBE_HOME"];
  return configured ? resolve(configured) : join(homedir(), ".vibe");
}

function getVibeSessionLogDir(): string {
  return join(getConfiguredVibeHome(), "logs", "session");
}

function normalizePathForCompare(path: string): string {
  return resolve(path);
}

interface VibeMetadata {
  session_id?: unknown;
  title?: unknown;
  environment?: unknown;
}

function readJsonFileBounded(path: string): unknown {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function findLatestVibeMetadata(workspacePath: string): VibeMetadata | null {
  const sessionLogDir = getVibeSessionLogDir();
  if (!existsSync(sessionLogDir)) return null;

  const expectedWorkingDirectory = normalizePathForCompare(workspacePath);
  let latest: { metadata: VibeMetadata; mtimeMs: number } | null = null;

  for (const entry of readdirSync(sessionLogDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("session_")) continue;
    const metadataPath = join(sessionLogDir, entry.name, "meta.json");
    try {
      const parsed = readJsonFileBounded(metadataPath);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const metadata = parsed as VibeMetadata;
      if (typeof metadata.session_id !== "string") continue;
      const environment = metadata.environment;
      if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
        continue;
      }
      const workingDirectory = (environment as Record<string, unknown>)["working_directory"];
      if (typeof workingDirectory !== "string") continue;
      if (normalizePathForCompare(workingDirectory) !== expectedWorkingDirectory) continue;

      const mtimeMs = statSync(metadataPath).mtimeMs;
      if (!latest || mtimeMs > latest.mtimeMs) latest = { metadata, mtimeMs };
    } catch {
      continue;
    }
  }

  return latest?.metadata ?? null;
}

function getStoredMistralSessionId(session: Session): string | null {
  return session.metadata["mistralSessionId"] ?? session.agentInfo?.agentSessionId ?? null;
}

function matchesProcessName(output: string): boolean {
  return output
    .split("\n")
    .some(
      (line) =>
        /(^|[\s/])vibe([\s/]|$)/.test(line.trim()) || basename(line.trim()) === VIBE_EXECUTABLE,
    );
}

function isTmuxProcessRunning(handle: RuntimeHandle): boolean {
  try {
    const ttyOutput = execFileSync("tmux", ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"], {
      encoding: "utf-8",
      timeout: COMMAND_TIMEOUT_MS,
    });
    const ttys = ttyOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const tty of ttys) {
      const psTty = tty.startsWith("/dev/") ? tty.slice("/dev/".length) : tty;
      try {
        const psOutput = execFileSync("ps", ["-o", "command=", "-t", psTty], {
          encoding: "utf-8",
          timeout: COMMAND_TIMEOUT_MS,
        });
        if (matchesProcessName(psOutput)) return true;
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function classifyTerminalOutput(output: string): ActivityState {
  const trimmed = output.trim();
  if (!trimmed) return "idle";

  const lower = trimmed.toLowerCase();

  if (
    lower.includes("traceback (most recent call last)") ||
    lower.includes("session logging is disabled") ||
    lower.includes("failed to load session") ||
    lower.includes("failed to persist session") ||
    lower.includes("no previous sessions found") ||
    /\bsession ['"].*['"] not found\b/i.test(trimmed)
  ) {
    return "blocked";
  }

  if (
    lower.includes("enter your api key") ||
    lower.includes("trust the working directory") ||
    lower.includes("do you trust") ||
    lower.includes("awaiting approval") ||
    lower.includes("asking a question") ||
    lower.includes("approve") ||
    /\((y\/n|yes\/no)\)/i.test(trimmed) ||
    /\?\s*$/.test(trimmed)
  ) {
    return "waiting_input";
  }

  if (
    lower.includes("thinking") ||
    lower.includes("running") ||
    lower.includes("executing") ||
    lower.includes("working") ||
    lower.includes("analyzing") ||
    lower.includes("reading") ||
    lower.includes("writing") ||
    lower.includes("applying")
  ) {
    return "active";
  }

  if (/^>\s*$/m.test(trimmed) || lower.includes("start interacting with the agent")) {
    return "ready";
  }

  return "idle";
}

export function create(): MistralAgent {
  const agent: MistralAgent = {
    name: pluginName,
    processName: VIBE_EXECUTABLE,
    promptDelivery: "post-launch",

    getLaunchCommand(config: AgentLaunchConfig): string {
      return buildLaunchCommand(config);
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      return {
        PATH: buildAgentPath(process.env["PATH"]),
        AO_SESSION_ID: config.sessionId,
        AO_SESSION_NAME: config.sessionId,
        VIBE_ENABLE_AUTO_UPDATE: "false",
        VIBE_ENABLE_UPDATE_CHECKS: "false",
        VIBE_ENABLE_NOTIFICATIONS: "false",
        VIBE_DISABLE_WELCOME_BANNER_ANIMATION: "true",
        ...(config.model ? { VIBE_ACTIVE_MODEL: config.model } : {}),
        ...(process.env["GH_PATH"] ? { GH_PATH: process.env["GH_PATH"] } : {}),
      };
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyTerminalOutput(terminalOutput);
    },

    async recordActivity(session: Session, terminalOutput: string): Promise<void> {
      if (!session.workspacePath) return;
      await recordTerminalActivity(session.workspacePath, terminalOutput, classifyTerminalOutput);
    },

    async getActivityState(
      session: Session,
      readyThresholdMs = 300_000,
    ): Promise<ActivityDetection | null> {
      if (!session.runtimeHandle) return { state: "exited", timestamp: new Date() };
      if (!(await agent.isProcessRunning(session.runtimeHandle))) {
        return { state: "exited", timestamp: new Date() };
      }
      if (!session.workspacePath) return null;

      const lastActivity = await readLastActivityEntry(session.workspacePath);
      const activityLogState = checkActivityLogState(lastActivity);
      if (activityLogState) return activityLogState;

      return getActivityFallbackState(lastActivity, ACTIVE_WINDOW_MS, readyThresholdMs);
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      if (handle.runtimeName === "tmux") return isTmuxProcessRunning(handle);
      const pid = handle.data["pid"];
      return typeof pid === "number" && pid > 0 ? isPidRunning(pid) : false;
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;
      const metadata = findLatestVibeMetadata(session.workspacePath);
      if (!metadata || typeof metadata.session_id !== "string") return null;
      const summary =
        typeof metadata.title === "string" && metadata.title.length > 0 ? metadata.title : null;
      return {
        summary,
        agentSessionId: metadata.session_id,
        metadata: { mistralSessionId: metadata.session_id },
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      const mistralSessionId = getStoredMistralSessionId(session);
      if (!mistralSessionId) return null;
      const workspacePath = session.workspacePath ?? project.path;
      return [
        VIBE_EXECUTABLE,
        "--workdir",
        shellEscape(workspacePath),
        "--trust",
        "--resume",
        shellEscape(mistralSessionId),
      ].join(" ");
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupPathWrapperWorkspace(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;
      await setupPathWrapperWorkspace(session.workspacePath);
    },
  };

  return agent;
}

const plugin: PluginModule<Agent> = {
  manifest,
  create,
  detect,
};

export default plugin;
