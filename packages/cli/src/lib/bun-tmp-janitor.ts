import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { getOpenCodeTmpDir } from "@aoagents/ao-core";

// Bun-bundled binaries (opencode, etc.) extract embedded shared libraries to
// `TMPDIR` on startup and never unlink them on exit — this is a known upstream
// Bun bug that leaks ~4.3 MB per process invocation. Files look like
// `.{16hex}-{8hex}.{so|dylib}` (e.g. `.fcb8efb7fbaad77d-00000000.so`).
//
// We point every `opencode` child we spawn at an AO-owned subdirectory via
// `TMPDIR` (see `getOpenCodeChildEnv` in `@aoagents/ao-core`). The janitor
// then sweeps **only that directory**, which keeps the blast radius bounded:
// no other user's or other application's Bun artifacts can ever be touched
// even if AO runs as root on a shared host.
//
// Deleting these files is safe even while a live process has them mmap'd: on
// POSIX systems, `unlink` removes the directory entry but the kernel keeps
// the inode alive until the last mapping is torn down, at which point the
// space is reclaimed. For already-exited processes the unlink frees disk
// immediately. Windows does not allow unlinking mapped files, and opencode
// does not ship a Windows binary, so the janitor is a no-op there.
//
// This janitor runs once per `ao start` process and sweeps matching files
// older than `ageMs` at every interval.

const BUN_TMP_LIB_PATTERN = /^\.[0-9a-f]{8,}-[0-9a-f]{6,}\.(so|dylib)$/i;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_AGE_MS = 60_000;

export interface BunTmpJanitorOptions {
  intervalMs?: number;
  ageMs?: number;
  onSweep?: (result: { removed: number; freedBytes: number; errors: number }) => void;
}

let timer: NodeJS.Timeout | null = null;
let inFlightTick: Promise<void> | null = null;

async function sweepOnce(
  dir: string,
  ageMs: number,
): Promise<{ removed: number; freedBytes: number; errors: number }> {
  let removed = 0;
  let freedBytes = 0;
  let errors = 0;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory may not exist yet (no opencode child has run). That is not
    // an error condition — there is nothing to sweep.
    return { removed, freedBytes, errors: 0 };
  }

  // Filter synchronously *before* spawning per-entry stat/unlink work. On a
  // host with thousands of /tmp entries this avoids allocating one promise
  // per file we are about to discard. (Belt-and-suspenders: TMPDIR isolation
  // already bounds the directory contents to AO's own children.)
  const matches = entries.filter((name) => BUN_TMP_LIB_PATTERN.test(name));
  if (matches.length === 0) {
    return { removed, freedBytes, errors: 0 };
  }

  const cutoff = Date.now() - ageMs;

  await Promise.all(
    matches.map(async (name) => {
      const path = join(dir, name);
      try {
        const st = await stat(path);
        if (!st.isFile() || st.mtimeMs > cutoff) return;
        await unlink(path);
        removed += 1;
        freedBytes += st.size;
      } catch {
        // File may have been deleted by another sweeper, or stat raced
        // with an unlink, or we lack permission. Best-effort — don't throw.
        errors += 1;
      }
    }),
  );

  return { removed, freedBytes, errors };
}

export function startBunTmpJanitor(options: BunTmpJanitorOptions = {}): boolean {
  // Windows: opencode ships no win32 binary and unlinking mapped files is
  // disallowed by the kernel, so the janitor would be both unnecessary and
  // potentially error-prone. Skip.
  if (process.platform === "win32") return false;
  if (timer) return false;

  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const ageMs = options.ageMs ?? DEFAULT_AGE_MS;
  const { onSweep } = options;
  const dir = getOpenCodeTmpDir();

  const tick = async (): Promise<void> => {
    // Single-flight: if a previous tick is still running, skip this one.
    if (inFlightTick) return;
    const promise = (async () => {
      try {
        const result = await sweepOnce(dir, ageMs);
        if (onSweep && (result.removed > 0 || result.errors > 0)) {
          onSweep(result);
        }
      } finally {
        inFlightTick = null;
      }
    })();
    inFlightTick = promise;
    await promise;
  };

  // Run an immediate sweep to clear any backlog, then on an interval.
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return true;
}

/**
 * Stop the janitor and await any sweep currently in flight. The shutdown
 * handler in `start.ts` awaits this so the process never exits while
 * `unlink` calls are still mid-flight against the filesystem.
 */
export async function stopBunTmpJanitor(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (inFlightTick) {
    try {
      await inFlightTick;
    } catch {
      // Best-effort — don't block shutdown on an in-flight sweep error.
    }
  }
}

export function isBunTmpJanitorRunning(): boolean {
  return timer !== null;
}
