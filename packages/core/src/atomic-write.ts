import { renameSync, writeFileSync, unlinkSync } from "node:fs";
import { isWindows } from "./platform.js";

// Windows file-locking workaround. `renameSync` can fail with EPERM/EACCES when
// antivirus, the Windows indexer, or another process briefly holds a handle on
// the destination path. The failures are transient — a short retry loop is the
// standard fix (same pattern Node's own `fs.rm` uses internally).
const RENAME_RETRIES = isWindows() ? 10 : 0;
const RENAME_RETRY_DELAY_MS = 50;

function renameWithRetry(src: string, dest: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RENAME_RETRIES; attempt++) {
    try {
      renameSync(src, dest);
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw err;
      if (attempt === RENAME_RETRIES) break;
      const deadline = Date.now() + RENAME_RETRY_DELAY_MS;
      while (Date.now() < deadline) {
        // busy-wait; renameSync is sync so we can't await
      }
    }
  }
  throw lastError;
}

/**
 * Atomically write a file by writing to a temp file then renaming.
 * rename() is atomic on POSIX, so concurrent writers never produce torn data.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, content, "utf-8");
  try {
    renameWithRetry(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}
