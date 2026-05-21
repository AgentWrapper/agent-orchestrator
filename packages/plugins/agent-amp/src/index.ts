import {
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  shellEscape,
  isWindows,
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
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
  type AgentSpecificConfig,
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

interface AmpAgentConfig extends AgentSpecificConfig {
  ampThreadId?: unknown;
}

interface AmpPromptPart {
  type: "text" | "file";
  value: string;
}

function asAmpThreadReference(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/\s/.test(trimmed)) return undefined;
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return trimmed;
}

const AMP_PROMPT_LAUNCHER_SCRIPT = [
  'const {spawn}=require("node:child_process");',
  'const fs=require("node:fs");',
  "const payload=JSON.parse(process.argv[1]);",
  "const promptParts=Array.isArray(payload.promptParts)?payload.promptParts:[];",
  "const input=promptParts.map((part)=>part.type==='file'?fs.readFileSync(part.value,'utf8'):String(part.value??'')).filter(Boolean).join('\\n\\n');",
  "const args=Array.isArray(payload.args)?payload.args:[];",
  "const child=spawn('amp',args,{stdio:['pipe','inherit','inherit'],shell:process.platform==='win32',windowsHide:true});",
  "child.on('error',(err)=>{console.error(err?.message||String(err));process.exit(1);});",
  "child.on('exit',(code)=>process.exit(code??0));",
  "child.stdin.end(input);",
].join("");

function buildAmpPromptParts(config: AgentLaunchConfig): AmpPromptPart[] {
  const promptParts: AmpPromptPart[] = [];
  if (config.systemPromptFile) {
    promptParts.push({ type: "file", value: config.systemPromptFile });
  } else if (config.systemPrompt) {
    promptParts.push({ type: "text", value: config.systemPrompt });
  }

  if (config.prompt) {
    promptParts.push({ type: "text", value: config.prompt });
  }

  return promptParts;
}

function buildAmpLaunchCommand(
  baseCommand: string,
  args: string[],
  config: AgentLaunchConfig,
): string {
  const promptParts = buildAmpPromptParts(config);
  if (promptParts.length === 0) {
    return baseCommand;
  }

  const payload = JSON.stringify({ args, promptParts });
  return `node -e ${shellEscape(AMP_PROMPT_LAUNCHER_SCRIPT)} ${shellEscape(payload)}`;
}

const ANSI_ESCAPE_RE = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  "g",
);
const AMP_WAITING_PROMPT_RE =
  /^(?:[?›>❯]\s*)?(?:do you want|would you like|allow|approve|proceed|continue|select|choose|confirm)\b.*(?:\?|:)\s*(?:\[[^\]]+\]|\([^)]*\)|[Yy]\/[Nn])?\s*$/i;
const AMP_BLOCKED_RE =
  /\b(error|failed|exception|not logged in|login required|authentication required|api key missing)\b/i;

function classifyAmpTerminalOutput(terminalOutput: string): ActivityState {
  const normalizedOutput = terminalOutput.replaceAll(ANSI_ESCAPE_RE, "").trim();
  if (!normalizedOutput) return "idle";

  const lines = normalizedOutput.split("\n").map((line) => line.trim());
  const lastLine = lines[lines.length - 1] ?? "";
  const lastNonEmptyLine = [...lines].reverse().find(Boolean) ?? "";

  if (/^(?:[│┃┆┊]\s*)?[>$#]\s*$/.test(lastLine)) return "idle";
  if (AMP_WAITING_PROMPT_RE.test(lastNonEmptyLine)) return "waiting_input";
  if (AMP_BLOCKED_RE.test(lastLine)) return "blocked";

  return "active";
}

export const manifest = {
  name: pluginName,
  slot: "agent" as const,
  description: packageJson.description,
  version: packageJson.version,
  displayName: "Amp",
};

function createAmpAgent(): Agent {
  return {
    name: pluginName,
    processName: pluginName,

    getLaunchCommand(config: AgentLaunchConfig): string {
      const threadId = asAmpThreadReference(
        (config.projectConfig.agentConfig as AmpAgentConfig | undefined)?.ampThreadId,
      );
      if (!threadId) {
        return buildAmpLaunchCommand("amp", [], config);
      }
      return buildAmpLaunchCommand(
        `amp threads continue ${shellEscape(threadId)}`,
        ["threads", "continue", threadId],
        config,
      );
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      env["NO_ANIMATION"] = "1";

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyAmpTerminalOutput(terminalOutput);
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
        classifyAmpTerminalOutput(output),
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
          const processRe = /(?:^|\/)amp(?:\s|$)/;
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
      const threadId = asAmpThreadReference(session.metadata?.ampThreadId);
      if (!threadId) return null;
      return {
        agentSessionId: threadId,
        summary: null,
      };
    },

    async getRestoreCommand(session: Session, _project: ProjectConfig): Promise<string | null> {
      const threadId = asAmpThreadReference(session.metadata?.ampThreadId);
      if (!threadId) return null;
      return `amp threads continue ${shellEscape(threadId)}`;
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
  return createAmpAgent();
}

export function detect(): boolean {
  try {
    return Boolean(which.sync("amp"));
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
