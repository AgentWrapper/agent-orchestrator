import {
  readLastJsonlEntry,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  isWindows,
  PROCESS_PROBE_INDETERMINATE,
  DEFAULT_READY_THRESHOLD_MS,
  DEFAULT_ACTIVE_WINDOW_MS,
  type ActivityDetection,
  type ActivityState,
  type ProcessProbeResult,
  type RuntimeHandle,
  type Session,
} from "@aoagents/ao-core";
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Project-path slug
// =============================================================================

/**
 * Convert a workspace path to Claude's project directory path.
 * Claude stores sessions at ~/.claude/projects/{encoded-path}/
 *
 * Verified against Claude Code's actual on-disk slugs: every non-alphanumeric
 * character (other than `-`) is replaced with `-`. That includes `/`, `.`,
 * `:`, and crucially `_` — AO's per-project data dirs are named like
 * `<sanitized>_<hash>`, and without underscore folding the slug AO computes
 * misses the directory Claude actually wrote (issue #1611).
 *
 * Windows: `C:\Users\dev\project` → `C--Users-dev-project` — Claude leaves the
 * colon-position as a dash rather than stripping it. Verified via on-disk QA
 * during the Windows port (commit 582c5373). Stripping the colon (as #1611
 * inadvertently did) breaks JSONL lookup on Windows.
 */
export function toClaudeProjectPath(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  return normalized.replace(/[^a-zA-Z0-9-]/g, "-");
}

// =============================================================================
// Session file discovery
// =============================================================================

/** Find the most recently modified .jsonl session file in a directory */
export async function findLatestSessionFile(projectDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }

  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));
  if (jsonlFiles.length === 0) return null;

  const withStats = await Promise.all(
    jsonlFiles.map(async (f) => {
      const fullPath = join(projectDir, f);
      try {
        const s = await stat(fullPath);
        return { path: fullPath, mtime: s.mtimeMs };
      } catch {
        return { path: fullPath, mtime: 0 };
      }
    }),
  );
  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats[0]?.path ?? null;
}

// =============================================================================
// Process detection
// =============================================================================

/**
 * TTL cache for `ps -eo pid,tty,args` output. Without this, listing N sessions
 * would spawn N concurrent `ps` processes, each taking 30+ seconds on machines
 * with many processes. The cache ensures `ps` is called at most once per TTL
 * window regardless of how many sessions are being enriched.
 */
type ProcessListResult = string | typeof PROCESS_PROBE_INDETERMINATE;
let psCache: {
  output: ProcessListResult;
  timestamp: number;
  promise?: Promise<ProcessListResult>;
} | null = null;
const PS_CACHE_TTL_MS = 5_000;

/** Reset the ps cache. Exported for testing only. */
export function resetPsCache(): void {
  psCache = null;
}

async function getCachedProcessList(): Promise<ProcessListResult> {
  // ps -eo is a Unix-only command; on Windows the tmux branch is never taken
  // in normal operation, but guard here to avoid a spurious spawn error if
  // a stale tmux handle is encountered.
  if (isWindows()) return "";
  const now = Date.now();
  if (psCache && now - psCache.timestamp < PS_CACHE_TTL_MS) {
    if (psCache.promise) return psCache.promise;
    return psCache.output;
  }

  const promise = execFileAsync("ps", ["-eo", "pid,tty,args"], {
    timeout: 30_000,
  })
    .then(({ stdout }) => {
      if (psCache?.promise === promise) {
        psCache = { output: stdout || PROCESS_PROBE_INDETERMINATE, timestamp: Date.now() };
      }
      return stdout || PROCESS_PROBE_INDETERMINATE;
    })
    .catch(() => {
      if (psCache?.promise === promise) {
        psCache = { output: PROCESS_PROBE_INDETERMINATE, timestamp: Date.now() };
      }
      return PROCESS_PROBE_INDETERMINATE;
    });

  psCache = { output: "", timestamp: now, promise };

  return promise;
}

/**
 * Check if a process named "claude" is running in the given runtime handle's context.
 * Uses ps to find processes by TTY (for tmux) or by PID.
 */
export async function findClaudeProcess(
  handle: RuntimeHandle,
): Promise<number | null | typeof PROCESS_PROBE_INDETERMINATE> {
  try {
    if (handle.runtimeName === "tmux" && handle.id) {
      if (isWindows()) return null;
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
      if (ttys.length === 0) return null;

      const psOut = await getCachedProcessList();
      if (psOut === PROCESS_PROBE_INDETERMINATE) return PROCESS_PROBE_INDETERMINATE;

      const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
      // Match "claude" as a word boundary — prevents false positives on
      // names like "claude-code" or paths that merely contain the substring.
      const processRe = /(?:^|\/)claude(?:\s|$)/;
      for (const line of psOut.split("\n")) {
        const cols = line.trimStart().split(/\s+/);
        if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
        const args = cols.slice(2).join(" ");
        if (processRe.test(args)) {
          return parseInt(cols[0] ?? "0", 10);
        }
      }
      return null;
    }

    // For process runtime, check if the PID stored in handle data is alive
    const rawPid = handle.data["pid"];
    const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return pid;
      } catch (err: unknown) {
        // EPERM means the process exists but we lack permission to signal it
        if (err instanceof Error && "code" in err && err.code === "EPERM") {
          return pid;
        }
        return null;
      }
    }

    return null;
  } catch {
    return PROCESS_PROBE_INDETERMINATE;
  }
}

export async function isClaudeProcessAlive(handle: RuntimeHandle): Promise<ProcessProbeResult> {
  const pid = await findClaudeProcess(handle);
  if (pid === PROCESS_PROBE_INDETERMINATE) return PROCESS_PROBE_INDETERMINATE;
  return pid !== null;
}

// =============================================================================
// Terminal output classification
// =============================================================================

/** Classify Claude Code's activity state from terminal output (pure, sync). */
export function classifyTerminalOutput(terminalOutput: string): ActivityState {
  if (!terminalOutput.trim()) return "idle";

  const lines = terminalOutput.trim().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";

  // Check the last line FIRST — if the prompt is visible, the agent is idle
  // regardless of historical output (e.g. "Reading file..." from earlier).
  // The ❯ is Claude Code's prompt character.
  if (/^[❯>$#]\s*$/.test(lastLine)) return "idle";

  // Check the bottom of the buffer for permission prompts BEFORE checking
  // full-buffer active indicators. Historical "Thinking"/"Reading" text in
  // the buffer must not override a current permission prompt at the bottom.
  const tail = lines.slice(-5).join("\n");
  if (/Do you want to proceed\?/i.test(tail)) return "waiting_input";
  if (/\(Y\)es.*\(N\)o/i.test(tail)) return "waiting_input";
  if (/bypass.*permissions/i.test(tail)) return "waiting_input";

  return "active";
}

// =============================================================================
// Activity-state cascade
// =============================================================================

/**
 * Determine current activity state for a Claude Code session.
 *
 * Cascade:
 *  1. Process check (returns null on INDETERMINATE, exited on dead)
 *  2. Native JSONL: read last entry, map type+mtime → state
 *  3. AO activity JSONL: `checkActivityLogState` for actionable states
 *     (waiting_input/blocked) terminal regex picked up
 *  4. AO activity JSONL: `getActivityFallbackState` for age-decayed fallback
 *  5. Stale native (entry predates session) returned only if nothing else
 *
 * Note: Claude does NOT emit `permission_request` or top-level `error`
 * as JSONL types. `waiting_input` flows through the terminal regex →
 * AO activity JSONL path. `blocked` is detected from native JSONL via
 * `{type:"system", level:"error"}` (Claude's api_error shape).
 */
export async function getClaudeActivityState(
  session: Session,
  readyThresholdMs: number | undefined,
  isProcessAlive: (handle: RuntimeHandle) => Promise<ProcessProbeResult> = isClaudeProcessAlive,
): Promise<ActivityDetection | null> {
  const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

  const exitedAt = new Date();
  if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
  const running = await isProcessAlive(session.runtimeHandle);
  if (running === PROCESS_PROBE_INDETERMINATE) return null;
  if (!running) return { state: "exited", timestamp: exitedAt };

  if (!session.workspacePath) return null;

  const projectPath = toClaudeProjectPath(session.workspacePath);
  const projectDir = join(homedir(), ".claude", "projects", projectPath);

  const sessionFile = await findLatestSessionFile(projectDir);
  let staleNativeState: ActivityDetection | null = null;
  if (sessionFile) {
    const entry = await readLastJsonlEntry(sessionFile);
    if (entry) {
      // If the JSONL entry predates this session, it's from a previous session
      // in the same worktree. Fall through to the AO safety net first: the
      // terminal may have already surfaced waiting_input/blocked before
      // Claude writes this session's first native JSONL entry.
      if (session.createdAt && entry.modifiedAt < session.createdAt) {
        staleNativeState = { state: "idle", timestamp: session.createdAt };
      } else {
        const ageMs = Date.now() - entry.modifiedAt.getTime();
        const timestamp = entry.modifiedAt;

        const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);
        switch (entry.lastType) {
          case "user":
          case "tool_use":
          case "progress":
            if (ageMs <= activeWindowMs) return { state: "active", timestamp };
            return { state: ageMs > threshold ? "idle" : "ready", timestamp };

          case "system":
            // Claude writes API errors as `{type:"system", subtype:"api_error",
            // level:"error", cause:{...}}`. Require BOTH the subtype AND the
            // level so a future error-level diagnostic that isn't actually
            // fatal doesn't get silently classified as blocked. Other system
            // subtypes (compact_boundary, local_command, turn_duration, etc.)
            // are normal turn-end markers.
            if (entry.lastSubtype === "api_error" && entry.lastLevel === "error") {
              return { state: "blocked", timestamp };
            }
            return { state: ageMs > threshold ? "idle" : "ready", timestamp };

          case "assistant":
          case "summary":
          case "result":
            return { state: ageMs > threshold ? "idle" : "ready", timestamp };

          default:
            if (ageMs <= activeWindowMs) return { state: "active", timestamp };
            return { state: ageMs > threshold ? "idle" : "ready", timestamp };
        }
      }
    }
    // Session file exists but no parseable entry — fall through to AO JSONL
    // checks below instead of returning early, so terminal-derived
    // waiting_input/blocked can still be detected.
  }

  // Fallback: check AO activity JSONL (terminal-derived) for
  // waiting_input/blocked when Claude's native JSONL is unavailable.
  const activityResult = await readLastActivityEntry(session.workspacePath);
  const activityState = checkActivityLogState(activityResult);
  if (activityState) return activityState;

  // Last fallback: use the AO entry with age-based decay when native
  // session lookup is missing or unparseable (e.g. Claude project slug drift).
  const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);
  const fallback = getActivityFallbackState(activityResult, activeWindowMs, threshold);
  if (fallback) return fallback;

  if (staleNativeState) return staleNativeState;

  return null;
}
