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
  normalizeAgentPermissionMode,
  isWindows,
  type Agent,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@aoagents/ao-core";
import { execFile } from "node:child_process";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
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
const DROID_SETTINGS_DIR = ".ao/droid";
const DROID_SETTINGS_FILE = "settings.json";
const DROID_SESSION_HOOK_FILE = "session-hook.cjs";
const DROID_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const ANSI_ESCAPE_RE = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  "g",
);

interface DroidAgentConfig {
  droidSessionId?: unknown;
}

function asValidDroidSessionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!DROID_SESSION_ID_RE.test(trimmed)) return null;
  return trimmed;
}

function getDroidSettingsPath(workspacePath: string): string {
  return join(workspacePath, DROID_SETTINGS_DIR, DROID_SETTINGS_FILE);
}

function getDroidSessionHookPath(workspacePath: string): string {
  return join(workspacePath, DROID_SETTINGS_DIR, DROID_SESSION_HOOK_FILE);
}

interface DroidCommandArg {
  value: string;
  raw?: boolean;
}

function flag(value: string): DroidCommandArg {
  return { value, raw: true };
}

function value(value: string): DroidCommandArg {
  return { value };
}

function buildDroidCommand(args: DroidCommandArg[]): string {
  return ["droid", ...args.map((arg) => (arg.raw ? arg.value : shellEscape(arg.value)))].join(" ");
}

function getDroidPermissionArgs(config: AgentLaunchConfig): DroidCommandArg[] {
  const mode = normalizeAgentPermissionMode(config.permissions);
  if (mode === "permissionless") return [flag("--skip-permissions-unsafe")];
  if (mode === "auto-edit") return [flag("--auto"), value("low")];
  return [];
}

function getDroidLaunchArgs(config: AgentLaunchConfig): DroidCommandArg[] {
  const args: DroidCommandArg[] = [];
  const workspacePath = config.workspacePath;
  if (workspacePath) {
    args.push(flag("--settings"), value(getDroidSettingsPath(workspacePath)));
  }

  const configuredSessionId = asValidDroidSessionId(
    (config.projectConfig.agentConfig as DroidAgentConfig | undefined)?.droidSessionId,
  );
  if (configuredSessionId) {
    args.push(flag("--resume"), value(configuredSessionId));
  }

  if (config.model) {
    args.push(flag("--model"), value(config.model));
  }

  args.push(...getDroidPermissionArgs(config));

  if (config.systemPromptFile) {
    args.push(flag("--append-system-prompt-file"), value(config.systemPromptFile));
  } else if (config.systemPrompt) {
    args.push(flag("--append-system-prompt"), value(config.systemPrompt));
  }

  return args;
}

function classifyDroidTerminalOutput(terminalOutput: string): ActivityState {
  const normalizedOutput = terminalOutput.replaceAll(ANSI_ESCAPE_RE, "").trim();
  if (!normalizedOutput) return "idle";

  const lines = normalizedOutput.split("\n").map((line) => line.trim());
  const lastLine = lines[lines.length - 1] ?? "";
  const lastNonEmptyLine = [...lines].reverse().find(Boolean) ?? "";

  if (/^[>$#]\s*$/.test(lastLine)) return "idle";
  if (/^[│|]?\s*>\s*(?:Try\s+"[^"]+")?\s*[│|]?\s*$/.test(lastNonEmptyLine)) return "idle";
  if (/task completed successfully|finished responding/i.test(lastNonEmptyLine)) return "ready";
  if (/droid needs your permission|droid is waiting for your input/i.test(normalizedOutput)) {
    return "waiting_input";
  }
  if (
    /\b(?:approve|allow|confirm|proceed|continue)\b.*\?\s*(?:\[[YyNn/]+\]|[Yy]\/[Nn]|[Nn]\/[Yy]|$)/i.test(
      lastNonEmptyLine,
    )
  ) {
    return "waiting_input";
  }
  if (
    /not authenticated|authentication failed|create an api key|error|failed|exception/i.test(
      lastLine,
    )
  ) {
    return "blocked";
  }

  return "active";
}

function buildSessionHookScript(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(input || "{}");
    const droidSessionId = typeof event.session_id === "string" ? event.session_id.trim() : "";
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(droidSessionId)) return;

    const aoDataDir = process.env.AO_DATA_DIR;
    const aoSession = process.env.AO_SESSION || process.env.AO_SESSION_ID;
    if (!aoDataDir || !aoSession || !/^[A-Za-z0-9._:-]{1,200}$/.test(aoSession)) return;

    const metadataPath = path.join(aoDataDir, aoSession + ".json");
    let metadata = {};
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) metadata = {};
    } catch {
      metadata = {};
    }

    metadata.droidSessionId = droidSessionId;
    if (typeof event.transcript_path === "string" && event.transcript_path.trim()) {
      metadata.droidTranscriptPath = event.transcript_path.trim();
    }

    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    const tmpPath = metadataPath + ".tmp-" + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(metadata, null, 2) + "\n");
    fs.renameSync(tmpPath, metadataPath);
  } catch {
    // Best effort: metadata capture must never affect Droid startup or prompts.
  }
});
`;
}

function buildDroidSettings(hookScriptPath: string): string {
  const command = `${shellEscape(process.execPath)} ${shellEscape(hookScriptPath)}`;
  return (
    JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command, timeout: 10 }] }],
          UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 10 }] }],
        },
      },
      null,
      2,
    ) + "\n"
  );
}

async function writeDroidWorkspaceFiles(workspacePath: string): Promise<void> {
  const settingsDir = join(workspacePath, DROID_SETTINGS_DIR);
  const hookScriptPath = getDroidSessionHookPath(workspacePath);
  await mkdir(settingsDir, { recursive: true });
  await writeFile(hookScriptPath, buildSessionHookScript(), "utf8");
  await chmod(hookScriptPath, 0o755);
  await writeFile(getDroidSettingsPath(workspacePath), buildDroidSettings(hookScriptPath), "utf8");
}

export const manifest = {
  name: pluginName,
  slot: "agent" as const,
  description: packageJson.description,
  version: packageJson.version,
  displayName: "Droid",
};

function createDroidAgent(): Agent {
  return {
    name: pluginName,
    processName: pluginName,
    promptDelivery: "post-launch",

    getLaunchCommand(config: AgentLaunchConfig): string {
      return buildDroidCommand(getDroidLaunchArgs(config));
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
      return classifyDroidTerminalOutput(terminalOutput);
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
        classifyDroidTerminalOutput(output),
      );
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id && !isWindows()) {
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
          const processRe = /(?:^|\/)droid(?:\s|$)/;
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

    async getSessionInfo(session: Session) {
      const droidSessionId = asValidDroidSessionId(session.metadata?.droidSessionId);
      if (!droidSessionId) return null;
      return {
        agentSessionId: droidSessionId,
        summary: null,
        metadata: {
          droidSessionId,
          ...(typeof session.metadata?.droidTranscriptPath === "string"
            ? { droidTranscriptPath: session.metadata.droidTranscriptPath }
            : {}),
        },
      };
    },

    async getRestoreCommand(session: Session, _project: ProjectConfig): Promise<string | null> {
      const droidSessionId = asValidDroidSessionId(session.metadata?.droidSessionId);
      if (!droidSessionId) return null;
      const args: DroidCommandArg[] = [];
      if (session.workspacePath) {
        args.push(flag("--settings"), value(getDroidSettingsPath(session.workspacePath)));
      }
      args.push(flag("--resume"), value(droidSessionId));
      return buildDroidCommand(args);
    },

    async preLaunchSetup(workspacePath: string): Promise<void> {
      await writeDroidWorkspaceFiles(workspacePath);
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupPathWrapperWorkspace(workspacePath);
      await writeDroidWorkspaceFiles(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;
      await setupPathWrapperWorkspace(session.workspacePath);
    },
  };
}

export function create(): Agent {
  return createDroidAgent();
}

export function detect(): boolean {
  try {
    return Boolean(which.sync("droid"));
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
