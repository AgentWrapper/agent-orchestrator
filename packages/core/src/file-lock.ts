import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  options: { timeoutMs?: number; staleMs?: number } = {},
): T {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 60_000;
  mkdirSync(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;
  let waitMs = 10;

  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`Failed to acquire file lock: ${lockPath}`, { cause: err });
      }

      try {
        const info = statSync(lockPath);
        if (Date.now() - info.mtimeMs > staleMs) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`, { cause: err });
      }

      sleepSync(waitMs);
      waitMs = Math.min(waitMs * 2, 250);
    }
  }

  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Ignore cleanup races.
    }
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}
