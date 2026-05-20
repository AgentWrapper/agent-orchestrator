import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { homedir, userInfo } from "node:os";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFileCb);

/**
 * Cross-platform adapter.
 *
 * All platform-branching logic lives here. Every other module imports
 * from this file instead of doing ad-hoc process.platform checks.
 */

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function isMac(): boolean {
  return process.platform === "darwin";
}

export function isLinux(): boolean {
  return process.platform === "linux";
}

export function getDefaultRuntime(): "tmux" | "process" {
  return isWindows() ? "process" : "tmux";
}

// -- Shell resolution --

interface ShellInfo {
  cmd: string;
  args: (command: string) => string[];
}

let cachedShell: ShellInfo | null = null;

/**
 * Infer the command-string flag for a given shell from its basename.
 * pwsh / powershell → -Command, cmd → /c, bash / sh / zsh → -c.
 * Default to PowerShell args (the historical behaviour) for unknown shells.
 */
function inferShellArgsFlag(cmd: string): (command: string) => string[] {
  const base = cmd
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (base === "cmd") return (c) => ["/c", c];
  if (base === "bash" || base === "sh" || base === "zsh" || base === "dash") {
    return (c) => ["-c", c];
  }
  // pwsh, powershell, and anything else fall back to PowerShell-style args.
  return (c) => ["-Command", c];
}

/**
 * Walk PATH looking for an executable. Windows-only: only ever called from
 * resolveWindowsShell. Hard-coded `;` separator and `\` path join regardless
 * of host OS so unit tests that simulate Windows on a Linux CI runner produce
 * canonical Windows paths.
 */
function findOnPath(name: string): string | null {
  const exts = process.env["PATHEXT"]?.split(";").filter(Boolean) ?? [
    ".COM",
    ".EXE",
    ".BAT",
    ".CMD",
  ];
  const dirs = (process.env["PATH"] ?? "").split(";").filter(Boolean);
  for (const dir of dirs) {
    const base = dir.endsWith("\\") || dir.endsWith("/") ? dir.slice(0, -1) : dir;
    for (const ext of [...exts, ""]) {
      const candidate = `${base}\\${name}${ext}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveWindowsShell(): ShellInfo {
  // Explicit override — set AO_SHELL to an absolute path or shell name
  // (e.g. "powershell.exe", "pwsh", "cmd.exe", "bash"). Args are inferred
  // from the basename so cmd / bash / sh are usable, not just PowerShell.
  const override = process.env["AO_SHELL"];
  if (override) {
    return { cmd: override, args: inferShellArgsFlag(override) };
  }

  // Prefer pwsh (PowerShell Core, cross-platform). PATH-walk via existsSync
  // rather than execFileSync — a missing pwsh would otherwise block the event
  // loop for the spawn timeout on every cold start (this resolver is sync).
  const pwshPath = findOnPath("pwsh");
  if (pwshPath) {
    return { cmd: pwshPath, args: (c) => ["-Command", c] };
  }

  // Fall back to powershell.exe (Windows PowerShell, always on Win 10+).
  // Use the absolute path because the spawning process may have a degraded
  // PATH that doesn't include C:\Windows\System32 (e.g. Next.js dashboard
  // children spawned without full system PATH inheritance). Without this,
  // we'd fall through to cmd.exe — which breaks any launch command that uses
  // PowerShell syntax (e.g. Codex's `& 'codex' ...`).
  const systemRoot = process.env["SystemRoot"] || "C:\\Windows";
  const psAbsolute = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  if (existsSync(psAbsolute)) {
    return { cmd: psAbsolute, args: (c) => ["-Command", c] };
  }

  // Try PATH lookup as a final PowerShell attempt (unusual installs).
  const psPathLookup = findOnPath("powershell");
  if (psPathLookup) {
    return { cmd: psPathLookup, args: (c) => ["-Command", c] };
  }

  // Last resort: cmd.exe. Note that agent launch commands often use PowerShell
  // syntax (e.g. the `&` call operator) and will fail under cmd.exe. Setting
  // AO_SHELL is the supported escape hatch.
  const comspec = process.env["ComSpec"] || "cmd.exe";
  return { cmd: comspec, args: (c) => ["/c", c] };
}

export function getShell(): ShellInfo {
  if (cachedShell) return cachedShell;

  if (isWindows()) {
    cachedShell = resolveWindowsShell();
  } else {
    // Always use /bin/sh, not $SHELL. postCreate commands and runtime launches are
    // non-interactive; using $SHELL would break if the user's login shell is
    // non-POSIX (e.g. fish, nushell). /bin/sh is guaranteed POSIX-compliant on all Unix systems.
    cachedShell = { cmd: "/bin/sh", args: (c) => ["-c", c] };
  }

  return cachedShell;
}

/** Reset cached shell (for testing)
 * @internal
 */
export function _resetShellCache(): void {
  cachedShell = null;
}

// -- Process tree kill --

export async function killProcessTree(
  pid: number,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
): Promise<void> {
  // pid=0 means "current process group" on Unix (-0 === 0 in JS), which would
  // kill AO itself. pid<0 is never valid. Guard both.
  if (pid <= 0) return;
  if (isWindows()) {
    // Always use /F (force) on Windows. taskkill without /F sends WM_CLOSE, which
    // only works for GUI windows; headless Node.js console processes may ignore it,
    // leaving orphaned processes. Callers that do SIGTERM→wait→SIGKILL escalation
    // are unaffected: the SIGKILL step simply finds the process already dead.
    const args = ["/T", "/F", "/PID", String(pid)];
    try {
      await execFileAsync("taskkill", args, { windowsHide: true });
    } catch {
      // Process may already be dead
    }
  } else {
    // Unix: negative PID kills the process group
    try {
      process.kill(-pid, signal);
    } catch {
      // Process group may not exist, try direct kill
      try {
        process.kill(pid, signal);
      } catch {
        // Already dead
      }
    }
  }
}

// -- Port-based PID discovery --

export async function findPidByPort(port: number): Promise<string | null> {
  try {
    if (isWindows()) {
      // netstat -ano shows all connections with PIDs
      const { stdout } = await execFileAsync("netstat", ["-ano"], { windowsHide: true });
      const portPattern = new RegExp(`:${port}(?!\\d)`);
      for (const line of stdout.split("\n")) {
        // Match LISTENING state on the target local port exactly
        const parts = line.trim().split(/\s+/);
        const localAddress = parts[1];
        if (line.includes("LISTENING") && localAddress && portPattern.test(localAddress)) {
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid)) return pid;
        }
      }
      return null;
    } else {
      // Unix: lsof
      const { stdout } = await execFileAsync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"]);
      const pid = stdout.trim().split("\n")[0]?.trim();
      if (!pid || !/^\d+$/.test(pid)) return null;
      return pid;
    }
  } catch {
    return null;
  }
}

// -- Environment defaults --

interface EnvDefaults {
  HOME: string;
  SHELL: string;
  TMPDIR: string;
  PATH: string;
  USER: string;
}

export function getEnvDefaults(): EnvDefaults {
  if (isWindows()) {
    return {
      HOME: process.env["USERPROFILE"] || homedir(),
      SHELL: getShell().cmd,
      TMPDIR: process.env["TEMP"] || process.env["TMP"] || "C:\\Windows\\Temp",
      PATH: process.env["PATH"] || "",
      USER: process.env["USERNAME"] || userInfo().username,
    };
  }

  return {
    HOME: process.env["HOME"] || homedir(),
    SHELL: process.env["SHELL"] || "/bin/bash",
    TMPDIR: process.env["TMPDIR"] || "/tmp",
    PATH: process.env["PATH"] || "/usr/local/bin:/usr/bin:/bin",
    USER: process.env["USER"] || userInfo().username,
  };
}
