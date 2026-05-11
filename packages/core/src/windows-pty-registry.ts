/**
 * Sideband registry of live Windows pty-host processes.
 *
 * The runtime-process plugin spawns each pty-host with `detached: true` so it
 * survives parent exit (mirroring the tmux daemon model on Linux). That same
 * detachment means `taskkill /T /F /PID <ao_pid>` cannot reach pty-hosts —
 * they're in their own console group, outside the parent's process tree.
 *
 * Per-session JSON metadata also can't be the source of truth for cleanup:
 * if a worktree is rm-rf'd or session JSON is lost (legacy storage cleanup,
 * crash mid-write, manual recovery), the runtime-side processes become
 * unreachable and `ao stop` orphans them silently.
 *
 * This registry is a flat list at `~/.agent-orchestrator/windows-pty-hosts.json`
 * that AO writes on spawn and reads on `ao stop` (and on next `ao start`'s
 * orphan sweep, future work). It exists outside session JSON so cleanup of
 * sessions never severs AO's ability to find and graceful-kill the hosts.
 *
 * Reads auto-prune entries whose PID is no longer alive.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

export interface WindowsPtyHostEntry {
  sessionId: string;
  ptyHostPid: number;
  pipePath: string;
  registeredAt: string;
}

// Resolved lazily so tests that mock node:os (vitest mock factories run after
// module evaluation) can override `homedir()` before the first read/write.
function getRegistryFile(): string {
  return join(homedir(), ".agent-orchestrator", "windows-pty-hosts.json");
}

function readRaw(): WindowsPtyHostEntry[] {
  const file = getRegistryFile();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is WindowsPtyHostEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as WindowsPtyHostEntry).sessionId === "string" &&
        typeof (e as WindowsPtyHostEntry).ptyHostPid === "number" &&
        typeof (e as WindowsPtyHostEntry).pipePath === "string",
    );
  } catch {
    return [];
  }
}

function writeRaw(entries: WindowsPtyHostEntry[]): void {
  const file = getRegistryFile();
  if (entries.length === 0) {
    try {
      unlinkSync(file);
    } catch {
      /* file may not exist */
    }
    return;
  }
  atomicWriteFileSync(file, JSON.stringify(entries, null, 2));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as { code?: string }).code === "EPERM";
  }
}

/**
 * Add (or replace) an entry for a freshly-spawned pty-host.
 * If a stale entry for the same `sessionId` exists, it's overwritten.
 */
export function registerWindowsPtyHost(entry: Omit<WindowsPtyHostEntry, "registeredAt">): void {
  const next = readRaw().filter((e) => e.sessionId !== entry.sessionId);
  next.push({ ...entry, registeredAt: new Date().toISOString() });
  writeRaw(next);
}

/**
 * Remove an entry by `sessionId`. No-op if absent.
 */
export function unregisterWindowsPtyHost(sessionId: string): void {
  const before = readRaw();
  const next = before.filter((e) => e.sessionId !== sessionId);
  if (next.length === before.length) return;
  writeRaw(next);
}

/**
 * Read all live entries, auto-pruning entries whose PID is no longer alive.
 * The on-disk file is rewritten if any entries were pruned.
 */
export function getWindowsPtyHosts(): WindowsPtyHostEntry[] {
  const all = readRaw();
  const live = all.filter((e) => isAlive(e.ptyHostPid));
  if (live.length !== all.length) writeRaw(live);
  return live;
}

/**
 * Best-effort: delete the entire registry file. Used for tests and recovery.
 */
export function clearWindowsPtyHostRegistry(): void {
  writeRaw([]);
}

/** Exported for tests. */
export function __getWindowsPtyRegistryFile(): string {
  return getRegistryFile();
}
