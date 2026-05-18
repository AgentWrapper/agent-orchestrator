import {
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  shellEscape,
  readLastJsonlEntry,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  recordTerminalActivity,
  type Agent,
  type AgentLaunchConfig,
  type AgentSessionInfo,
  type ActivityState,
  type ActivityDetection,
  type CostEstimate,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@aoagents/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "pi",
  slot: "agent" as const,
  description: "Agent plugin: pi.dev coding agent",
  version: "0.1.0",
  displayName: "Pi",
};

// =============================================================================
// Pi Session JSONL Parsing
//
// Pi stores sessions at:
//   ~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
//
// Encoding: forward slashes in the workspace path are replaced with hyphens.
// Per the docs, the directory name appears as `--<path>--` — interpreted here
// as: encoded path with `/` -> `-`, but real-world encodings vary, so we
// fall back to scanning all session subdirs and matching the JSONL header.
// =============================================================================

const PI_SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

interface PiUsageCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

interface PiUsage {
  cost?: PiUsageCost;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface PiJsonlLine {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  role?: string;
  cwd?: string;
  workspacePath?: string;
  model?: string;
  thinkingLevel?: string;
  usage?: PiUsage;
  errorMessage?: string;
  stopReason?: string;
  content?: unknown;
}

/** Encode a workspace path to pi's session-dir naming convention. */
function encodeWorkspaceDirName(workspacePath: string): string {
  // /Users/foo/bar -> -Users-foo-bar
  return workspacePath.replace(/\//g, "-");
}

async function listSessionSubdirs(): Promise<string[]> {
  try {
    const entries = await readdir(PI_SESSIONS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

async function readFirstJsonlLine(filePath: string): Promise<PiJsonlLine | null> {
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        rl.close();
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed as PiJsonlLine;
        }
      } catch {
        // Skip malformed line, return null after first attempt
      }
      rl.close();
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Find the most recent pi session JSONL file for the given workspace.
 *
 * Strategy:
 * 1. Compute the expected encoded subdir name and look there directly.
 * 2. Fall back to scanning all session subdirs and parsing each JSONL header
 *    looking for one whose `cwd`/`workspacePath` matches.
 *
 * Returns the path of the most recently modified matching file, or null.
 */
async function findPiSessionFile(workspacePath: string): Promise<string | null> {
  const candidates: string[] = [];

  // Strategy 1: direct lookup by encoded name
  const encoded = encodeWorkspaceDirName(workspacePath);
  const directDir = join(PI_SESSIONS_DIR, encoded);
  const directFiles = await listJsonlFiles(directDir);
  candidates.push(...directFiles);

  // Strategy 2: scan all subdirs, match via header cwd
  if (candidates.length === 0) {
    const subdirs = await listSessionSubdirs();
    for (const sub of subdirs) {
      const dir = join(PI_SESSIONS_DIR, sub);
      const files = await listJsonlFiles(dir);
      for (const f of files) {
        const header = await readFirstJsonlLine(f);
        if (!header) continue;
        if (header.cwd === workspacePath || header.workspacePath === workspacePath) {
          candidates.push(f);
          break;
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  let best: { path: string; mtime: number } | null = null;
  for (const p of candidates) {
    try {
      const s = await stat(p);
      if (!best || s.mtimeMs > best.mtime) {
        best = { path: p, mtime: s.mtimeMs };
      }
    } catch {
      // skip
    }
  }
  return best?.path ?? null;
}

interface PiSessionData {
  sessionId: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
}

/** Stream the pi JSONL session file and aggregate session-level data. */
async function streamPiSessionData(filePath: string): Promise<PiSessionData | null> {
  try {
    const data: PiSessionData = {
      sessionId: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCost: 0,
    };
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: PiJsonlLine;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
        entry = parsed as PiJsonlLine;
      } catch {
        continue;
      }

      if (!data.sessionId && typeof entry.id === "string" && (!entry.type || entry.type === "session")) {
        // Header line: only top-level entry without parentId carries the session id.
        if (entry.parentId === null || entry.parentId === undefined) {
          data.sessionId = entry.id;
        }
      }

      if (typeof entry.model === "string" && entry.model) {
        data.model = entry.model;
      }

      const usage = entry.usage;
      if (usage) {
        if (typeof usage.cost?.total === "number") data.totalCost += usage.cost.total;
        if (typeof usage.inputTokens === "number") data.inputTokens += usage.inputTokens;
        if (typeof usage.outputTokens === "number") data.outputTokens += usage.outputTokens;
        if (typeof usage.cacheReadTokens === "number") data.cacheReadTokens += usage.cacheReadTokens;
        if (typeof usage.cacheWriteTokens === "number")
          data.cacheWriteTokens += usage.cacheWriteTokens;
      }
    }

    return data;
  } catch {
    return null;
  }
}

// =============================================================================
// Binary Resolution
// =============================================================================

export async function resolvePiBinary(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("which", ["pi"], { timeout: 10_000 });
    const resolved = stdout.trim();
    if (resolved) return resolved;
  } catch {
    // not found via which
  }

  const home = homedir();
  const candidates = [
    "/usr/local/bin/pi",
    "/opt/homebrew/bin/pi",
    join(home, ".npm", "bin", "pi"),
    join(home, ".npm-global", "bin", "pi"),
  ];
  for (const c of candidates) {
    try {
      await stat(c);
      return c;
    } catch {
      // skip
    }
  }
  return "pi";
}

// =============================================================================
// Session-file cache (avoids redundant scans inside one refresh cycle)
// =============================================================================

const SESSION_FILE_CACHE_TTL_MS = 30_000;
const sessionFileCache = new Map<string, { path: string | null; expiry: number }>();

async function findPiSessionFileCached(workspacePath: string): Promise<string | null> {
  const cached = sessionFileCache.get(workspacePath);
  if (cached && Date.now() < cached.expiry) return cached.path;
  const result = await findPiSessionFile(workspacePath);
  sessionFileCache.set(workspacePath, {
    path: result,
    expiry: Date.now() + SESSION_FILE_CACHE_TTL_MS,
  });
  return result;
}

// =============================================================================
// Agent Implementation
// =============================================================================

function createPiAgent(): Agent {
  let resolvedBinary: string | null = null;
  let resolvingBinary: Promise<string> | null = null;

  return {
    name: "pi",
    processName: "pi",

    // Pi exits immediately when invoked with `-p`; keep agent interactive in
    // tmux and inject the prompt via runtime.sendMessage after launch.
    promptDelivery: "post-launch",

    getLaunchCommand(_config: AgentLaunchConfig): string {
      const binary = resolvedBinary ?? "pi";
      // Pi has no documented flags for permissions / model overrides — both
      // are managed inside pi via /login and slash commands. Keep it simple
      // and let the user configure pi the usual way.
      return shellEscape(binary);
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) env["AO_ISSUE_ID"] = config.issueId;
      // PATH and GH_PATH are injected by session-manager.
      // ANTHROPIC_API_KEY is expected to be set in the user's shell — pi
      // reads it natively. We don't override it here.
      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput.trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";
      const tail = lines.slice(-6).join("\n");

      // Pi's interactive prompt: typically "> " when waiting for user input.
      if (/^[>$#]\s*$/.test(lastLine)) return "idle";

      // Permission/approval prompts (best-effort patterns — verify with real
      // pi output and tighten as needed).
      if (/\(y\)es.*\(n\)o/i.test(tail)) return "waiting_input";
      if (/approval required/i.test(tail)) return "waiting_input";
      if (/Allow .+\?/i.test(tail)) return "waiting_input";
      if (/Do you want to proceed\?/i.test(tail)) return "waiting_input";

      // Errors
      if (/^error:/im.test(tail)) return "blocked";
      if (/authentication failed/i.test(tail)) return "blocked";

      return "active";
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;
      const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);

      // 1. Process check
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      if (!session.workspacePath) return null;

      // 2. AO activity JSONL — only source of waiting_input/blocked since pi's
      //    native JSONL has no dedicated permission_request type.
      const activityResult = await readLastActivityEntry(session.workspacePath);
      const activityState = checkActivityLogState(activityResult);
      if (activityState) return activityState;

      // 3. Native pi JSONL — use timestamp of last entry for active/ready/idle.
      const sessionFile = await findPiSessionFileCached(session.workspacePath);
      if (sessionFile) {
        const entry = await readLastJsonlEntry(sessionFile);
        if (entry) {
          const ageMs = Date.now() - entry.modifiedAt.getTime();
          const timestamp = entry.modifiedAt;
          if (ageMs <= activeWindowMs) return { state: "active", timestamp };
          if (ageMs <= threshold) return { state: "ready", timestamp };
          return { state: "idle", timestamp };
        }

        // Fallback to file mtime if line parsing failed.
        try {
          const s = await stat(sessionFile);
          const ageMs = Date.now() - s.mtimeMs;
          if (ageMs <= activeWindowMs) return { state: "active", timestamp: s.mtime };
          if (ageMs <= threshold) return { state: "ready", timestamp: s.mtime };
          return { state: "idle", timestamp: s.mtime };
        } catch {
          // continue to fallback
        }
      }

      // 4. Last-resort: AO activity entry with age-based decay
      const fallback = getActivityFallbackState(activityResult, activeWindowMs, threshold);
      if (fallback) return fallback;

      return null;
    },

    async recordActivity(session: Session, terminalOutput: string): Promise<void> {
      if (!session.workspacePath) return;
      await recordTerminalActivity(session.workspacePath, terminalOutput, (output) =>
        this.detectActivity(output),
      );
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
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
          // Match `pi` or `.pi` (some npm globals install with dot prefix),
          // possibly via node wrapper (e.g. "node /path/to/pi").
          const processRe = /(?:^|\/)\.?pi(?:\s|$)/;
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (processRe.test(args)) return true;
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
            if (err instanceof Error && "code" in err && err.code === "EPERM") return true;
            return false;
          }
        }
        return false;
      } catch {
        return false;
      }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;
      const sessionFile = await findPiSessionFileCached(session.workspacePath);
      if (!sessionFile) return null;

      const data = await streamPiSessionData(sessionFile);
      if (!data) return null;

      const agentSessionId = data.sessionId ?? basename(sessionFile, ".jsonl");

      let cost: CostEstimate | undefined;
      const totalInputTokens = data.inputTokens + data.cacheReadTokens + data.cacheWriteTokens;
      if (data.totalCost > 0 || totalInputTokens > 0 || data.outputTokens > 0) {
        cost = {
          inputTokens: totalInputTokens,
          outputTokens: data.outputTokens,
          // Pi reports cost.total directly — prefer it over our own estimate.
          estimatedCostUsd: data.totalCost,
        };
      }

      return {
        summary: data.model ? `Pi session (${data.model})` : null,
        summaryIsFallback: true,
        agentSessionId,
        metadata: {
          ...(data.sessionId ? { piSessionId: data.sessionId } : {}),
          ...(data.model ? { piModel: data.model } : {}),
        },
        cost,
      };
    },

    async getRestoreCommand(session: Session, _project: ProjectConfig): Promise<string | null> {
      let sessionId = session.metadata?.["piSessionId"]?.trim();
      if (!sessionId) {
        if (!session.workspacePath) return null;
        const sessionFile = await findPiSessionFileCached(session.workspacePath);
        if (!sessionFile) return null;
        const data = await streamPiSessionData(sessionFile);
        if (!data?.sessionId) return null;
        sessionId = data.sessionId;
      }

      const binary = resolvedBinary ?? "pi";
      // pi --session <id> resumes a specific session.
      return `${shellEscape(binary)} --session ${shellEscape(sessionId)}`;
    },

    async setupWorkspaceHooks(
      _workspacePath: string,
      _config: WorkspaceHooksConfig,
    ): Promise<void> {
      // PATH wrappers (~/.ao/bin) are installed by session-manager for all
      // agents. Pi reads project AGENTS.md natively, but .ao/AGENTS.md lives
      // under .ao/ which pi does not auto-discover — that's acceptable for v1.
    },

    async postLaunchSetup(_session: Session): Promise<void> {
      if (!resolvedBinary) {
        if (!resolvingBinary) resolvingBinary = resolvePiBinary();
        try {
          resolvedBinary = await resolvingBinary;
        } finally {
          resolvingBinary = null;
        }
      }
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createPiAgent();
}

export function detect(): boolean {
  try {
    execFileSync("pi", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** @internal Reset the session-file cache. Exported for tests only. */
export function _resetSessionFileCache(): void {
  sessionFileCache.clear();
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
