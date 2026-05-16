import { execFile } from "node:child_process";
import path from "node:path";

const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 5_000;

function execFileStdout(
  file: string,
  args: string[],
  options: { timeout?: number; windowsHide?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout));
    });
  });
}

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parsePowerShellJsonNumbers(stdout: string): number[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "number") return Number.isInteger(parsed) ? [parsed] : [];
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is number => Number.isInteger(value));
    }
  } catch {
    return [];
  }
  return [];
}

async function findWindowsPtyHostPidsForProject(
  projectDir: string,
  runExecFile: typeof execFileStdout = execFileStdout,
): Promise<number[]> {
  const normalizedProjectDir = path.resolve(projectDir);
  const script = [
    `$needle = ${quotePowerShellString(normalizedProjectDir)}`,
    "Get-CimInstance Win32_Process",
    "  | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('pty-host.js') -and $_.CommandLine.Contains($needle) }",
    "  | Select-Object -ExpandProperty ProcessId",
    "  | ConvertTo-Json -Compress",
  ].join("\n");

  const stdout = await runExecFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(script)],
    { timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS, windowsHide: true },
  );
  return parsePowerShellJsonNumbers(stdout);
}

type StopStaleWindowsPtyHostsDeps = {
  platform?: NodeJS.Platform;
  execFileStdout?: typeof execFileStdout;
  delay?: (ms: number) => Promise<void>;
};

export async function stopStaleWindowsPtyHosts(
  projectDir: string,
  deps: StopStaleWindowsPtyHostsDeps = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const runExecFile = deps.execFileStdout ?? execFileStdout;
  const delay = deps.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (platform !== "win32") return;

  let pids: number[];
  try {
    pids = await findWindowsPtyHostPidsForProject(projectDir, runExecFile);
  } catch {
    return;
  }

  const uniquePids = [...new Set(pids)].filter((pid) => pid > 0 && pid !== process.pid);
  for (const pid of uniquePids) {
    try {
      await runExecFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      // The process may have exited between discovery and taskkill.
    }
  }

  if (uniquePids.length > 0) {
    await delay(250);
  }
}
