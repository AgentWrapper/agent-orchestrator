import {
  DEFAULT_ACTIVE_WINDOW_MS,
  DEFAULT_READY_THRESHOLD_MS,
  PROCESS_PROBE_INDETERMINATE,
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
  type CostEstimate,
  type PluginModule,
  type ProcessProbeResult,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@aoagents/ao-core";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
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
const PI_EXECUTABLE = "pi";
const PI_SESSION_ID_METADATA_KEY = "piSessionId";
const PI_SESSION_DIR_METADATA_KEY = "piSessionDir";
const MAX_SESSION_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_HEAD_BYTES = 64 * 1024;
const MAX_SESSION_SCAN_DEPTH = 4;
const MAX_SESSION_SCAN_FILES = 200;
const PI_SESSION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const ANSI_ESCAPE_RE = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  "g",
);
const PI_WAITING_INPUT_RE =
  /(?:press any key to continue|delete session\?.*(?:confirm|cancel)|\bconfirm\b.*\bcancel\b)/i;
const PI_IDLE_PROMPT_RE = /(?:how can i help\?|share what you want to do in this repo)/i;
const PI_BLOCKED_RE =
  /(?:\berror\b|\bfailed\b|\bexception\b|not authenticated|api key|unknown option|cannot execute)/i;

type JsonObject = Record<string, unknown>;

interface PiSessionFileInfo {
  path: string;
  modifiedAt: Date;
  id: string;
  summary: string | null;
  cost?: CostEstimate;
}

function asValidPiSessionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return PI_SESSION_ID_RE.test(trimmed) ? trimmed : null;
}

function stringFromRecord(record: JsonObject, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getPiSessionDir(config: AgentLaunchConfig): string {
  return join(
    config.workspacePath ?? config.projectConfig.path,
    ".ao",
    "pi-sessions",
    config.sessionId,
  );
}

function getPiSessionDirForSession(session: Session): string | null {
  const fromMetadata = stringFromRecord(session.metadata ?? {}, PI_SESSION_DIR_METADATA_KEY);
  if (fromMetadata) return fromMetadata;
  if (!session.workspacePath) return null;
  return join(session.workspacePath, ".ao", "pi-sessions", session.id);
}

function getConfiguredPiSessionId(config: AgentLaunchConfig): string | null {
  return asValidPiSessionId(config.projectConfig.agentConfig?.[PI_SESSION_ID_METADATA_KEY]);
}

function getSessionPiSessionId(session: Session): string | null {
  return (
    asValidPiSessionId(session.metadata?.[PI_SESSION_ID_METADATA_KEY]) ??
    asValidPiSessionId(session.agentInfo?.agentSessionId)
  );
}

function buildPiCommand(
  sessionDir: string,
  sessionId?: string | null,
  systemPromptFile?: string,
): string {
  const parts = [PI_EXECUTABLE, "--session-dir", shellEscape(sessionDir)];
  if (systemPromptFile) {
    parts.push("--append-system-prompt", shellEscape(systemPromptFile));
  }
  if (sessionId) {
    parts.push("--session", shellEscape(sessionId));
  }
  return parts.join(" ");
}

function classifyPiTerminalOutput(terminalOutput: string): ActivityState {
  const normalizedOutput = terminalOutput.replaceAll(ANSI_ESCAPE_RE, "").trim();
  if (!normalizedOutput) return "idle";

  const lines = normalizedOutput.split("\n").map((line) => line.trim());
  const lastLine = lines[lines.length - 1] ?? "";
  const lastNonEmptyLine = [...lines].reverse().find(Boolean) ?? "";

  if (/^[>$#]\s*$/.test(lastLine)) return "idle";
  if (PI_IDLE_PROMPT_RE.test(normalizedOutput)) return "idle";
  if (PI_WAITING_INPUT_RE.test(lastNonEmptyLine) || PI_WAITING_INPUT_RE.test(normalizedOutput)) {
    return "waiting_input";
  }
  if (PI_BLOCKED_RE.test(lastLine) || PI_BLOCKED_RE.test(lastNonEmptyLine)) return "blocked";

  return "active";
}

function parseJsonLine(line: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const text = content
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as JsonObject;
      return record["type"] === "text" && typeof record["text"] === "string"
        ? record["text"]
        : null;
    })
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .trim();

  return text.length > 0 ? text : null;
}

function truncateSummary(summary: string): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function parseUsageCost(usage: unknown): CostEstimate | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as JsonObject;
  const input = record["input"];
  const output = record["output"];
  const cost = record["cost"];
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return undefined;
  const total = (cost as JsonObject)["total"];
  if (typeof total !== "number") return undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    estimatedCostUsd: total,
  };
}

async function readSessionFileBounded(filePath: string, size: number): Promise<string> {
  if (size <= MAX_SESSION_SCAN_BYTES) {
    return await readFile(filePath, "utf8");
  }

  const handle = await open(filePath, "r");
  try {
    const headSize = Math.min(MAX_SESSION_HEAD_BYTES, size);
    const tailSize = Math.min(MAX_SESSION_SCAN_BYTES, size);
    const head = Buffer.alloc(headSize);
    const tail = Buffer.alloc(tailSize);
    await handle.read(head, 0, headSize, 0);
    await handle.read(tail, 0, tailSize, Math.max(0, size - tailSize));
    return `${head.toString("utf8")}\n${tail.toString("utf8")}`;
  } finally {
    await handle.close();
  }
}

function parsePiSessionFile(
  filePath: string,
  modifiedAt: Date,
  text: string,
): PiSessionFileInfo | null {
  let id: string | null = null;
  let summary: string | null = null;
  let cost: CostEstimate | undefined;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const entry = parseJsonLine(line);
    if (!entry) continue;

    if (entry["type"] === "session") {
      id = asValidPiSessionId(entry["id"]) ?? id;
      continue;
    }

    if (!summary && entry["type"] === "message") {
      const message = entry["message"];
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const messageRecord = message as JsonObject;
        if (messageRecord["role"] === "user") {
          const textContent = extractTextContent(messageRecord["content"]);
          if (textContent) summary = truncateSummary(textContent);
        }
      }
    }

    if (entry["type"] === "message") {
      const message = entry["message"];
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const messageRecord = message as JsonObject;
        const parsedCost = parseUsageCost(messageRecord["usage"]);
        if (parsedCost) cost = parsedCost;
      }
    }
  }

  if (!id) return null;
  return { path: filePath, modifiedAt, id, summary, ...(cost ? { cost } : {}) };
}

async function findPiSessionCandidates(
  sessionDir: string,
): Promise<Array<{ path: string; modifiedAt: Date; size: number }>> {
  const candidates: Array<{ path: string; modifiedAt: Date; size: number }> = [];
  const pending: Array<{ dir: string; depth: number }> = [{ dir: sessionDir, depth: 0 }];

  while (pending.length > 0 && candidates.length < MAX_SESSION_SCAN_FILES) {
    const current = pending.shift();
    if (!current) break;

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MAX_SESSION_SCAN_DEPTH) {
          pending.push({ dir: entryPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (candidates.length >= MAX_SESSION_SCAN_FILES) break;

      try {
        const stats = await stat(entryPath);
        if (!stats.isFile()) continue;
        candidates.push({ path: entryPath, modifiedAt: stats.mtime, size: stats.size });
      } catch {
        // Ignore files that disappear while scanning.
      }
    }
  }

  return candidates;
}

async function findLatestPiSession(sessionDir: string): Promise<PiSessionFileInfo | null> {
  const candidates = await findPiSessionCandidates(sessionDir);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

  for (const candidate of candidates) {
    try {
      const text = await readSessionFileBounded(candidate.path, candidate.size);
      const parsed = parsePiSessionFile(candidate.path, candidate.modifiedAt, text);
      if (parsed) return parsed;
    } catch {
      // Try the next session file.
    }
  }

  return null;
}

export const manifest = {
  name: pluginName,
  slot: "agent" as const,
  description: packageJson.description,
  version: packageJson.version,
  displayName: "Pi",
};

function createPiAgent(): Agent {
  return {
    name: pluginName,
    processName: pluginName,
    promptDelivery: "post-launch",

    getLaunchCommand(config: AgentLaunchConfig): string {
      return buildPiCommand(
        getPiSessionDir(config),
        getConfiguredPiSessionId(config),
        config.systemPromptFile,
      );
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }
      env["PI_CODING_AGENT_SESSION_DIR"] = getPiSessionDir(config);
      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyPiTerminalOutput(terminalOutput);
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
        classifyPiTerminalOutput(output),
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
          const processRe =
            /(?:^|\/)pi(?:\s|$)|@earendil-works\/pi-coding-agent|pi-coding-agent|dist\/cli\.js/;
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
      const sessionDir = getPiSessionDirForSession(session);
      if (!sessionDir) return null;

      const latestSession = await findLatestPiSession(sessionDir);
      if (!latestSession) return null;

      return {
        agentSessionId: latestSession.id,
        summary: latestSession.summary,
        summaryIsFallback: latestSession.summary ? true : undefined,
        metadata: {
          [PI_SESSION_ID_METADATA_KEY]: latestSession.id,
          [PI_SESSION_DIR_METADATA_KEY]: sessionDir,
        },
        ...(latestSession.cost ? { cost: latestSession.cost } : {}),
      };
    },

    async getRestoreCommand(session: Session, _project: ProjectConfig): Promise<string | null> {
      const sessionDir = getPiSessionDirForSession(session);
      if (!sessionDir) return null;

      const sessionId =
        getSessionPiSessionId(session) ?? (await findLatestPiSession(sessionDir))?.id ?? null;
      if (!sessionId) return null;

      return buildPiCommand(sessionDir, sessionId);
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
  return createPiAgent();
}

export function detect(): boolean {
  try {
    return Boolean(which.sync(PI_EXECUTABLE));
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
