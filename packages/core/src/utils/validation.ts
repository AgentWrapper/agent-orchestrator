/**
 * Shared validation utilities.
 */

import type { SessionStatus } from "../types.js";

/** Valid session statuses for validation. */
const VALID_STATUSES: ReadonlySet<string> = new Set([
  "spawning",
  "working",
  "detecting",
  "pr_open",
  "ci_failed",
  "review_pending",
  "changes_requested",
  "approved",
  "mergeable",
  "merged",
  "cleanup",
  "needs_input",
  "stuck",
  "errored",
  "killed",
  "idle",
  "done",
  "terminated",
]);

/** Safely parse JSON, returning null on failure. */
export function safeJsonParse<T>(str: string): T | null {
  try {
    return JSON.parse(str) as T;
  } catch {
    return null;
  }
}

/** Validate and normalize a status string. */
export function validateStatus(raw: string | undefined): SessionStatus {
  // Bash scripts write "starting" — treat as "working"
  if (raw === "starting") return "working";
  if (raw && VALID_STATUSES.has(raw)) return raw as SessionStatus;
  return "spawning";
}
