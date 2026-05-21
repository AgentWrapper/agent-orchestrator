import {
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  shellEscape,
  buildAgentPath,
  isWindows,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  recordTerminalActivity,
  setupPathWrapperWorkspace,
  PREFERRED_GH_PATH,
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
} from "@aoagents/ao-core";
import { execFile, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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
const GOOSE_COMMAND_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

interface GooseSessionExport {
  id?: unknown;
  name?: unknown;
  user_set_name?: unknown;
}

function readSystemPromptFile(systemPromptFile: string | undefined): string | null {
  if (!systemPromptFile) return null;
  try {
    const content = readFileSync(systemPromptFile, "utf8");
    return content.trim().length > 0 ? content : null;
  } catch {
    return null;
  }
}

function buildSystemPromptArg(config: AgentLaunchConfig): string {
  const fileSystemPrompt = readSystemPromptFile(config.systemPromptFile);
  const systemPrompt = fileSystemPrompt ?? config.systemPrompt;
  if (systemPrompt) return ` --system ${shellEscape(systemPrompt)}`;
  return "";
}

async function runGooseCommand(
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("goose", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows(),
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let bufferExceeded = false;
    const timeoutMs = options.timeout ?? GOOSE_COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (bufferExceeded) return;
      stdout += chunk;
      if (stdout.length + stderr.length > MAX_BUFFER_BYTES) {
        bufferExceeded = true;
        child.kill("SIGTERM");
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (bufferExceeded) return;
      stderr += chunk;
      if (stdout.length + stderr.length > MAX_BUFFER_BYTES) {
        bufferExceeded = true;
        child.kill("SIGTERM");
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      if (!timedOut && code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const commandLabel = `goose ${args.join(" ")}`;
      const detail = stderr.trim() || stdout.trim();
      if (bufferExceeded) {
        reject(new Error(`Output exceeded ${MAX_BUFFER_BYTES} bytes: ${commandLabel}`));
        return;
      }
      if (timedOut) {
        reject(new Error(`Command timed out: ${commandLabel}`));
        return;
      }

      reject(
        new Error(
          detail.length > 0
            ? `Command failed: ${commandLabel}\n${detail}`
            : `Command failed: ${commandLabel}${signal ? ` (${signal})` : ""}`,
        ),
      );
    });
  });
}

function parseGooseSessionExport(text: string): GooseSessionExport | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as GooseSessionExport;
  } catch {
    return null;
  }
}

async function fetchGooseSessionInfo(sessionName: string): Promise<GooseSessionExport | null> {
  try {
    const { stdout } = await runGooseCommand(
      ["session", "export", "--name", sessionName, "--format", "json"],
      { timeout: GOOSE_COMMAND_TIMEOUT_MS },
    );
    return parseGooseSessionExport(stdout);
  } catch {
    return null;
  }
}

const ANSI_ESCAPE_RE = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  "g",
);
const GOOSE_CONFIRMATION_PROMPT_RE =
  /\b(?:do you want to|confirm|proceed|continue|approve|allow)\b.*(?:\[[Yy]\/N\]|\[y\/[Nn]\]|[Yy]\/[Nn]|yes\/no)\s*:?$/i;

function classifyGooseTerminalOutput(terminalOutput: string): ActivityState {
  const normalizedOutput = terminalOutput
    .replaceAll(ANSI_ESCAPE_RE, "")
    .replaceAll("\r", "\n")
    .trim();
  if (!normalizedOutput) return "idle";

  const lines = normalizedOutput.split("\n").map((line) => line.trim());
  const lastLine = lines[lines.length - 1] ?? "";
  const lastNonEmptyLine = [...lines].reverse().find(Boolean) ?? "";

  if (/^(?:🪿|goose|[>$#])\s*$/.test(lastLine)) return "idle";
  if (/session closed\b/i.test(lastNonEmptyLine)) return "idle";
  if (GOOSE_CONFIRMATION_PROMPT_RE.test(lastNonEmptyLine)) return "waiting_input";
  if (/\b(?:error|failed|exception|panic)\b/i.test(lastLine)) return "blocked";

  return "active";
}

export const manifest = {
  name: pluginName,
  slot: "agent" as const,
  description: packageJson.description,
  version: packageJson.version,
  displayName: "Goose",
};

function createGooseAgent(): Agent {
  return {
    name: pluginName,
    processName: pluginName,

    getLaunchCommand(config: AgentLaunchConfig): string {
      const systemPromptArg = buildSystemPromptArg(config);
      const promptText = config.prompt ?? "";
      return `goose run --name ${shellEscape(config.sessionId)}${systemPromptArg} --text ${shellEscape(promptText)} --interactive`;
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

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyGooseTerminalOutput(terminalOutput);
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
        classifyGooseTerminalOutput(output),
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
          const processRe = /(?:^|\/)goose(?:\s|$)/;
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
      if (!session.id) return null;
      const sessionInfo = await fetchGooseSessionInfo(session.id);
      if (!sessionInfo) return null;

      const agentSessionId =
        typeof sessionInfo.id === "string" && sessionInfo.id ? sessionInfo.id : session.id;
      const exportedName = typeof sessionInfo.name === "string" ? sessionInfo.name.trim() : "";
      const hasGeneratedSummary = exportedName.length > 0 && exportedName !== session.id;

      return {
        agentSessionId,
        summary: hasGeneratedSummary ? exportedName : null,
        summaryIsFallback: hasGeneratedSummary ? false : undefined,
      };
    },

    async getRestoreCommand(session: Session, _project: ProjectConfig): Promise<string | null> {
      if (!session.id) return null;
      const sessionInfo = await fetchGooseSessionInfo(session.id);
      if (!sessionInfo) return null;
      return `goose run --resume --name ${shellEscape(session.id)} --text '' --interactive`;
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
  return createGooseAgent();
}

export function detect(): boolean {
  try {
    execFileSync("goose", ["--version"], {
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
