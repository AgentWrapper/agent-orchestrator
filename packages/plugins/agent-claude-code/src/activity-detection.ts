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
import { readdir, realpath, stat } from "node:fs/promises";
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

/**
 * Resolve a workspace path through any symlinks BEFORE slugifying so AO's
 * computed Claude project dir matches what Claude itself writes.
 *
 * Without this, if AO records `workspacePath` as a symlink (e.g.
 * `/Users/me/symlinks/repo`) and Claude resolves it to the target
 * (`/Users/me/code/repo`) before computing its on-disk slug, the two slugs
 * diverge — AO looks in an empty `~/.claude/projects/<wrong-slug>/` dir
 * forever and the session looks permanently `idle`. Falls back to the
 * literal path on error (dangling symlink, race, etc.).
 */
export async function resolveWorkspaceForClaude(workspacePath: string): Promise<string> {
  try {
    return await realpath(workspacePath);
  } catch {
    return workspacePath;
  }
}

// =============================================================================
// Session file discovery
// =============================================================================

/** Module-level dedupe so EACCES/EPERM on a project dir warns ONCE per path
 *  for the process lifetime, not on every poll cycle. getClaudeActivityState
 *  is called every few seconds per session — without this, a single denied
 *  path would flood logs at 60+ lines/minute indefinitely. Bounded by the
 *  number of unique workspace slugs, which is small. */
const warnedReaddirPaths = new Set<string>();

/** Reset the warned-paths dedupe set. Exported for testing only. */
export function resetWarnedReaddirPaths(): void {
  warnedReaddirPaths.clear();
}

/** Find Claude's JSONL session file for a project directory.
 *
 *  When `preferredUuid` is provided (e.g. from `session.metadata.claudeSessionUuid`
 *  captured by getSessionInfo), prefer `<projectDir>/<preferredUuid>.jsonl`
 *  if it exists. This disambiguates the common case of multiple Claude
 *  sessions running in the same workspace, where newest-mtime would pick
 *  the WRONG session's JSONL whenever its sibling has just written.
 *
 *  Falls back to newest-mtime when no UUID is given or the named file
 *  doesn't exist yet (e.g. fresh session that hasn't been introspected).
 *
 *  ENOENT on the project dir is normal and silent. Other errors
 *  (EACCES, EPERM, EMFILE, ...) are logged via console.warn — once per
 *  path for the process lifetime — so a permission-denied or fd-exhausted
 *  misconfig doesn't silently mask the session as `idle` forever and
 *  doesn't flood logs on every poll. */
export async function findLatestSessionFile(
  projectDir: string,
  preferredUuid?: string,
): Promise<string | null> {
  // Prefer the UUID-named file when we know it — disambiguates multi-session.
  if (preferredUuid) {
    const preferred = join(projectDir, `${preferredUuid}.jsonl`);
    try {
      await stat(preferred);
      return preferred;
    } catch {
      // Fall through to newest-mtime — the UUID-named file may not exist
      // yet (session just spawned, hasn't been introspected).
    }
  }

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code !== "ENOENT") {
      if (!warnedReaddirPaths.has(projectDir)) {
        warnedReaddirPaths.add(projectDir);
        const code = (err as NodeJS.ErrnoException).code;
        console.warn(
          `[claude-code] failed to read ${projectDir} (${code}): ${err.message}. Session activity will fall back to AO JSONL only. (This warning is shown once per path for the process lifetime.)`,
        );
      }
    }
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
      // Match "claude" plus common variants:
      //   - bare `claude` / `/usr/local/bin/claude`
      //   - dot-prefix shim `.claude`
      //   - file extensions like `claude.exe`, `claude.js`, `claude.cjs`
      //   - hyphenated names like `claude-code`
      //   - node-shim cases like `node /path/@anthropic-ai/claude-code/cli.js`
      //     (matches the path component containing "claude")
      // Still anchored at `/` or start-of-line so `claudia` etc. don't match.
      const processRe = /(?:^|\/)(?:\.)?claude(?:[-.][\w-]+)*(?:[\s/]|$)/;
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

  // Empty prompt on the last line is unambiguously idle.
  if (/^[❯>$#]\s*$/.test(lastLine)) return "idle";

  // Use a wider window (last 12 lines) than the bottom-of-buffer prompt
  // check above because Claude's spinner+status line, ⎿ tool-result lines,
  // and api-error text often sit 6-8 lines above the input area + footer.
  // All multi-line state checks (blocked, active) use this window — full
  // `terminalOutput` would let scrolled-off error text falsely return
  // "blocked" forever after a successful retry pushes the error out of
  // view but not out of scrollback.
  const wideTail = lines.slice(-12).join("\n");

  // Check for blocked. Claude's persistent UI footer contains
  // "bypass permissions on (shift+tab to cycle)" on every session — the
  // tightened waiting_input regex no longer matches it, and the blocked
  // patterns below are specific to api-error retry text.
  //
  // Patterns observed empirically by capturing tmux output during a real
  // api-blocked retry loop (see PR #1932 description):
  //   ⎿  Unable to connect to API (ConnectionRefused)
  //      Retrying in 19s · attempt 7/10
  if (/Unable to connect to API/i.test(wideTail)) return "blocked";
  if (/Retrying in \d+s.*attempt \d+\/\d+/i.test(wideTail)) return "blocked";

  // Check the bottom of the buffer for permission prompts. Historical
  // "Thinking"/"Reading" text earlier in the buffer must not override a
  // current permission prompt at the bottom.
  const tail = lines.slice(-5).join("\n");
  if (/Do you want to proceed\?/i.test(tail)) return "waiting_input";
  if (/\(Y\)es.*\(N\)o/i.test(tail)) return "waiting_input";
  // Match the ACTUAL permission-bypass prompt, NOT the static footer toggle.
  if (/bypass\s+all\s+future\s+permissions/i.test(tail)) return "waiting_input";

  // Active: only when an explicit active-work indicator is present. Default
  // is IDLE — Claude's tmux pane has a persistent input area + footer that
  // looks identical between "just finished" and "working". Treating
  // unrecognized output as active caused dormant sessions (ao-160 etc.) to
  // get an "active" written to AO activity-JSONL every poll cycle, which the
  // age-decayed fallback then surfaced as ready forever.

  // Strongest active signal: gerund (present-participle) status verb
  // followed by the trailing ellipsis "…". Claude cycles through many
  // status words (Germinating, Fluttering, Pondering, Mulling, Crafting,
  // Thinking, Reasoning, ...) and many spinner glyphs (✻ ✽ · ⠁ ⠈ etc.)
  // depending on animation frame. The gerund+ellipsis combo is the
  // consistent signal that survives glyph rotation. Past-tense lines like
  // "✻ Worked for 11s" or "✻ Crunched for 11s" lack the ellipsis and are
  // turn-complete summaries — they must NOT match (ao-143 repro).
  if (/\b\w+ing…/.test(wideTail)) return "active";
  // NOTE — these patterns look "active-ish" but are NOT, and should never
  // go back as active indicators:
  //   - /\bCrunched\s+for\s+\d+s/  — past-tense turn summary (ao-154 repro:
  //     "✻ Crunched for 22s" was making sessions perpetually "active")
  //   - /\bWorked\s+for\s+\d+s/    — past-tense turn summary (ao-143 repro)
  //   - /^\s*⎿\s+/                  — prefixes past tool-results too
  //   - /esc to interrupt/          — in the persistent UI footer
  //   - bare /\bWorking\b/          — matches "working on issue #N" in recap
  // The gerund+ellipsis above catches present-tense forms across all
  // status words regardless of spinner glyph rotation.

  // Word-based fallbacks for synthetic test inputs and rare cases where
  // the ellipsis isn't captured. Tight patterns to avoid false-firing on
  // benign text.
  if (/\bGerminating/i.test(wideTail)) return "active";
  if (/\b(?:Thinking|Working)\s*(?:…|\.\.\.)/i.test(wideTail)) return "active";
  if (/\bReading\s+file/i.test(wideTail)) return "active";
  if (/\bWriting\s+to\b/i.test(wideTail)) return "active";
  if (/\bSearching\s+codebase/i.test(wideTail)) return "active";
  if (/Press\s+up\s+to\s+edit\s+queued/i.test(wideTail)) return "active";

  return "idle";
}

// =============================================================================
// Activity-state cascade
// =============================================================================

/**
 * Claude writes these types as UI-state snapshots at random times: on session
 * attach, on permission-mode change, on title regeneration, etc. They are
 * NOT correlated with whether Claude is actively working — a 6-day-dormant
 * session will still accumulate dozens of `permission-mode` and `ai-title`
 * entries just from being inspected.
 *
 * When one of these is the literal last JSONL entry, treat it as a "no
 * signal" — fall through to the AO activity-JSONL pipeline (terminal-
 * derived signal) rather than letting noise mtime decide the activity.
 *
 * Concrete bug this prevents: ao-144 had 73 trailing `permission-mode` +
 * 73 trailing `ai-title` entries written over 6 dormant days. Without
 * this skip, dashboard oscillated between `ready` (recent noise mtime)
 * and `idle` (old noise mtime) instead of staying `idle`.
 *
 * Conservative list — only the types that empirically run away. The other
 * bookkeeping types (file-history-snapshot, attachment, pr-link,
 * queue-operation, last-prompt) plausibly correlate with real activity
 * and stay in the explicit ready/idle case.
 */
const NOISE_JSONL_TYPES: ReadonlySet<string> = new Set([
  "permission-mode",
  "ai-title",
  "agent-color",
  "agent-name",
  "custom-title",
  // pr-link is also re-snapshot noise — verified on ao-160's JSONL where the
  // SAME PR (#1911) was written as a `pr-link` entry three times within
  // minutes (count: 33 pr-link vs 21 user messages in the last 200 lines).
  // The first emission is real; subsequent re-emissions are state snapshots.
  // We can't distinguish first vs Nth from the last line alone, so treat
  // all pr-link as noise. Real PR creation is still observable via the
  // assistant message and the gh-tracker side.
  "pr-link",
]);

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

  const projectPath = toClaudeProjectPath(await resolveWorkspaceForClaude(session.workspacePath));
  const projectDir = join(homedir(), ".claude", "projects", projectPath);

  // Prefer the UUID-named file when getSessionInfo has captured one — this
  // disambiguates multi-session-per-worktree, where newest-mtime would pick
  // the wrong session's JSONL whenever its sibling has just written.
  const rawUuid = session.metadata?.["claudeSessionUuid"];
  const preferredUuid =
    typeof rawUuid === "string" && rawUuid.trim() ? rawUuid.trim() : undefined;
  const sessionFile = await findLatestSessionFile(projectDir, preferredUuid);
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
      } else if (entry.lastType && NOISE_JSONL_TYPES.has(entry.lastType)) {
        // Last entry is UI-state noise (permission-mode / ai-title / etc.)
        // that doesn't reflect actual activity. Fall through to the AO
        // activity-JSONL pipeline for a terminal-derived answer; if that's
        // also empty, the staleNativeState below returns idle.
        staleNativeState = { state: "idle", timestamp: session.createdAt };
      } else {
        const ageMs = Date.now() - entry.modifiedAt.getTime();
        const timestamp = entry.modifiedAt;

        const activeWindowMs = Math.min(DEFAULT_ACTIVE_WINDOW_MS, threshold);
        switch (entry.lastType) {
          // In-progress turn markers: very recent → active, older → ready/idle.
          // Removed `tool_use` and `result` cases that were in the spec but
          // never actually emitted by Claude (verified by disk survey for
          // #1927). The `default` branch handles them with the same semantics
          // if Claude ever introduces them.
          case "user":
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
            return { state: ageMs > threshold ? "idle" : "ready", timestamp };

          // Bookkeeping types Claude writes AFTER a real event (file edits,
          // attachment context, queue housekeeping, prompt submit). Map to
          // ready/idle by age, same as assistant/summary. The pure re-snapshot
          // types (permission-mode, ai-title, agent-*, custom-title, pr-link)
          // are filtered out earlier by NOISE_JSONL_TYPES — they get written
          // continuously without indicating activity.
          case "file-history-snapshot":
          case "attachment":
          case "queue-operation":
          case "last-prompt":
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
