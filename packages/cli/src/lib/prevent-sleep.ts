/**
 * Idle sleep prevention.
 *
 * macOS: spawns `caffeinate -i -w <pid>` to hold an idle-sleep prevention
 * assertion for the lifetime of the watched process. caffeinate releases the
 * assertion automatically when that pid exits.
 *
 * Linux: spawns `systemd-inhibit --what=idle --mode=block ...` wrapping a
 * tiny shell watchdog that polls the watched pid every 5s and exits when the
 * process is gone — releasing the inhibitor lock the same way `-w <pid>`
 * does on macOS. No-op on non-systemd systems (containers without
 * systemd-inhibit, WSL1, etc.) — the async spawn `error` event is swallowed.
 *
 * No-op on Windows and other unsupported platforms.
 *
 * @see https://github.com/ComposioHQ/agent-orchestrator/issues/1072
 * @see https://github.com/ComposioHQ/agent-orchestrator/issues/1799
 */

import { spawn, type ChildProcess } from "node:child_process";
import { isLinux, isMac, killProcessTree } from "@aoagents/ao-core";

export interface SleepPreventionHandle {
  /** Release the sleep prevention assertion early (optional — auto-releases on process exit) */
  release: () => void;
}

/**
 * Prevent idle sleep for the lifetime of a process.
 *
 * @param pid - The process ID to watch. When this process exits, the assertion
 *              is released. Defaults to the current process.
 * @returns A handle to release the assertion early, or null if the current
 *          platform is unsupported or the underlying binary is unavailable.
 */
export function preventIdleSleep(pid?: number): SleepPreventionHandle | null {
  const targetPid = pid ?? process.pid;

  if (isMac()) {
    return preventIdleSleepMac(targetPid);
  }
  if (isLinux()) {
    return preventIdleSleepLinux(targetPid);
  }
  return null;
}

function preventIdleSleepMac(targetPid: number): SleepPreventionHandle | null {
  // -i: prevent idle sleep (works on battery)
  // -w <pid>: release the assertion when <pid> exits
  const child: ChildProcess = spawn("caffeinate", ["-i", "-w", String(targetPid)], {
    stdio: "ignore",
    detached: true,
  });

  // child.pid is undefined when spawn fails synchronously (e.g., ENOENT on old
  // macOS versions where caffeinate is missing).
  if (child.pid === undefined) {
    return null;
  }

  child.unref();
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

function preventIdleSleepLinux(targetPid: number): SleepPreventionHandle | null {
  // systemd-inhibit holds the lock for as long as its child process is alive.
  // We give it a pid-polling watchdog so the lock auto-releases when AO dies
  // (mirroring caffeinate's `-w <pid>` behaviour). 5s poll interval is well
  // under any reasonable idle-suspend timeout.
  //
  //   --what=idle      only blocks idle auto-suspend (not lid-close / manual)
  //   --mode=block     actually prevents the action (vs `delay`)
  //   --who / --why    human-readable strings shown by `systemd-inhibit --list`
  const watchdog = `while kill -0 ${targetPid} 2>/dev/null; do sleep 5; done`;
  const child: ChildProcess = spawn(
    "systemd-inhibit",
    [
      "--what=idle",
      "--who=Agent Orchestrator",
      "--why=Active agent session running",
      "--mode=block",
      "sh",
      "-c",
      watchdog,
    ],
    { stdio: "ignore", detached: true },
  );

  // Attach the error listener BEFORE the pid check. Node emits `error`
  // asynchronously when execvp fails (ENOENT — no systemd-inhibit on PATH,
  // WSL1, some containers, Alpine without elogind); without a listener that
  // becomes an unhandled error and crashes AO. The pid-undefined branch
  // below still needs the listener attached because the async `error` event
  // fires after this function returns.
  child.on("error", () => {
    // Non-systemd environment. Nothing to release; silently ignore.
  });

  if (child.pid === undefined) {
    return null;
  }

  const inhibitPid = child.pid;
  child.unref();

  return {
    release: () => {
      // detached: true put systemd-inhibit in its own process group with the
      // `sh -c watchdog` as a group member. killProcessTree signals the
      // negative PID so the whole group dies in one shot (no orphan watchdog
      // lingering up to 5s); it also handles the direct-PID fallback if the
      // group-kill EPERMs. CROSS_PLATFORM.md mandates this helper for any
      // process-tree teardown. Fire-and-forget — kernel signal delivery is
      // async anyway and release() is sync.
      void killProcessTree(inhibitPid);
    },
  };
}
