import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
  constants,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { atomicWriteFileSync } from "@aoagents/ao-core";

export interface RunningState {
  pid: number;
  configPath: string;
  port: number;
  startedAt: string;
  projects: string[];
}

const STATE_DIR = join(homedir(), ".agent-orchestrator");
const STATE_FILE = join(STATE_DIR, "running.json");
const STATE_LOCK_FILE = join(STATE_DIR, "running.lock");
const STARTUP_LOCK_FILE = join(STATE_DIR, "startup.lock");
const LAST_STOP_LOCK_FILE = join(STATE_DIR, "last-stop.lock");
const LAST_STOP_FILE = join(STATE_DIR, "last-stop.json");
const UNPARSEABLE_LOCK_GRACE_MS = 5_000;

export interface LastStopState {
  stoppedAt: string;
  projectId: string;
  sessionIds: string[];
  /** Sessions from other projects that were also active at stop time. */
  otherProjects?: Array<{ projectId: string; sessionIds: string[] }>;
}

interface LockMetadata {
  pid: number;
  acquiredAt: string;
}

function ensureDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "EPERM") {
      return true;
    }
    return false;
  }
}

function readLockMetadata(lockFile: string): LockMetadata | null {
  try {
    const raw = readFileSync(lockFile, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LockMetadata>;
    if (typeof parsed.pid !== "number") return null;
    return {
      pid: parsed.pid,
      acquiredAt:
        typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function isStaleUnparseableLock(lockFile: string): boolean {
  try {
    const mtimeMs = statSync(lockFile).mtimeMs;
    return Date.now() - mtimeMs > UNPARSEABLE_LOCK_GRACE_MS;
  } catch {
    return false;
  }
}

/** Try to create the lockfile atomically. Returns a release function on success, null on failure. */
function tryAcquire(lockFile: string): (() => void) | null {
  try {
    const fd = openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    const metadata: LockMetadata = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    try {
      writeFileSync(fd, JSON.stringify(metadata), "utf-8");
    } catch {
      try { unlinkSync(lockFile); } catch { /* best effort */ }
      return null;
    } finally {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    return () => {
      try { unlinkSync(lockFile); } catch { /* best effort */ }
    };
  } catch {
    return null;
  }
}

/**
 * Advisory lockfile using O_EXCL for atomic creation.
 * Retries with jittered backoff. Dead owners are treated as stale and cleaned
 * up automatically. Live owners are never stolen; callers get a clear timeout.
 */
async function acquireLock(
  lockFile: string,
  timeoutMs = 5000,
  resourceName = "lock",
): Promise<() => void> {
  ensureDir();

  const start = Date.now();
  let attempt = 0;

  while (true) {
    const release = tryAcquire(lockFile);
    if (release) return release;

    const owner = readLockMetadata(lockFile);
    if ((!owner && isStaleUnparseableLock(lockFile))
      || (owner && !isProcessAlive(owner.pid))) {
      try { unlinkSync(lockFile); } catch { /* ignore */ }
      const retryRelease = tryAcquire(lockFile);
      if (retryRelease) return retryRelease;
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`Could not acquire ${resourceName} (${lockFile})`);
    }

    // Jittered backoff: 30-70ms base, growing with attempts (capped at 200ms)
    const baseMs = Math.min(50 + attempt * 20, 200);
    const jitter = Math.floor(Math.random() * 40) - 20;
    await sleep(baseMs + jitter);
    attempt++;
  }
}

function readState(): RunningState | null {
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw) as RunningState;
    if (!state || typeof state.pid !== "number") return null;
    return state;
  } catch {
    return null;
  }
}

function writeState(state: RunningState | null): void {
  ensureDir();
  if (state === null) {
    try { unlinkSync(STATE_FILE); } catch { /* file may not exist */ }
  } else {
    // Atomic temp+rename so a crash mid-write cannot leave torn JSON
    // that makes `getRunning()` silently return `null` and orphan a
    // still-alive AO process from later CLI commands.
    atomicWriteFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
}

/**
 * Register the current AO instance as running.
 * Uses a lockfile to prevent concurrent registration.
 */
export async function register(entry: RunningState): Promise<void> {
  const release = await acquireLock(STATE_LOCK_FILE, 5000, "running.json lock");
  try {
    writeState(entry);
  } finally {
    release();
  }
}

/**
 * Unregister the running AO instance.
 */
export async function unregister(): Promise<void> {
  const release = await acquireLock(STATE_LOCK_FILE, 5000, "running.json lock");
  try {
    writeState(null);
  } finally {
    release();
  }
}

/**
 * Remove a single project from the running state's project list.
 * Used by `ao stop <project>` so that `ao start <project>` can restart
 * the orchestrator without hitting the "already running" gate.
 * No-op if the state is missing or the project isn't listed.
 */
export async function removeProjectFromRunning(projectId: string): Promise<void> {
  const release = await acquireLock(STATE_LOCK_FILE, 5000, "running.json lock");
  try {
    const state = readState();
    if (!state) return;
    const updated = state.projects.filter((p) => p !== projectId);
    if (updated.length === state.projects.length) return;
    writeState({ ...state, projects: updated });
  } finally {
    release();
  }
}

/**
 * Add a project to the running state's project list (idempotent).
 * Used when a project's orchestrator is spawned against an already-running
 * daemon — for example after `ao start <project>` attaches to an existing
 * parent process whose `projects` list didn't yet include the project.
 * Without this, subsequent `ao stop` (no args) would leave the new
 * orchestrator orphaned because it isn't in `running.projects`.
 * No-op if the state is missing or the project is already listed.
 */
export async function addProjectToRunning(projectId: string): Promise<void> {
  const release = await acquireLock(STATE_LOCK_FILE, 5000, "running.json lock");
  try {
    const state = readState();
    if (!state) return;
    if (state.projects.includes(projectId)) return;
    writeState({ ...state, projects: [...state.projects, projectId] });
  } finally {
    release();
  }
}

/**
 * Get the currently running AO instance, if any.
 * Auto-prunes stale entries (dead PIDs).
 */
export async function getRunning(): Promise<RunningState | null> {
  const release = await acquireLock(STATE_LOCK_FILE, 5000, "running.json lock");
  try {
    const state = readState();
    if (!state) return null;

    if (!isProcessAlive(state.pid)) {
      // Stale entry — process is dead, clean up
      writeState(null);
      return null;
    }

    return state;
  } finally {
    release();
  }
}

/**
 * Check if AO is already running.
 * Returns the running state if alive, null otherwise.
 */
export async function isAlreadyRunning(): Promise<RunningState | null> {
  return getRunning();
}

/**
 * Serialize `ao start` so concurrent startups cannot both observe an empty
 * running.json and create competing orchestrator/dashboard processes.
 */
export async function acquireStartupLock(timeoutMs = 30000): Promise<() => void> {
  return await acquireLock(STARTUP_LOCK_FILE, timeoutMs, "startup lock");
}

/**
 * Wait for a process to exit, polling isProcessAlive.
 * Returns true if the process exited, false if timeout reached.
 */
export async function waitForExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

/**
 * Record which sessions were active when `ao stop` ran.
 */
export async function writeLastStop(state: LastStopState): Promise<void> {
  const release = await acquireLock(LAST_STOP_LOCK_FILE, 5000, "last-stop.json lock");
  try {
    // Atomic temp+rename so a crash mid-write cannot leave torn JSON
    // that makes `readLastStop()` silently return `null` and lose the
    // restore prompt for sessions the user just stopped.
    atomicWriteFileSync(LAST_STOP_FILE, JSON.stringify(state, null, 2));
  } finally {
    release();
  }
}

/**
 * Read the last-stop state, if any.
 */
export async function readLastStop(): Promise<LastStopState | null> {
  const release = await acquireLock(LAST_STOP_LOCK_FILE, 5000, "last-stop.json lock");
  try {
    const raw = readFileSync(LAST_STOP_FILE, "utf-8");
    const state = JSON.parse(raw) as LastStopState;
    if (!state || typeof state.stoppedAt !== "string" || !state.projectId || !Array.isArray(state.sessionIds)) return null;
    return state;
  } catch {
    return null;
  } finally {
    release();
  }
}

/**
 * Remove the last-stop state file (after restore or skip).
 */
export async function clearLastStop(): Promise<void> {
  const release = await acquireLock(LAST_STOP_LOCK_FILE, 5000, "last-stop.json lock");
  try {
    try { unlinkSync(LAST_STOP_FILE); } catch { /* file may not exist */ }
  } finally {
    release();
  }
}
