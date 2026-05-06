/**
 * Shared utility functions for agent-orchestrator plugins.
 */

import { open, stat } from "node:fs/promises";
import type { OrchestratorConfig } from "./types.js";

/**
 * POSIX-safe shell escaping: wraps value in single quotes,
 * escaping any embedded single quotes as '\\'' .
 *
 * Safe for use in both `sh -c` and `execFile` contexts.
 */
export function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Escape a string for safe interpolation inside AppleScript double-quoted strings.
 * Handles backslashes and double quotes which would otherwise break or inject.
 */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Validate that a URL starts with http:// or https://.
 * Throws with a descriptive error including the plugin label if invalid.
 */
export function validateUrl(url: string, label: string): void {
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    throw new Error(`[${label}] Invalid url: must be http(s), got "${url}"`);
  }
}

/**
 * Conservative subset of git `check-ref-format` rules for branch-like names.
 * Used before passing tracker-supplied names to `git worktree` / `checkout -b`.
 *
 * Slashes are allowed (e.g. `feature/foo-bar`).
 */
export function isGitBranchNameSafe(name: string): boolean {
  if (!name) return false;
  if (name === "@" || name.startsWith(".") || name.endsWith(".") || name.endsWith("/")) return false;
  if (name.endsWith(".lock")) return false;
  if (name.includes("..")) return false;
  if (name.includes("//")) return false;
  if (name.includes("/.")) return false;
  if (name.includes("@{")) return false;
  if (name.startsWith("/")) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  // Space and git-forbidden punctuation (see git-check-ref-format)
  if (/[\s~^:?*[\\]/.test(name)) return false;
  return true;
}

/**
 * Returns true if an HTTP status code should be retried.
 * Retry only 429 (rate-limit) and 5xx (server) failures.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Normalize retry config from plugin config with sane defaults.
 */
export function normalizeRetryConfig(
  config: Record<string, unknown> | undefined,
  defaults: { retries: number; retryDelayMs: number } = { retries: 2, retryDelayMs: 1000 },
): { retries: number; retryDelayMs: number } {
  const rawRetries = config?.retries as number | undefined;
  const rawDelay = config?.retryDelayMs as number | undefined;
  const retries = Number.isFinite(rawRetries) ? Math.max(0, rawRetries ?? 0) : defaults.retries;
  const retryDelayMs = Number.isFinite(rawDelay) && (rawDelay ?? -1) >= 0
    ? (rawDelay as number)
    : defaults.retryDelayMs;
  return { retries, retryDelayMs };
}

/**
 * Read the last line from a file by reading backwards from the end.
 * Pure Node.js — no external binaries. Handles any file size.
 */
async function readLastLine(filePath: string): Promise<string | null> {
  const CHUNK = 4096;
  const fh = await open(filePath, "r");
  try {
    const { size } = await fh.stat();
    if (size === 0) return null;

    // Read backwards in chunks, accumulating raw buffers to avoid
    // corrupting multi-byte UTF-8 characters at chunk boundaries.
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let pos = size;

    while (pos > 0) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      const chunk = Buffer.alloc(readSize);
      await fh.read(chunk, 0, readSize, pos);
      chunks.unshift(chunk);
      totalBytes += readSize;

      // Convert all accumulated bytes to string at once (safe for multi-byte)
      const tail = Buffer.concat(chunks, totalBytes).toString("utf-8");

      // Find the last non-empty line
      const lines = tail.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line) {
          // If i > 0, we have a complete line (there's a newline before it)
          // If i === 0 and pos === 0, we've read the whole file — line is complete
          // If i === 0 and pos > 0, the line may be truncated — keep reading
          if (i > 0 || pos === 0) return line;
        }
      }
    }

    const tail = Buffer.concat(chunks, totalBytes).toString("utf-8");
    return tail.trim() || null;
  } finally {
    await fh.close();
  }
}

/**
 * Read the last entry from a JSONL file.
 * Reads backwards from end of file — pure Node.js, no external binaries.
 *
 * @param filePath - Path to the JSONL file
 * @returns Object containing the last entry's type and file mtime, or null if empty/invalid
 */
export async function readLastJsonlEntry(
  filePath: string,
): Promise<{ lastType: string | null; payloadType: string | null; modifiedAt: Date } | null> {
  try {
    const [line, fileStat] = await Promise.all([readLastLine(filePath), stat(filePath)]);

    if (!line) return null;

    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const lastType = typeof obj.type === "string" ? obj.type : null;
      let payloadType: string | null = null;
      if (typeof obj.payload === "object" && obj.payload !== null && !Array.isArray(obj.payload)) {
        const payload = obj.payload as Record<string, unknown>;
        if (typeof payload.type === "string") payloadType = payload.type;
      }
      return { lastType, payloadType, modifiedAt: fileStat.mtime };
    }

    return { lastType: null, payloadType: null, modifiedAt: fileStat.mtime };
  } catch {
    return null;
  }
}

/**
 * Given a session ID and the orchestrator config, find which project it belongs
 * to by matching session prefixes.
 */
export function resolveProjectIdForSessionId(
  config: OrchestratorConfig,
  sessionId: string,
): string | undefined {
  for (const [projectId, project] of Object.entries(config.projects)) {
    const prefix = project.sessionPrefix;
    if (sessionId === prefix || sessionId.startsWith(`${prefix}-`)) {
      return projectId;
    }
  }
  return undefined;
}
