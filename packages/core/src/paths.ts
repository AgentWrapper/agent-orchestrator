/**
 * Path utilities for the AO storage directory structure.
 *
 * V2 layout (projects/{projectId}/):
 *   getProjectDir(projectId)          → ~/.agent-orchestrator/projects/{projectId}
 *   getProjectSessionsDir(projectId)  → .../projects/{projectId}/sessions
 *   getProjectWorktreesDir(projectId) → .../projects/{projectId}/worktrees
 *   getOrchestratorPath(projectId)    → .../projects/{projectId}/orchestrator.json
 *   getSessionPath(projectId, sid)    → .../projects/{projectId}/sessions/{sid}.json
 *
 * Legacy layout ({storageKey}/):
 *   getProjectBaseDir(storageKey)     → ~/.agent-orchestrator/{storageKey}
 *   getSessionsDir(storageKey)        → ~/.agent-orchestrator/{storageKey}/sessions
 *   ... (deprecated, kept for migration only)
 */

import { createHash } from "node:crypto";
import { dirname, basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { realpathSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";

/**
 * Generate a 12-character hash from a config directory path.
 *
 * The hash is derived from dirname(configPath), which equals the project root
 * directory when configPath is <project>/agent-orchestrator.yaml.
 *
 * Handles non-existent paths gracefully (e.g. synthesized paths in remote/
 * Docker mode where no local config file exists) by falling back to
 * resolve() when realpathSync fails.
 */
export function generateConfigHash(configPath: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(configPath);
  } catch {
    // File may not exist (remote mode, Docker, pre-creation) — use resolved path
    resolved = resolve(configPath);
  }
  const configDir = dirname(resolved);
  const hash = createHash("sha256").update(configDir).digest("hex");
  return hash.slice(0, 12);
}

/**
 * Generate project ID from project path (basename of the path).
 * Example: ~/repos/integrator → "integrator"
 *
 * @deprecated New project registrations use generateExternalId() from global-config.ts.
 */
export function generateProjectId(projectPath: string): string {
  return basename(projectPath);
}

/**
 * Generate session prefix from project ID using clean heuristics.
 *
 * Rules:
 * 1. ≤4 chars: use as-is (lowercase)
 * 2. CamelCase: extract uppercase letters (PyTorch → pt)
 * 3. kebab/snake case: use initials (agent-orchestrator → ao)
 * 4. Single word: first 3 chars (integrator → int)
 */
export function generateSessionPrefix(projectId: string): string {
  if (projectId.length <= 4) {
    return projectId.toLowerCase();
  }

  // CamelCase: extract uppercase letters
  const uppercase = projectId.match(/[A-Z]/g);
  if (uppercase && uppercase.length > 1) {
    return uppercase.join("").toLowerCase();
  }

  // kebab-case or snake_case: use initials
  if (projectId.includes("-") || projectId.includes("_")) {
    const separator = projectId.includes("-") ? "-" : "_";
    return projectId
      .split(separator)
      .map((word) => word[0])
      .join("")
      .toLowerCase();
  }

  // Single word: first 3 characters
  return projectId.slice(0, 3).toLowerCase();
}

// =============================================================================
// V2 PATH FUNCTIONS (projects/{projectId}/ layout)
// =============================================================================

/** Maximum allowed length for a project ID. */
const MAX_PROJECT_ID_LENGTH = 128;

/** Pattern for safe project IDs — alphanumeric, dots, hyphens, underscores only. */
const SAFE_PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Validate a projectId is safe for use as a directory name, shell commands, and tmux sessions. */
function assertSafeProjectId(projectId: string): void {
  if (
    !projectId ||
    projectId === "." ||
    projectId === ".." ||
    projectId.length > MAX_PROJECT_ID_LENGTH ||
    !SAFE_PROJECT_ID_PATTERN.test(projectId)
  ) {
    throw new Error(`Unsafe project ID: "${projectId}"`);
  }
}

/** Get the project directory by project ID. */
export function getProjectDir(projectId: string): string {
  assertSafeProjectId(projectId);
  return join(getAoBaseDir(), "projects", projectId);
}

/** Get the sessions directory for a project (workers only). */
export function getProjectSessionsDir(projectId: string): string {
  return join(getProjectDir(projectId), "sessions");
}

/** Get the worktrees directory for a project. */
export function getProjectWorktreesDir(projectId: string): string {
  return join(getProjectDir(projectId), "worktrees");
}

/** Get the feedback reports directory for a project (V2 layout). */
export function getProjectFeedbackReportsDir(projectId: string): string {
  return join(getProjectDir(projectId), "feedback-reports");
}

/** Get the orchestrator metadata file path for a project. */
export function getOrchestratorPath(projectId: string): string {
  return join(getProjectDir(projectId), "orchestrator.json");
}

/** Get the session metadata file path (.json). */
export function getSessionPath(projectId: string, sessionId: string): string {
  return join(getProjectSessionsDir(projectId), `${sessionId}.json`);
}

// =============================================================================
// LEGACY PATH FUNCTIONS (deprecated — used by migration only)
// =============================================================================

/**
 * @deprecated Use getProjectDir(projectId) instead.
 * Get the project base directory for a storage key.
 * Format: ~/.agent-orchestrator/{storageKey}
 */
export function getProjectBaseDir(storageKey: string | undefined): string {
  return join(expandHome("~/.agent-orchestrator"), requireStorageKey(storageKey));
}

/**
 * Get the shared observability base directory for a config.
 * Format: ~/.agent-orchestrator/{hash}-observability
 */
export function getObservabilityBaseDir(configPath: string): string {
  const hash = generateConfigHash(configPath);
  return join(expandHome("~/.agent-orchestrator"), `${hash}-observability`);
}

/**
 * @deprecated Use getProjectSessionsDir(projectId) instead.
 * Get the sessions directory for a project.
 */
export function getSessionsDir(storageKey: string | undefined): string {
  return join(getProjectBaseDir(storageKey), "sessions");
}

/**
 * @deprecated Use getProjectWorktreesDir(projectId) instead.
 * Get the worktrees directory for a project.
 */
export function getWorktreesDir(storageKey: string | undefined): string {
  return join(getProjectBaseDir(storageKey), "worktrees");
}

/**
 * @deprecated Use getProjectFeedbackReportsDir(projectId) instead.
 * Get the feedback reports directory for a project.
 */
export function getFeedbackReportsDir(storageKey: string | undefined): string {
  return join(getProjectBaseDir(storageKey), "feedback-reports");
}

/**
 * @deprecated Legacy archive directory — archive system removed.
 * Get the archive directory for a project (legacy: nested inside sessions/).
 */
export function getArchiveDir(storageKey: string | undefined): string {
  return join(getSessionsDir(storageKey), "archive");
}

/**
 * @deprecated No longer needed — collision detection by storageKey is removed.
 * Get the .origin file path for a project.
 */
export function getOriginFilePath(storageKey: string | undefined): string {
  return join(getProjectBaseDir(storageKey), ".origin");
}

/**
 * Generate user-facing session name.
 * Format: {prefix}-{num}
 * Example: "int-1", "ao-42"
 */
export function generateSessionName(prefix: string, num: number): string {
  return `${prefix}-${num}`;
}

/**
 * @deprecated Session prefixes are globally unique — hash prefix is no longer needed.
 * Use generateSessionName(prefix, num) instead (same output as the new tmux name).
 *
 * Generate tmux session name (legacy format with hash).
 * Format: {storageKey}-{prefix}-{num}
 * Example: "a3b4c5d6e7f8-int-1"
 */
export function generateTmuxName(
  storageKey: string | undefined,
  prefix: string,
  num: number,
): string {
  return `${requireStorageKey(storageKey)}-${prefix}-${num}`;
}

/**
 * @deprecated Use parseTmuxNameV2 instead.
 * Parse a legacy tmux session name (with hash prefix).
 */
export function parseTmuxName(tmuxName: string): {
  hash: string;
  prefix: string;
  num: number;
} | null {
  const match = tmuxName.match(/^([a-f0-9]{12})-([a-zA-Z0-9_-]+)-(\d+)$/);
  if (!match) return null;

  return {
    hash: match[1],
    prefix: match[2],
    num: parseInt(match[3], 10),
  };
}

/**
 * Parse a V2 tmux session name (no hash prefix, same as session name).
 * Format: {prefix}-{num} e.g. "ao-84", "my-app-1"
 * Prefix must match sessionPrefix validation: [a-zA-Z0-9_-]+
 */
export function parseTmuxNameV2(tmuxName: string): {
  prefix: string;
  num: number;
} | null {
  // Greedy match: prefix is everything up to the last -{num}
  const match = tmuxName.match(/^([a-zA-Z0-9][a-zA-Z0-9_-]*)-(\d+)$/);
  if (!match) return null;
  return { prefix: match[1], num: parseInt(match[2], 10) };
}

/**
 * Expand ~ to home directory.
 */
export function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

/** Get the base AO directory (~/.agent-orchestrator/) */
export function getAoBaseDir(): string {
  return expandHome("~/.agent-orchestrator");
}

/** Get the portfolio directory (~/.agent-orchestrator/portfolio/) */
export function getPortfolioDir(): string {
  return join(getAoBaseDir(), "portfolio");
}

/** Get the portfolio preferences file path */
export function getPreferencesPath(): string {
  return join(getPortfolioDir(), "preferences.json");
}

/** Get the portfolio registered projects file path */
export function getRegisteredPath(): string {
  return join(getPortfolioDir(), "registered.json");
}

/**
 * @deprecated No longer needed — storageKey and .origin collision detection are removed.
 * Validate and store the .origin file for a project.
 */
export function validateAndStoreOrigin(configPath: string, storageKey: string): void {
  const originPath = getOriginFilePath(storageKey);
  let resolvedConfigPath: string;
  try {
    resolvedConfigPath = realpathSync(configPath);
  } catch {
    resolvedConfigPath = resolve(configPath);
  }

  if (existsSync(originPath)) {
    const stored = readFileSync(originPath, "utf-8").trim();
    if (stored !== resolvedConfigPath) {
      // Config path changed (local → global migration). Update .origin.
      writeFileSync(originPath, resolvedConfigPath, "utf-8");
    }
  } else {
    // Create project base directory and .origin file
    const baseDir = getProjectBaseDir(storageKey);
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(originPath, resolvedConfigPath, "utf-8");
  }
}

export function requireStorageKey(storageKey: string | undefined): string {
  if (!storageKey) {
    throw new Error("storageKey is required");
  }
  return storageKey;
}
