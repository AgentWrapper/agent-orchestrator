/**
 * Idle sleep prevention for macOS.
 *
 * Spawns `caffeinate -i -w <pid>` to hold an idle-sleep prevention assertion
 * for the duration of the AO process. The assertion is automatically released
 * when the watched process exits (cleanly, on crash, or via kill -9).
 *
 * No-op on non-macOS platforms.
 *
 * @see https://github.com/ComposioHQ/agent-orchestrator/issues/1072
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface SleepPreventionHandle {
  /** Release the sleep prevention assertion early (optional — auto-releases on process exit) */
  release: () => void;
}

/**
 * Prevent macOS idle sleep for the lifetime of a process.
 *
 * @param pid - The process ID to watch. When this process exits, the assertion is released.
 *              Defaults to the current process.
 * @returns A handle to release the assertion early, or null if not on macOS.
 *
 * @example
 * ```ts
 * // Prevent sleep for the current process
 * const handle = preventIdleSleep();
 *
 * // Prevent sleep while a child process runs
 * const child = spawn("node", ["server.js"]);
 * const handle = preventIdleSleep(child.pid);
 * ```
 */
export function preventIdleSleep(pid?: number): SleepPreventionHandle | null {
  // Only supported on macOS
  if (process.platform !== "darwin") {
    return null;
  }

  const targetPid = pid ?? process.pid;

  // Spawn caffeinate:
  // -i: Create an assertion to prevent idle sleep (works on battery)
  // -w <pid>: Wait for the specified process to exit, then release the assertion
  const child: ChildProcess = spawn("caffeinate", ["-i", "-w", String(targetPid)], {
    stdio: "ignore",
    detached: true,
  });

  // Check if spawn succeeded — child.pid is undefined if spawn failed synchronously
  // (e.g., ENOENT when caffeinate doesn't exist)
  if (child.pid === undefined) {
    return null;
  }

  // Don't keep the Node event loop alive for this child
  child.unref();

  // Handle spawn errors silently — caffeinate might not exist on old macOS versions
  child.on("error", () => {
    // caffeinate not available — silently ignore
  });

  return {
    release: () => {
      try {
        child.kill();
      } catch {
        // Already dead or not killable — ignore
      }
    },
  };
}
