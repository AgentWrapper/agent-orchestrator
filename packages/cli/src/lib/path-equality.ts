/**
 * Canonical path-equality helpers.
 *
 * On Windows, `realpathSync` can return canonically resolved paths whose
 * drive-letter case and 8.3-vs-long-name expansion differ from the input
 * even when both inputs point to the same filesystem entry (e.g. one input
 * came from a config file and another from `process.cwd()` after a chdir).
 * A naive `===` comparison misses these as "different paths" and the calling
 * code falls into "treat as new" branches — for project resolution this
 * presents to the user as phantom "register this project?" prompts even
 * when the project is already registered.
 *
 * This module centralises the comparison so every site that asks "are
 * these two paths the same on disk?" gets the same answer regardless of
 * platform. POSIX behaviour is unchanged (case-sensitive `===`).
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isWindows } from "@aoagents/ao-core";

/**
 * Resolve symlinks. Falls back to the input on any filesystem error so
 * callers can still compare unreadable paths literally rather than crash.
 * Mirrors the canonicalize() helper that previously lived in
 * resolve-project.ts.
 */
function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Build the comparison key for a path: resolve to absolute, expand `~`,
 * canonicalize symlinks, and normalize case on Windows. Useful when the
 * caller needs a stable key for `Map`/`Set` lookups across many paths.
 */
export function canonicalCompareKey(input: string): string {
  const expanded = input.replace(/^~/, process.env["HOME"] ?? "");
  const canonical = canonicalize(resolve(expanded));
  return isWindows() ? canonical.toLowerCase() : canonical;
}

/**
 * Compare two paths for "same filesystem entry" semantics. Equivalent to
 * `canonicalCompareKey(a) === canonicalCompareKey(b)` but kept as a named
 * helper for readability at call sites.
 */
export function pathsEqual(a: string, b: string): boolean {
  return canonicalCompareKey(a) === canonicalCompareKey(b);
}
