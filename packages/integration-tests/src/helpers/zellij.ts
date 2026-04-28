import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function isZellijAvailable(): Promise<boolean> {
  try {
    await execFileAsync("zellij", ["--version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function killZellijSessionsByPrefix(prefix: string): Promise<void> {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("zellij", ["list-sessions", "--short", "--no-formatting"], {
      timeout: 5_000,
    }));
  } catch {
    return;
  }

  await Promise.all(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((session) => session.startsWith(prefix))
      .map(async (session) => {
        try {
          await execFileAsync("zellij", ["kill-session", session], { timeout: 5_000 });
        } catch {
          // Best-effort cleanup
        }
      }),
  );
}
