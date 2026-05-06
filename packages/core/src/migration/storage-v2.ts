/**
 * Storage V2 migration — converts old hash-based storage layout to
 * the new `projects/{projectId}/` layout with JSON metadata.
 *
 * Old layout: ~/.agent-orchestrator/{12-hex}-{projectId}/sessions/{sessionId}
 * New layout: ~/.agent-orchestrator/projects/{projectId}/sessions/{sessionId}.json
 *
 * This module is intentionally self-contained — it must NOT import
 * deriveStorageKey, legacyProjectHash, or any old hash functions.
 * Detection uses a single regex: /^([0-9a-f]{12})-(.+)$/
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  cpSync,
  unlinkSync,
  type Dirent,
} from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseKeyValueContent } from "../key-value.js";
import { generateSessionPrefix } from "../paths.js";
import { atomicWriteFileSync } from "../atomic-write.js";
import { withFileLockSync } from "../file-lock.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex to detect old hash-based directory names: {12-hex}-{projectId}. */
const HASH_DIR_PATTERN = /^([0-9a-f]{12})-(.+)$/;

/** Regex to detect bare 12-hex hash directories (no project suffix). */
const BARE_HASH_DIR_PATTERN = /^([0-9a-f]{12})$/;

/** Regex to detect .migrated directories (for rollback). */
const MIGRATED_DIR_PATTERN = /^([0-9a-f]{12})-(.+)\.migrated$/;

/** Regex to detect bare .migrated directories. */
const BARE_MIGRATED_DIR_PATTERN = /^([0-9a-f]{12})\.migrated$/;

/** Directory name suffixes that are NOT project data and must be skipped by migration. */
const NON_PROJECT_SUFFIXES = new Set(["observability"]);

/** Marker file written during migration for crash-safety detection on re-run. */
const MIGRATION_MARKER = ".migration-in-progress";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationOptions {
  /** Force migration even if active tmux sessions are detected. */
  force?: boolean;
  /** Dry run — report what would be done without making changes. */
  dryRun?: boolean;
  /** Override the base AO directory (for testing). */
  aoBaseDir?: string;
  /** Override the global config path (for testing). */
  globalConfigPath?: string;
  /** Log function (defaults to console.log). */
  log?: (message: string) => void;
}

export interface RollbackOptions {
  /** Dry run — report what would be done without making changes. */
  dryRun?: boolean;
  /** Override the base AO directory (for testing). */
  aoBaseDir?: string;
  /** Override the global config path (for testing). */
  globalConfigPath?: string;
  /** Log function (defaults to console.log). */
  log?: (message: string) => void;
}

export interface MigrationResult {
  projects: number;
  sessions: number;
  worktrees: number;
  emptyDirsDeleted: number;
  strayWorktreesMoved: number;
  /** Number of Claude Code session-storage directories relinked to the new worktree path. */
  claudeSessionsRelinked: number;
  /** Number of Codex JSONL `session_meta.cwd` fields rewritten to the new worktree path. */
  codexSessionsRewritten: number;
}

/** A single (oldWorkspacePath, newWorkspacePath) pair captured during migration. */
interface WorkspacePathMove {
  oldWorkspacePath: string;
  newWorkspacePath: string;
}

export interface HashDirEntry {
  /** Full path to the hash-based directory. */
  path: string;
  /** The 12-char hex hash prefix. */
  hash: string;
  /** The project ID extracted from the directory name. */
  projectId: string;
  /** Whether the directory is empty (no sessions or worktrees). */
  empty: boolean;
}

// ---------------------------------------------------------------------------
// Inventory — detect old hash-based directories
// ---------------------------------------------------------------------------

export function inventoryHashDirs(aoBaseDir: string, globalConfigPath?: string): HashDirEntry[] {
  if (!existsSync(aoBaseDir)) return [];

  // Build a storageKey→projectId lookup from global config (for bare hash dirs)
  const storageKeyToProject = buildStorageKeyLookup(globalConfigPath);

  const entries: HashDirEntry[] = [];
  for (const name of readdirSync(aoBaseDir)) {
    let hash: string;
    let projectId: string;

    // Skip already-migrated directories — prevents .migrated.migrated on re-run
    if (name.endsWith(".migrated")) continue;

    const hashNameMatch = HASH_DIR_PATTERN.exec(name);
    const bareHashMatch = BARE_HASH_DIR_PATTERN.exec(name);

    if (hashNameMatch) {
      hash = hashNameMatch[1];
      projectId = sanitizeLegacyProjectId(hashNameMatch[2]);
      // Skip non-project directories (e.g. {hash}-observability)
      if (NON_PROJECT_SUFFIXES.has(hashNameMatch[2])) continue;
    } else if (bareHashMatch) {
      hash = bareHashMatch[1];
      // Derive projectId: config lookup → session metadata → fallback to hash
      const rawId = storageKeyToProject.get(hash) ?? deriveProjectIdFromDir(join(aoBaseDir, name)) ?? hash;
      projectId = sanitizeLegacyProjectId(rawId);
    } else {
      continue;
    }

    const dirPath = join(aoBaseDir, name);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // A directory is empty if it has no session files and no worktrees
    const sessionsDir = join(dirPath, "sessions");
    const worktreesDir = join(dirPath, "worktrees");
    const hasSessions = existsSync(sessionsDir) && readdirSync(sessionsDir).some(
      (f) => !f.startsWith(".") && f !== "archive",
    );
    const hasWorktrees = existsSync(worktreesDir) && readdirSync(worktreesDir).length > 0;
    entries.push({
      path: dirPath,
      hash,
      projectId,
      empty: !hasSessions && !hasWorktrees,
    });
  }

  return entries;
}

/**
 * Build a storageKey → projectId lookup from the global config.
 * Used to identify which project a bare hash directory belongs to.
 */
function buildStorageKeyLookup(globalConfigPath?: string): Map<string, string> {
  const lookup = new Map<string, string>();
  if (!globalConfigPath || !existsSync(globalConfigPath)) return lookup;

  try {
    const content = readFileSync(globalConfigPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    const projects = parsed?.["projects"] as Record<string, Record<string, unknown>> | undefined;
    if (!projects || typeof projects !== "object") return lookup;

    for (const [projectId, entry] of Object.entries(projects)) {
      if (entry && typeof entry === "object" && typeof entry["storageKey"] === "string") {
        lookup.set(entry["storageKey"], projectId);
      }
    }
  } catch {
    // Config unreadable — proceed without lookup
  }
  return lookup;
}

/**
 * Extract known project name prefixes from the global config.
 * Used by detectActiveSessions to match V2 tmux session names.
 */
function extractProjectPrefixes(globalConfigPath?: string): string[] {
  if (!globalConfigPath || !existsSync(globalConfigPath)) return [];

  try {
    const content = readFileSync(globalConfigPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    const projects = parsed?.["projects"] as Record<string, Record<string, unknown>> | undefined;
    if (!projects || typeof projects !== "object") return [];

    return Array.from(new Set(Object.entries(projects).map(([projectId, entry]) => {
      if (entry && typeof entry["sessionPrefix"] === "string" && entry["sessionPrefix"].trim()) {
        return entry["sessionPrefix"].trim();
      }
      if (entry && typeof entry["path"] === "string" && entry["path"].trim()) {
        return generateSessionPrefix(basename(entry["path"].trim()));
      }
      return generateSessionPrefix(projectId);
    })));
  } catch {
    return [];
  }
}

/**
 * Try to derive a projectId from session metadata files inside a directory.
 * Reads the first session file that has a "project" field.
 */
function deriveProjectIdFromDir(dirPath: string): string | null {
  const sessionsDir = join(dirPath, "sessions");
  if (!existsSync(sessionsDir)) return null;

  try {
    for (const file of readdirSync(sessionsDir)) {
      if (file === "archive" || file.startsWith(".")) continue;
      const filePath = join(sessionsDir, file);
      try {
        if (!statSync(filePath).isFile()) continue;
        const content = readFileSync(filePath, "utf-8").trim();
        if (!content) continue;

        // Try JSON first, then key=value
        let projectField: string | undefined;
        if (content.startsWith("{")) {
          const parsed = JSON.parse(content) as Record<string, unknown>;
          projectField = typeof parsed["project"] === "string" ? parsed["project"] : undefined;
        } else {
          const kv = parseKeyValueContent(content);
          projectField = kv["project"];
        }
        if (projectField) return projectField;
      } catch {
        continue;
      }
    }
  } catch {
    // Can't read sessions dir
  }
  return null;
}

// ---------------------------------------------------------------------------
// Active session detection
// ---------------------------------------------------------------------------

/**
 * Detect active AO tmux sessions. Returns session names that match
 * either legacy ({hash}-{prefix}-{num}) or V2 ({prefix}-{num}) patterns.
 *
 * Legacy names:  {12-hex}-{prefix}-{num}   (e.g. abcdef012345-ao-1)
 * V2 names:      {prefix}-{num}            (e.g. ao-17, app-orchestrator-1)
 *
 * To distinguish V2 names from unrelated tmux sessions, we match:
 * - Any session ending in `-orchestrator-{num}` (always AO)
 * - Sessions matching known AO prefixes: ao-{num}
 * - If knownPrefixes are provided, also match {prefix}-{num}
 */
export async function detectActiveSessions(knownPrefixes?: string[]): Promise<string[]> {
  try {
    const { execSync } = await import("node:child_process");
    const output = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    if (!output) return [];

    // Legacy pattern: {12-hex}-{anything}-{num}
    const legacyPattern = /^[0-9a-f]{12}-.+-\d+$/;
    // V2: default "ao" prefix
    const v2DefaultPattern = /^ao-\d+$/;

    // Build V2 prefix patterns from known project prefixes (workers + orchestrators)
    const v2PrefixPatterns = (knownPrefixes ?? [])
      .filter((p) => p && p !== "ao") // "ao" already covered above
      .flatMap((p) => [
        new RegExp(`^${escapeRegExp(p)}-\\d+$`),
        new RegExp(`^${escapeRegExp(p)}-orchestrator-\\d+$`),
      ]);

    return output.split("\n").filter((name) => {
      if (legacyPattern.test(name)) return true;
      if (v2DefaultPattern.test(name)) return true;
      if (/^ao-orchestrator-\d+$/.test(name)) return true;
      return v2PrefixPatterns.some((pattern) => pattern.test(name));
    });
  } catch {
    // tmux not available or no sessions
    return [];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Key-value to JSON conversion
// ---------------------------------------------------------------------------

/**
 * Convert old key=value metadata content to a JSON object.
 * Handles all the grouping and type conversions.
 */
export function convertKeyValueToJson(kvContent: string): Record<string, unknown> {
  const kv = parseKeyValueContent(kvContent);
  const result: Record<string, unknown> = {};

  // Direct string fields
  const stringFields = [
    "project", "agent", "createdAt", "branch", "tmuxName",
    "issue", "pr", "summary", "restoredAt", "role",
    "opencodeSessionId", "pinnedSummary", "userPrompt",
  ];
  for (const field of stringFields) {
    if (kv[field]) result[field] = kv[field];
  }

  // Worktree: keep as-is (will be made relative in the migration step)
  if (kv["worktree"]) result["worktree"] = kv["worktree"];

  // prAutoDetect: "on"/"off" → true/false
  if (kv["prAutoDetect"] === "on") result["prAutoDetect"] = true;
  else if (kv["prAutoDetect"] === "off") result["prAutoDetect"] = false;

  // runtimeHandle: parse JSON string → object
  if (kv["runtimeHandle"]) {
    try {
      result["runtimeHandle"] = JSON.parse(kv["runtimeHandle"]);
    } catch {
      result["runtimeHandle"] = kv["runtimeHandle"];
    }
  }

  // statePayload → lifecycle object
  if (kv["statePayload"]) {
    try {
      result["lifecycle"] = JSON.parse(kv["statePayload"]);
    } catch {
      // If statePayload is unparseable, leave it as-is for debugging
      result["statePayload"] = kv["statePayload"];
    }
  }
  // Drop "stateVersion" (inside lifecycle).
  // Preserve status for pre-lifecycle sessions that have no statePayload —
  // without it, readMetadata falls through to "unknown".
  if (!result["lifecycle"] && kv["status"]) {
    result["status"] = kv["status"];
  }

  // Port fields: string → number
  const portFields: Record<string, string> = {
    dashboardPort: "port",
    terminalWsPort: "terminalWsPort",
    directTerminalWsPort: "directTerminalWsPort",
  };
  const dashboard: Record<string, number> = {};
  for (const [kvKey, jsonKey] of Object.entries(portFields)) {
    if (kv[kvKey]) {
      const num = Number(kv[kvKey]);
      if (Number.isFinite(num)) dashboard[jsonKey] = num;
    }
  }
  if (Object.keys(dashboard).length > 0) result["dashboard"] = dashboard;

  // Agent report + report watcher fields stay flat to match runtime
  // behavior. Live readers (agent-report.ts:565 — parseExistingAgentReport,
  // lifecycle-manager.ts:2083, etc.) look up these keys directly on
  // session.metadata, and readMetadataRaw → flattenToStringRecord does
  // not unfold nested objects back into flat keys. Nesting them here
  // would silently lose this state for migrated sessions until restart
  // (and even then the freshness window means stale-yet-present is
  // safer than missing). Same rationale as the `detecting*` fields below.
  const flatPassthroughKeys = [
    "agentReportedState",
    "agentReportedAt",
    "agentReportedNote",
    "agentReportedPrUrl",
    "agentReportedPrNumber",
    "agentReportedPrIsDraft",
    "reportWatcherLastAuditedAt",
    "reportWatcherActiveTrigger",
    "reportWatcherTriggerActivatedAt",
    "reportWatcherTriggerCount",
  ] as const;
  for (const flatKey of flatPassthroughKeys) {
    if (kv[flatKey]) result[flatKey] = kv[flatKey];
  }

  // detecting fields — keep at top level to match runtime behavior.
  // The lifecycle manager reads/writes these as flat top-level fields
  // (session.metadata["detectingAttempts"], etc.), not from lifecycle.detecting.
  if (kv["lifecycleEvidence"]) result["lifecycleEvidence"] = kv["lifecycleEvidence"];
  if (kv["detectingAttempts"]) result["detectingAttempts"] = kv["detectingAttempts"];
  if (kv["detectingStartedAt"]) result["detectingStartedAt"] = kv["detectingStartedAt"];
  if (kv["detectingEvidenceHash"]) result["detectingEvidenceHash"] = kv["detectingEvidenceHash"];

  // Preserve unknown fields that weren't handled above.
  // This prevents data loss for custom or future metadata fields.
  const handledKeys = new Set([
    ...stringFields, "worktree", "prAutoDetect", "runtimeHandle",
    "statePayload", "stateVersion", "status",
    "dashboardPort", "terminalWsPort", "directTerminalWsPort",
    ...flatPassthroughKeys,
    "lifecycleEvidence", "detectingAttempts", "detectingStartedAt", "detectingEvidenceHash",
  ]);
  for (const [key, value] of Object.entries(kv)) {
    if (!handledKeys.has(key) && !(key in result)) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Detect if content is JSON or key=value format.
 */
function isJsonContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

/**
 * Read and convert a metadata file — handles both old key=value and JSON.
 */
function readAndConvertMetadata(filePath: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) return null;

    if (isJsonContent(content)) {
      return JSON.parse(content) as Record<string, unknown>;
    }
    return convertKeyValueToJson(content);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Legacy project ID sanitization
// ---------------------------------------------------------------------------

/** Pattern for safe project IDs — must match SAFE_PROJECT_ID_PATTERN in paths.ts. */
const SAFE_PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Sanitize a legacy project ID so it is safe for use as a V2 directory name.
 * Replaces spaces and other disallowed characters with hyphens, collapses
 * consecutive hyphens, trims leading/trailing hyphens, and ensures the ID
 * starts with an alphanumeric character.
 */
function sanitizeLegacyProjectId(projectId: string): string {
  if (SAFE_PROJECT_ID_PATTERN.test(projectId) && projectId.length <= 128) {
    return projectId;
  }
  let sanitized = projectId
    .replace(/[^a-zA-Z0-9._-]/g, "-")  // replace unsafe chars with hyphens
    .replace(/-{2,}/g, "-")              // collapse consecutive hyphens
    .replace(/^[-._]+/, "")              // strip leading non-alphanumeric
    .replace(/[-._]+$/, "");             // strip trailing non-alphanumeric
  if (!sanitized || !/^[a-zA-Z0-9]/.test(sanitized)) {
    sanitized = `project-${sanitized || "unknown"}`;
  }
  if (sanitized.length > 128) {
    sanitized = sanitized.slice(0, 128);
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// Per-project migration
// ---------------------------------------------------------------------------

interface ProjectMigrationResult {
  sessions: number;
  worktrees: number;
  /** Workspace path pairs (V1 → V2) for sessions whose worktree moved. */
  workspaceMoves: WorkspacePathMove[];
}

/** Get file mtime as epoch ms, returning 0 on error. */
function fileMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Move a directory, falling back to recursive copy + delete on EXDEV
 * (cross-device rename failure, e.g. Docker volumes, NFS mounts).
 */
function crossDeviceMove(src: string, dest: string, log: (message: string) => void): void {
  try {
    renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      log(`    Cross-device move detected, copying: ${basename(src)}`);
      cpSync(src, dest, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

function migrateProject(
  projectId: string,
  hashDirs: HashDirEntry[],
  aoBaseDir: string,
  dryRun: boolean,
  log: (message: string) => void,
): ProjectMigrationResult {
  const projectDir = join(aoBaseDir, "projects", projectId);
  const sessionsDir = join(projectDir, "sessions");
  const worktreesDir = join(projectDir, "worktrees");

  if (!dryRun) {
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(worktreesDir, { recursive: true });
  }

  const result: ProjectMigrationResult = {
    sessions: 0,
    worktrees: 0,
    workspaceMoves: [],
  };

  // Collect all sessions across hash dirs
  const allSessions = new Map<
    string,
    {
      metadata: Record<string, unknown>;
      sourcePath: string;
      /** 12-hex prefix of the source hash dir; needed to alias duplicates. */
      sourceHash: string;
      /** Set when this entry is a renamed duplicate that lost the canonical id. */
      renamedFrom?: string;
    }
  >();

  for (const hashDir of hashDirs) {
    const oldSessionsDir = join(hashDir.path, "sessions");
    if (!existsSync(oldSessionsDir)) continue;

    for (const file of readdirSync(oldSessionsDir)) {
      if (file === "archive" || file.startsWith(".")) continue;
      const filePath = join(oldSessionsDir, file);
      try {
        if (!statSync(filePath).isFile()) continue;
      } catch {
        continue;
      }

      // Strip .json extension if present
      const sessionId = file.endsWith(".json") ? file.slice(0, -5) : file;
      const metadata = readAndConvertMetadata(filePath);
      if (!metadata) {
        log(`  Warning: could not read metadata for ${sessionId} in ${hashDir.path}`);
        continue;
      }

      // Handle duplicate session IDs across hash dirs.
      //
      // The multi-hash bug this PR cleans up made it possible for two
      // unrelated `{hash}-{projectId}/sessions/` dirs to each carry an
      // independently-numbered `ao-N` for the same project. Silently
      // dropping the loser would lose work the user never marked
      // terminal. Instead, rename the loser to
      // `${sessionId}__from-${hash}` so both records survive in V2.
      // The renamed copy is still a valid V2 sessionId
      // (alphanum/underscore/hyphen) and never collides because the
      // hash prefix is unique per V1 dir. We pick a "winner" using
      // createdAt (newest first), then mtime, then path tiebreaker, so
      // the most recent record keeps the canonical id.
      const existing = allSessions.get(sessionId);
      if (existing) {
        const existingCreated = new Date(String(existing.metadata["createdAt"] ?? "")).getTime() || 0;
        const newCreated = new Date(String(metadata["createdAt"] ?? "")).getTime() || 0;
        const newIsNewer = newCreated > existingCreated
          || (newCreated === existingCreated && fileMtime(filePath) > fileMtime(existing.sourcePath))
          || (newCreated === existingCreated && fileMtime(filePath) === fileMtime(existing.sourcePath) && filePath > existing.sourcePath);

        if (newIsNewer) {
          // The new record wins the canonical id. Park the previous
          // entry under a hash-suffixed alias before replacing it.
          const loserHash = existing.sourceHash;
          const loserAlias = `${sessionId}__from-${loserHash}`;
          if (!allSessions.has(loserAlias)) {
            allSessions.set(loserAlias, {
              metadata: existing.metadata,
              sourcePath: existing.sourcePath,
              sourceHash: existing.sourceHash,
              renamedFrom: sessionId,
            });
            log?.(`  [rename] duplicate session ${sessionId} from hash ${loserHash} → ${loserAlias}`);
          } else {
            log?.(`  [warn] could not park duplicate ${sessionId} under ${loserAlias}: alias already taken`);
          }
          allSessions.set(sessionId, { metadata, sourcePath: filePath, sourceHash: hashDir.hash });
        } else {
          // The existing entry wins. Park THIS record under the alias.
          const loserAlias = `${sessionId}__from-${hashDir.hash}`;
          if (!allSessions.has(loserAlias)) {
            allSessions.set(loserAlias, {
              metadata,
              sourcePath: filePath,
              sourceHash: hashDir.hash,
              renamedFrom: sessionId,
            });
            log?.(`  [rename] duplicate session ${sessionId} from hash ${hashDir.hash} → ${loserAlias}`);
          } else {
            log?.(`  [warn] could not park duplicate ${sessionId} under ${loserAlias}: alias already taken`);
          }
        }
      } else {
        allSessions.set(sessionId, { metadata, sourcePath: filePath, sourceHash: hashDir.hash });
      }
    }

    // Flatten archives into sessions/ as terminated records
    const oldArchiveDir = join(oldSessionsDir, "archive");
    if (existsSync(oldArchiveDir)) {
      for (const archiveFile of readdirSync(oldArchiveDir)) {
        // Extract sessionId from archive filename: `{sessionId}_{timestamp}[.json]`.
        // Anchor on the timestamp suffix instead of a lazy prefix match —
        // a lazy `[a-zA-Z0-9_-]+?` stops at the first `_<digit>`, so a
        // session like `team_1-7` would be captured as `team` and the
        // archive would be flattened under the wrong sessionId, silently
        // overwriting another session's record.
        // Compact form: 20260420T143052Z. Legacy form: 2026-04-20T14:30:52.000Z
        // (the colon-and-dot legacy format predates the compact rewrite).
        const match = archiveFile.match(
          /^(.+)_(\d{8}T\d{6}Z|\d{4}-\d{2}-\d{2}T[\d:.-]+Z)(?:\.json)?$/,
        );
        if (!match?.[1]) continue;
        const archivedSessionId = match[1];

        // Skip if an active session with this ID already exists
        const targetPath = join(sessionsDir, `${archivedSessionId}.json`);
        if (existsSync(targetPath)) {
          log?.(`  [skip] archive ${archivedSessionId}: active session already exists`);
          continue;
        }

        if (dryRun) {
          result.sessions++;
          continue;
        }

        try {
          const content = readFileSync(join(oldArchiveDir, archiveFile), "utf-8").trim();
          if (!content) continue;

          let metadata: Record<string, unknown>;
          try {
            metadata = JSON.parse(content);
          } catch {
            // Legacy key=value format
            metadata = convertKeyValueToJson(content);
          }

          // Ensure terminated lifecycle state
          if (typeof metadata["lifecycle"] === "object" && metadata["lifecycle"] !== null) {
            const lifecycle = metadata["lifecycle"] as Record<string, unknown>;
            if (typeof lifecycle["session"] === "object" && lifecycle["session"] !== null) {
              const session = lifecycle["session"] as Record<string, string>;
              if (session["state"] !== "terminated" && session["state"] !== "done") {
                session["state"] = "terminated";
                session["reason"] = session["reason"] ?? "migrated_from_archive";
                session["terminatedAt"] = session["terminatedAt"] ?? new Date().toISOString();
              }
            }
          } else {
            // Flat metadata — set status directly
            metadata["status"] = metadata["status"] ?? "terminated";
          }

          atomicWriteFileSync(targetPath, JSON.stringify(metadata, null, 2) + "\n");
          result.sessions++;
        } catch (err) {
          log?.(`  [warn] failed to flatten archive ${archiveFile}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Migrate worktrees
    const oldWorktreesDir = join(hashDir.path, "worktrees");
    if (existsSync(oldWorktreesDir)) {
      for (const worktreeName of readdirSync(oldWorktreesDir)) {
        const srcWorktree = join(oldWorktreesDir, worktreeName);
        try {
          if (!statSync(srcWorktree).isDirectory()) continue;
        } catch {
          continue;
        }

        const destWorktree = join(worktreesDir, worktreeName);
        if (!existsSync(destWorktree) && !dryRun) {
          crossDeviceMove(srcWorktree, destWorktree, log);
        }
        result.worktrees++;
      }
    }
  }

  // Write all sessions to sessions/ (including orchestrators — runtime reads from sessions/)
  for (const [sessionId, { metadata, renamedFrom }] of allSessions) {
    // Renamed (loser-of-conflict) entries are preserved for inspection
    // only — their V1 worktree was clobbered by the canonical entry's
    // move (workspace dirs are keyed on the un-aliased sessionId). Keep
    // the metadata pointing at the V1 worktree path so the user can
    // still locate the original directory under its `.migrated` parent.
    if (
      !renamedFrom &&
      typeof metadata["worktree"] === "string" &&
      metadata["worktree"]
    ) {
      const oldWorktreePath = metadata["worktree"];
      const newWorktreePath = join(worktreesDir, sessionId);
      if (existsSync(newWorktreePath) || dryRun) {
        metadata["worktree"] = newWorktreePath;
        // Capture (old, new) so we can relink agent session storage later.
        // No-op when oldWorktreePath === newWorktreePath (rare, happens if
        // metadata was already pointing at the V2 path on a re-run).
        if (oldWorktreePath !== newWorktreePath) {
          result.workspaceMoves.push({
            oldWorkspacePath: oldWorktreePath,
            newWorkspacePath: newWorktreePath,
          });
        }
      }
      // Otherwise keep the original path — the worktree may be at ~/.worktrees/{projectId}/{sessionId}/
      // and will be moved by moveStrayWorktrees() later
    }

    if (!dryRun) {
      const destPath = join(sessionsDir, `${sessionId}.json`);
      atomicWriteFileSync(destPath, JSON.stringify(metadata, null, 2) + "\n");
    }
    result.sessions++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Git worktree repair — fix references broken by directory moves
// ---------------------------------------------------------------------------

/**
 * After moving worktree directories, git's internal references
 * (.git/worktrees/{id}/gitdir) still point to the old location.
 * Run `git worktree repair` from each project's repo root to fix them.
 */
async function repairGitWorktrees(aoBaseDir: string, globalConfigPath: string, log: (message: string) => void): Promise<void> {
  // Build projectId → repo path lookup from global config
  const repoPathByProject = new Map<string, string>();
  try {
    if (existsSync(globalConfigPath)) {
      const content = readFileSync(globalConfigPath, "utf-8");
      const parsed = parseYaml(content) as Record<string, unknown>;
      const projects = parsed?.["projects"] as Record<string, Record<string, unknown>> | undefined;
      if (projects && typeof projects === "object") {
        for (const [projectId, entry] of Object.entries(projects)) {
          if (entry && typeof entry["path"] === "string") {
            repoPathByProject.set(projectId, entry["path"]);
          }
        }
      }
    }
  } catch {
    // Config unreadable — skip repair
    return;
  }

  const projectsDir = join(aoBaseDir, "projects");
  if (!existsSync(projectsDir)) return;

  const { execSync } = await import("node:child_process");

  for (const projectId of readdirSync(projectsDir)) {
    const worktreesDir = join(projectsDir, projectId, "worktrees");
    if (!existsSync(worktreesDir)) continue;

    const repoPath = repoPathByProject.get(projectId);
    if (!repoPath || !existsSync(repoPath)) continue;

    try {
      execSync(`git worktree repair`, { cwd: repoPath, timeout: 10_000, stdio: "ignore" });
      log(`  Repaired git worktree references for ${projectId}`);
    } catch {
      log(`  Warning: git worktree repair failed for ${projectId} — run manually in ${repoPath}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Config update — strip storageKey
// ---------------------------------------------------------------------------

function stripStorageKeysFromConfig(configPath: string, dryRun: boolean, log: (message: string) => void): void {
  if (!existsSync(configPath)) return;

  const content = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(content) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") return;

  const projects = parsed["projects"] as Record<string, Record<string, unknown>> | undefined;
  if (!projects || typeof projects !== "object") return;

  let stripped = 0;
  for (const [, entry] of Object.entries(projects)) {
    if (entry && typeof entry === "object" && "storageKey" in entry) {
      delete entry["storageKey"];
      stripped++;
    }
  }

  if (stripped > 0) {
    log(`  Stripped storageKey from ${stripped} project(s) in config.`);
    if (!dryRun) {
      withFileLockSync(`${configPath}.lock`, () => {
        // Backup the config before modifying
        const backupPath = `${configPath}.pre-migration`;
        if (!existsSync(backupPath)) {
          atomicWriteFileSync(backupPath, content);
          log(`  Config backed up to ${basename(backupPath)}`);
        }
        atomicWriteFileSync(configPath, stringifyYaml(parsed, { indent: 2 }));
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Agent session storage relinking (Mode A fix for PR #1466)
// ---------------------------------------------------------------------------

/**
 * Encode a workspace path the way Claude Code does for `~/.claude/projects/`.
 * Mirrors `toClaudeProjectPath` in `agent-claude-code/src/index.ts`. Kept
 * in sync by hand — duplicating the function here avoids pulling the agent
 * plugin into core/migration just for this string transformation.
 */
function encodeClaudeProjectPath(workspacePath: string): string {
  return workspacePath
    .replace(/\\/g, "/")
    .replace(/:/g, "")
    .replace(/[/.]/g, "-");
}

/**
 * After `migrate-storage` moves a session's worktree from V1 to V2, Claude
 * Code's session JSONLs are still keyed by the encoded form of the OLD
 * workspace path, so `getRestoreCommand` looks up the new encoded path,
 * finds nothing, and the agent launches without chat history.
 *
 * Move each `~/.claude/projects/<encoded(old)>/` directory to
 * `<encoded(new)>/`. Skip when the source doesn't exist (no Claude history)
 * or the target already exists (manual reconciliation needed). Both paths
 * resolving to the same encoded string is a no-op.
 *
 * Returns the number of directories actually relinked.
 *
 * Codex stores its sessions date-sharded with the cwd embedded inside each
 * JSONL's `session_meta` line, so the same physical-rename trick doesn't
 * apply. Codex relinking is a separate follow-up — see PR #1466 thread.
 */
function relinkClaudeSessionStorage(
  moves: ReadonlyArray<WorkspacePathMove>,
  dryRun: boolean,
  log: (message: string) => void,
): number {
  if (moves.length === 0) return 0;

  const claudeProjectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(claudeProjectsDir)) return 0;

  let relinked = 0;
  for (const { oldWorkspacePath, newWorkspacePath } of moves) {
    const oldEncoded = encodeClaudeProjectPath(oldWorkspacePath);
    const newEncoded = encodeClaudeProjectPath(newWorkspacePath);
    if (oldEncoded === newEncoded) continue;

    const oldDir = join(claudeProjectsDir, oldEncoded);
    const newDir = join(claudeProjectsDir, newEncoded);

    if (!existsSync(oldDir)) continue; // no Claude history for this session — nothing to do
    if (existsSync(newDir)) {
      log(`  [skip] Claude session dir already exists at new path: ${newEncoded}`);
      continue;
    }

    if (dryRun) {
      log(`  [dry-run] Would relink Claude sessions: ${oldEncoded} → ${newEncoded}`);
      relinked++;
      continue;
    }

    try {
      renameSync(oldDir, newDir);
      log(`  Relinked Claude sessions: ${oldEncoded} → ${newEncoded}`);
      relinked++;
    } catch (err) {
      log(
        `  [warn] failed to relink Claude session dir ${oldEncoded}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return relinked;
}

/**
 * Codex stores rollouts at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and
 * embeds the working directory inside the very first JSONL record's
 * `session_meta` payload. The `agent-codex` plugin's restore lookup matches
 * `session_meta.cwd === session.workspacePath` exactly, so once
 * `migrate-storage` rewrites a session's `workspacePath` to the V2 layout,
 * Codex restore stops finding the prior thread and `getRestoreCommand`
 * returns null — the user loses chat history on `ao start` restore.
 *
 * For each (oldPath → newPath) move, scan rollout files, look at the first
 * non-empty parsed line, and if it is a `session_meta` entry whose
 * `payload.cwd` exactly matches `oldWorkspacePath`, rewrite that single line
 * to point at `newWorkspacePath`. Other lines are copied byte-for-byte. The
 * rewrite goes through an atomic temp-file rename so a crash mid-rewrite
 * cannot corrupt the rollout.
 *
 * Returns the number of rollout files actually rewritten.
 */
function rewriteCodexSessionStorage(
  moves: ReadonlyArray<WorkspacePathMove>,
  dryRun: boolean,
  log: (message: string) => void,
): number {
  if (moves.length === 0) return 0;

  const codexSessionsDir = join(homedir(), ".codex", "sessions");
  if (!existsSync(codexSessionsDir)) return 0;

  // Index moves by old path for O(1) lookup.
  const oldToNew = new Map<string, string>();
  for (const { oldWorkspacePath, newWorkspacePath } of moves) {
    if (oldWorkspacePath !== newWorkspacePath) {
      oldToNew.set(oldWorkspacePath, newWorkspacePath);
    }
  }
  if (oldToNew.size === 0) return 0;

  // Walk year/month/day shards collecting rollout-*.jsonl files.
  const jsonlFiles: string[] = [];
  function walk(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        jsonlFiles.push(full);
      }
    }
  }
  walk(codexSessionsDir);

  let rewritten = 0;
  for (const filePath of jsonlFiles) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    // Find the first parseable JSONL line. Codex writes session_meta as the
    // very first record so this is cheap; bail out after a small bounded
    // scan to avoid pathological cases.
    const newlineIdx = content.indexOf("\n");
    const firstLineEnd = newlineIdx === -1 ? content.length : newlineIdx;
    const firstLine = content.slice(0, firstLineEnd);
    if (!firstLine.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(firstLine);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const entry = parsed as { type?: string; payload?: { cwd?: unknown } };
    if (entry.type !== "session_meta") continue;
    const cwd = entry.payload?.cwd;
    if (typeof cwd !== "string") continue;

    const newCwd = oldToNew.get(cwd);
    if (!newCwd) continue;

    if (dryRun) {
      log(`  [dry-run] Would rewrite Codex session_meta cwd: ${filePath}`);
      log(`    ${cwd} → ${newCwd}`);
      rewritten++;
      continue;
    }

    // Mutate only the cwd field. Preserve insertion order and other payload
    // fields by editing the parsed object then re-serialising.
    (entry.payload as { cwd: string }).cwd = newCwd;
    const newFirstLine = JSON.stringify(entry);
    const rest = newlineIdx === -1 ? "" : content.slice(newlineIdx);
    try {
      atomicWriteFileSync(filePath, newFirstLine + rest);
      log(`  Rewrote Codex session_meta cwd in ${filePath}`);
      rewritten++;
    } catch (err) {
      log(
        `  [warn] failed to rewrite Codex session ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return rewritten;
}

// ---------------------------------------------------------------------------
// Stray worktree detection
// ---------------------------------------------------------------------------

/**
 * Try to move a single worktree directory to the matching project.
 * Returns true if matched and moved (or would be moved in dry-run).
 * Appends a (old, new) pair to `workspaceMoves` when a real move happens
 * so the caller can relink agent session storage afterwards.
 */
function tryMoveWorktree(
  sessionId: string,
  srcPath: string,
  projectsDir: string,
  dryRun: boolean,
  log: (message: string) => void,
  workspaceMoves: WorkspacePathMove[],
  skipProjects?: ReadonlySet<string>,
): boolean {
  for (const projectId of readdirSync(projectsDir)) {
    if (skipProjects?.has(projectId)) continue;
    const sessionsDir = join(projectsDir, projectId, "sessions");
    if (!existsSync(sessionsDir)) continue;

    const sessionFile = join(sessionsDir, `${sessionId}.json`);
    if (existsSync(sessionFile)) {
      const destPath = join(projectsDir, projectId, "worktrees", sessionId);
      if (!existsSync(destPath)) {
        log(`  Moving stray worktree ${sessionId} → projects/${projectId}/worktrees/`);
        if (srcPath !== destPath) {
          workspaceMoves.push({
            oldWorkspacePath: srcPath,
            newWorkspacePath: destPath,
          });
        }
        if (!dryRun) {
          mkdirSync(join(projectsDir, projectId, "worktrees"), { recursive: true });
          crossDeviceMove(srcPath, destPath, log);
          // Patch session JSON to point at the new worktree location
          try {
            const raw = readFileSync(sessionFile, "utf-8");
            const meta = JSON.parse(raw) as Record<string, unknown>;
            if (typeof meta["worktree"] === "string") {
              meta["worktree"] = destPath;
              atomicWriteFileSync(sessionFile, JSON.stringify(meta, null, 2) + "\n");
            }
          } catch {
            log(`  Warning: could not patch worktree path in ${sessionId}.json`);
          }
        }
        return true;
      }
    }
  }
  return false;
}

function moveStrayWorktrees(
  aoBaseDir: string,
  dryRun: boolean,
  log: (message: string) => void,
  workspaceMoves: WorkspacePathMove[],
  skipProjects?: ReadonlySet<string>,
): number {
  const strayDir = join(homedir(), ".worktrees");
  if (!existsSync(strayDir)) return 0;

  const projectsDir = join(aoBaseDir, "projects");
  if (!existsSync(projectsDir)) return 0;

  let moved = 0;
  for (const name of readdirSync(strayDir)) {
    const srcPath = join(strayDir, name);
    try {
      if (!statSync(srcPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // The default workspace plugin stores worktrees at ~/.worktrees/{projectId}/{sessionId}/.
    // Check if this entry is a projectId directory containing session worktrees.
    const children = readdirSync(srcPath);
    let isProjectDir = false;
    for (const child of children) {
      const childPath = join(srcPath, child);
      try {
        if (!statSync(childPath).isDirectory()) continue;
      } catch {
        continue;
      }
      // If any child matches a session in any project, treat parent as a projectId dir
      if (tryMoveWorktree(child, childPath, projectsDir, dryRun, log, workspaceMoves, skipProjects)) {
        moved++;
        isProjectDir = true;
      }
    }

    if (isProjectDir) {
      // Remove the now-empty projectId directory (if empty)
      if (!dryRun) {
        try {
          const remaining = readdirSync(srcPath);
          if (remaining.length === 0) {
            rmSync(srcPath, { recursive: true, force: true });
          }
        } catch {
          // Ignore — non-critical
        }
      }
      continue;
    }

    // Not a projectId directory — treat as a flat session worktree
    if (tryMoveWorktree(name, srcPath, projectsDir, dryRun, log, workspaceMoves, skipProjects)) {
      moved++;
    } else {
      log(`  Warning: stray worktree ${name} in ~/.worktrees/ has no matching session — left in place.`);
    }
  }

  return moved;
}

// ---------------------------------------------------------------------------
// Main migration entry point
// ---------------------------------------------------------------------------

export async function migrateStorage(options: MigrationOptions = {}): Promise<MigrationResult> {
  const aoBaseDir = options.aoBaseDir ?? join(homedir(), ".agent-orchestrator");
  const dryRun = options.dryRun ?? false;
  const log = options.log ?? console.log;
  const globalConfigPath = options.globalConfigPath ??
    join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "agent-orchestrator", "config.yaml");

  // Use the actual global config path if it exists at the standard location
  const effectiveConfigPath = existsSync(globalConfigPath)
    ? globalConfigPath
    : existsSync(join(aoBaseDir, "config.yaml"))
      ? join(aoBaseDir, "config.yaml")
      : globalConfigPath;

  if (dryRun) {
    log("DRY RUN — no changes will be made.\n");
  }

  // Crash-safety: detect incomplete previous migration
  const markerPath = join(aoBaseDir, MIGRATION_MARKER);
  if (existsSync(markerPath)) {
    log("WARNING: Previous migration was interrupted. Re-running — already-migrated directories will be skipped.\n");
  }

  // Pre-flight: detect active sessions (include V2 prefix patterns from config)
  if (!options.force && !dryRun) {
    const knownPrefixes = extractProjectPrefixes(effectiveConfigPath);
    const activeSessions = await detectActiveSessions(knownPrefixes);
    if (activeSessions.length > 0) {
      throw new Error(
        `Found ${activeSessions.length} active AO tmux session(s): ${activeSessions.slice(0, 5).join(", ")}${activeSessions.length > 5 ? "..." : ""}. ` +
        `Kill active sessions first (ao session kill --all) or use --force to migrate anyway.`,
      );
    }
  }

  // Write marker file before making any changes (removed on success)
  if (!dryRun) {
    writeFileSync(markerPath, new Date().toISOString());
  }

  // Inventory hash directories (pass config path for bare-hash projectId lookup)
  const hashDirs = inventoryHashDirs(aoBaseDir, effectiveConfigPath);
  if (hashDirs.length === 0) {
    log("No legacy hash-based directories found. Nothing to migrate.");
    if (!dryRun && existsSync(markerPath)) {
      try { unlinkSync(markerPath); } catch { /* best-effort */ }
    }
    return {
      projects: 0,
      sessions: 0,
      worktrees: 0,
      emptyDirsDeleted: 0,
      strayWorktreesMoved: 0,
      claudeSessionsRelinked: 0,
      codexSessionsRewritten: 0,
    };
  }

  log(`Found ${hashDirs.length} legacy director${hashDirs.length === 1 ? "y" : "ies"}.`);

  // Group by projectId
  const projectGroups = new Map<string, HashDirEntry[]>();
  for (const entry of hashDirs) {
    const group = projectGroups.get(entry.projectId) ?? [];
    group.push(entry);
    projectGroups.set(entry.projectId, group);
  }

  // Detect case-insensitive projectId collisions (macOS HFS+/APFS is case-insensitive)
  const lowerCaseIndex = new Map<string, string[]>();
  for (const projectId of projectGroups.keys()) {
    const lower = projectId.toLowerCase();
    const existing = lowerCaseIndex.get(lower) ?? [];
    existing.push(projectId);
    lowerCaseIndex.set(lower, existing);
  }
  for (const [lower, ids] of lowerCaseIndex) {
    if (ids.length > 1) {
      log(`\nWARNING: Case-insensitive collision detected for projectIds: ${ids.join(", ")} (resolve to "${lower}" on case-insensitive filesystems).`);
      log(`  Skipping colliding projects — rename them manually before re-running migration.`);
      for (const id of ids) {
        projectGroups.delete(id);
      }
    }
  }

  // Create projects/ directory
  if (!dryRun) {
    mkdirSync(join(aoBaseDir, "projects"), { recursive: true });
  }

  const totals: MigrationResult = {
    projects: 0,
    sessions: 0,
    worktrees: 0,
    emptyDirsDeleted: 0,
    strayWorktreesMoved: 0,
    claudeSessionsRelinked: 0,
    codexSessionsRewritten: 0,
  };

  // (oldWorkspacePath, newWorkspacePath) pairs collected across both
  // migration phases. Drives the agent-session-storage relink at the end.
  const allWorkspaceMoves: WorkspacePathMove[] = [];

  // Migrate each project
  const projectErrors: Array<{ projectId: string; error: string }> = [];
  for (const [projectId, dirs] of projectGroups) {
    const nonEmpty = dirs.filter((d) => !d.empty);
    if (nonEmpty.length === 0) {
      // All dirs are empty — just delete them
      for (const dir of dirs) {
        log(`  Deleting empty directory: ${basename(dir.path)}`);
        if (!dryRun) {
          rmSync(dir.path, { recursive: true, force: true });
        }
        totals.emptyDirsDeleted++;
      }
      continue;
    }

    log(`\nMigrating project: ${projectId} (${dirs.length} hash dir${dirs.length > 1 ? "s" : ""})`);

    try {
      const projectResult = migrateProject(projectId, dirs, aoBaseDir, dryRun, log);

      totals.projects++;
      totals.sessions += projectResult.sessions;
      totals.worktrees += projectResult.worktrees;
      allWorkspaceMoves.push(...projectResult.workspaceMoves);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ERROR migrating project ${projectId}: ${msg}`);
      projectErrors.push({ projectId, error: msg });
      continue;
    }

    // Rename old directories to .migrated
    for (const dir of dirs) {
      if (dir.empty) {
        log(`  Deleting empty directory: ${basename(dir.path)}`);
        if (!dryRun) {
          rmSync(dir.path, { recursive: true, force: true });
        }
        totals.emptyDirsDeleted++;
      } else {
        const migratedPath = `${dir.path}.migrated`;
        log(`  Renaming: ${basename(dir.path)} → ${basename(dir.path)}.migrated`);
        if (!dryRun) {
          try {
            renameSync(dir.path, migratedPath);
          } catch (err) {
            // .migrated target may already exist from a previous interrupted run
            if ((err as NodeJS.ErrnoException).code === "ENOTEMPTY" && existsSync(migratedPath)) {
              log(`  WARNING: ${basename(migratedPath)} already exists — removing source directory`);
              rmSync(dir.path, { recursive: true, force: true });
            } else {
              const msg = err instanceof Error ? err.message : String(err);
              log(`  ERROR: Failed to rename ${basename(dir.path)}: ${msg}`);
              projectErrors.push({
                projectId,
                error: `Failed to rename ${basename(dir.path)} to ${basename(migratedPath)}: ${msg}`,
              });
            }
          }
        }
      }
    }
  }

  // Move stray worktrees from ~/.worktrees/ (skip projects that failed migration)
  const failedProjects = new Set(projectErrors.map((e) => e.projectId));
  totals.strayWorktreesMoved = moveStrayWorktrees(
    aoBaseDir,
    dryRun,
    log,
    allWorkspaceMoves,
    failedProjects,
  );

  // Repair git worktree references broken by directory moves
  if (!dryRun && (totals.worktrees > 0 || totals.strayWorktreesMoved > 0)) {
    await repairGitWorktrees(aoBaseDir, effectiveConfigPath, log);
  }

  // Relink Claude Code session storage so chat history survives the
  // worktree-path change. Without this, ao start → restore launches a
  // fresh `claude` instance and the prior conversation is lost.
  totals.claudeSessionsRelinked = relinkClaudeSessionStorage(allWorkspaceMoves, dryRun, log);
  totals.codexSessionsRewritten = rewriteCodexSessionStorage(allWorkspaceMoves, dryRun, log);

  // Only strip storageKey and remove marker when ALL projects succeeded.
  // Partial failure leaves the marker and config intact so the migration
  // can be retried after fixing the failing project(s).
  if (projectErrors.length === 0) {
    log("\nUpdating config...");
    stripStorageKeysFromConfig(effectiveConfigPath, dryRun, log);
  } else {
    log("\nSkipping config update — some projects failed migration.");
  }

  // Summary
  log("\n--- Migration Summary ---");
  log(`Migrated ${totals.projects} project${totals.projects !== 1 ? "s" : ""}, ` +
    `${totals.sessions} session${totals.sessions !== 1 ? "s" : ""}, ` +
    `${totals.worktrees} worktree${totals.worktrees !== 1 ? "s" : ""}.`);
  if (totals.strayWorktreesMoved > 0) {
    log(`Moved ${totals.strayWorktreesMoved} stray worktree${totals.strayWorktreesMoved !== 1 ? "s" : ""} from ~/.worktrees/.`);
  }
  if (totals.claudeSessionsRelinked > 0) {
    log(`Relinked ${totals.claudeSessionsRelinked} Claude session director${totals.claudeSessionsRelinked !== 1 ? "ies" : "y"} to new worktree paths.`);
  }
  if (totals.codexSessionsRewritten > 0) {
    log(`Rewrote ${totals.codexSessionsRewritten} Codex rollout file${totals.codexSessionsRewritten !== 1 ? "s" : ""} to new worktree paths.`);
  }
  if (totals.emptyDirsDeleted > 0) {
    log(`Deleted ${totals.emptyDirsDeleted} empty director${totals.emptyDirsDeleted !== 1 ? "ies" : "y"}.`);
  }
  if (projectErrors.length > 0) {
    log(`\nFailed to migrate ${projectErrors.length} project${projectErrors.length !== 1 ? "s" : ""}:`);
    for (const { projectId, error } of projectErrors) {
      log(`  - ${projectId}: ${error}`);
    }
    log("Migration marker preserved — re-run after fixing the above errors.");
  } else {
    log("Old directories renamed to *.migrated — verify and rm -rf when ready.");
  }

  // Remove crash-safety marker only on full success
  if (!dryRun && existsSync(markerPath) && projectErrors.length === 0) {
    try { unlinkSync(markerPath); } catch { /* best-effort */ }
  }

  return totals;
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Count sessions in a V2 project dir that don't exist in any of the .migrated dirs.
 * These are sessions created after migration and would be lost by rollback.
 */
function countPostMigrationSessions(
  projectDir: string,
  migratedDirs: Array<{ path: string }>,
): number {
  const sessionsDir = join(projectDir, "sessions");
  if (!existsSync(sessionsDir)) return 0;

  // Collect all session IDs from .migrated dirs
  const migratedSessionIds = new Set<string>();
  for (const dir of migratedDirs) {
    const oldSessionsDir = join(dir.path, "sessions");
    if (!existsSync(oldSessionsDir)) continue;
    for (const file of readdirSync(oldSessionsDir)) {
      if (file === "archive" || file.startsWith(".")) continue;
      const sessionId = file.endsWith(".json") ? file.slice(0, -5) : file;
      migratedSessionIds.add(sessionId);
    }

    const oldArchiveDir = join(oldSessionsDir, "archive");
    if (!existsSync(oldArchiveDir)) continue;
    for (const file of readdirSync(oldArchiveDir)) {
      if (file.startsWith(".")) continue;
      // Same anchor-on-timestamp pattern as the archive flattening loop;
      // the lazy `[a-zA-Z0-9_-]+?_\d` mismatched any sessionId containing
      // `_<digit>` (e.g. `team_1-7`).
      const match = file.match(
        /^(.+)_(\d{8}T\d{6}Z|\d{4}-\d{2}-\d{2}T[\d:.-]+Z)(?:\.json)?$/,
      );
      if (match?.[1]) {
        migratedSessionIds.add(match[1]);
      }
    }
  }

  // Count sessions in V2 dir that aren't in any .migrated dir
  let count = 0;
  for (const file of readdirSync(sessionsDir)) {
    if (file === "archive" || file.startsWith(".")) continue;
    const sessionId = file.endsWith(".json") ? file.slice(0, -5) : file;
    if (!migratedSessionIds.has(sessionId)) {
      count++;
    }
  }

  return count;
}

function collectSessionIds(dirPath: string): Set<string> {
  const sessionIds = new Set<string>();
  const sessionsDir = join(dirPath, "sessions");
  if (!existsSync(sessionsDir)) return sessionIds;

  for (const file of readdirSync(sessionsDir)) {
    if (file === "archive" || file.startsWith(".")) continue;
    sessionIds.add(file.endsWith(".json") ? file.slice(0, -5) : file);
  }

  return sessionIds;
}

function resolveRollbackProjectId(aoBaseDir: string, migratedDirPath: string, hash: string): string {
  const derivedProjectId = deriveProjectIdFromDir(migratedDirPath);
  if (derivedProjectId) return derivedProjectId;

  const migratedSessionIds = collectSessionIds(migratedDirPath);
  if (migratedSessionIds.size === 0) return hash;

  const projectsDir = join(aoBaseDir, "projects");
  if (!existsSync(projectsDir)) return hash;

  for (const projectId of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, projectId);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const projectSessionIds = collectSessionIds(projectDir);
    for (const sessionId of migratedSessionIds) {
      if (projectSessionIds.has(sessionId)) return projectId;
    }
  }

  return hash;
}

export async function rollbackStorage(options: RollbackOptions = {}): Promise<void> {
  const aoBaseDir = options.aoBaseDir ?? join(homedir(), ".agent-orchestrator");
  const dryRun = options.dryRun ?? false;
  const log = options.log ?? console.log;
  const globalConfigPath = options.globalConfigPath ??
    join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "agent-orchestrator", "config.yaml");

  const effectiveConfigPath = existsSync(globalConfigPath)
    ? globalConfigPath
    : existsSync(join(aoBaseDir, "config.yaml"))
      ? join(aoBaseDir, "config.yaml")
      : globalConfigPath;

  if (dryRun) {
    log("DRY RUN — no changes will be made.\n");
  }

  if (!existsSync(aoBaseDir)) {
    log("No AO base directory found. Nothing to rollback.");
    return;
  }

  // Find .migrated directories (both {hash}-{name}.migrated and {hash}.migrated)
  const migratedDirs: Array<{ path: string; hash: string; projectId: string }> = [];
  for (const name of readdirSync(aoBaseDir)) {
    const hashNameMatch = MIGRATED_DIR_PATTERN.exec(name);
    const bareHashMatch = BARE_MIGRATED_DIR_PATTERN.exec(name);
    if (!hashNameMatch && !bareHashMatch) continue;

    const dirPath = join(aoBaseDir, name);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }

    if (hashNameMatch) {
      migratedDirs.push({
        path: dirPath,
        hash: hashNameMatch[1],
        projectId: hashNameMatch[2],
      });
    } else if (bareHashMatch) {
      migratedDirs.push({
        path: dirPath,
        hash: bareHashMatch[1],
        projectId: resolveRollbackProjectId(aoBaseDir, dirPath, bareHashMatch[1]),
      });
    }
  }

  if (migratedDirs.length === 0) {
    log("No .migrated directories found. Nothing to rollback.");
    return;
  }

  log(`Found ${migratedDirs.length} .migrated director${migratedDirs.length === 1 ? "y" : "ies"}.`);

  // Check for post-migration sessions BEFORE renaming .migrated dirs
  // (we need to read the .migrated dir contents to compare).
  const projectsDir = join(aoBaseDir, "projects");
  const safeToDeleteProjects = new Set<string>();
  const restoredProjects = new Set<string>();
  const migratedProjectIds = new Set(migratedDirs.map((d) => d.projectId));
  if (existsSync(projectsDir)) {
    for (const projectId of migratedProjectIds) {
      const projectDir = join(projectsDir, projectId);
      if (!existsSync(projectDir)) continue;

      const postMigrationSessions = countPostMigrationSessions(
        projectDir, migratedDirs.filter((d) => d.projectId === projectId),
      );
      if (postMigrationSessions > 0) {
        log(`  Warning: projects/${projectId} has ${postMigrationSessions} session(s) created after migration — skipping deletion.`);
        log(`    These sessions exist only in projects/${projectId}/ and would be lost. Remove manually after verifying.`);
      } else {
        safeToDeleteProjects.add(projectId);
      }
    }
  }

  // Rename .migrated back to original
  for (const dir of migratedDirs) {
    const originalPath = dir.path.replace(/\.migrated$/, "");
    if (existsSync(originalPath)) {
      log(`  Warning: ${basename(originalPath)} already exists — skipping restore of ${basename(dir.path)}. Resolve manually.`);
      safeToDeleteProjects.delete(dir.projectId);
      continue;
    }
    log(`  Restoring: ${basename(dir.path)} → ${basename(originalPath)}`);
    if (!dryRun) {
      renameSync(dir.path, originalPath);
    }
    restoredProjects.add(dir.projectId);
  }

  // Move worktrees back to restored hash dirs, then remove project directories
  let rollbackWorktreesMoved = false;
  // (V2 → V1) pairs collected so we can reverse the Claude session-storage
  // relink that the forward migration performed.
  const rollbackWorkspaceMoves: WorkspacePathMove[] = [];
  if (existsSync(projectsDir)) {
    for (const projectId of safeToDeleteProjects) {
      if (!restoredProjects.has(projectId)) continue;
      const projectDir = join(projectsDir, projectId);
      if (!existsSync(projectDir)) continue;

      // Move worktrees back before deleting the project directory.
      // If multiple hash dirs existed for this project, consolidate worktrees into the
      // first restored hash dir. The original hash→worktree mapping is lost after
      // forward migration (worktrees were merged), so this is best-effort.
      const v2WorktreesDir = join(projectDir, "worktrees");
      if (existsSync(v2WorktreesDir)) {
        const projectMigratedDirs = migratedDirs.filter((d) => d.projectId === projectId);
        const targetHashDir = projectMigratedDirs[0]
          ? projectMigratedDirs[0].path.replace(/\.migrated$/, "")
          : null;
        if (targetHashDir && existsSync(targetHashDir)) {
          const oldWorktreesDir = join(targetHashDir, "worktrees");
          if (!dryRun) mkdirSync(oldWorktreesDir, { recursive: true });
          for (const wt of readdirSync(v2WorktreesDir)) {
            const src = join(v2WorktreesDir, wt);
            const dest = join(oldWorktreesDir, wt);
            if (!existsSync(dest)) {
              log(`  Moving worktree back: projects/${projectId}/worktrees/${wt} → ${basename(targetHashDir)}/worktrees/${wt}`);
              if (!dryRun) crossDeviceMove(src, dest, log);
              rollbackWorktreesMoved = true;
              // For Claude relink-reverse: source dir's encoded path moves
              // back to the destination's encoded path.
              rollbackWorkspaceMoves.push({
                oldWorkspacePath: src,
                newWorkspacePath: dest,
              });
            }
          }
        }
      }
    }

    // Repair git worktree references broken by moving worktrees back
    if (!dryRun && rollbackWorktreesMoved) {
      await repairGitWorktrees(aoBaseDir, effectiveConfigPath, log);
    }

    // Reverse the Claude session-storage relink so chat history follows
    // the worktree back to its V1 encoded path.
    relinkClaudeSessionStorage(rollbackWorkspaceMoves, dryRun, log);
    // Reverse the Codex session_meta cwd rewrite so Codex restore lookup
    // continues to find threads after rollback.
    rewriteCodexSessionStorage(rollbackWorkspaceMoves, dryRun, log);

    // Remove project directories that are safe to delete
    for (const projectId of safeToDeleteProjects) {
      if (!restoredProjects.has(projectId)) continue;
      const projectDir = join(projectsDir, projectId);
      if (!existsSync(projectDir)) continue;

      log(`  Removing migrated project directory: projects/${projectId}`);
      if (!dryRun) {
        rmSync(projectDir, { recursive: true, force: true });
      }
    }

    // Remove projects/ only if it's now empty
    if (!dryRun) {
      try {
        const remaining = readdirSync(projectsDir);
        if (remaining.length === 0) {
          rmSync(projectsDir, { recursive: true, force: true });
        } else {
          log(`  Note: projects/ retained — contains ${remaining.length} non-migrated project(s).`);
        }
      } catch {
        // Ignore
      }
    }
  }

  // Re-add storageKey to config.
  if (existsSync(effectiveConfigPath)) {
    const content = readFileSync(effectiveConfigPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      const projects = parsed["projects"] as Record<string, Record<string, unknown>> | undefined;
      if (projects && typeof projects === "object") {
        let restored = 0;
        for (const dir of migratedDirs) {
          const entry = projects[dir.projectId];
          if (entry && typeof entry === "object") {
            const originalDirName = basename(dir.path).replace(/\.migrated$/, "");
            entry["storageKey"] = originalDirName;
            restored++;
          }
        }
        if (restored > 0) {
          log(`  Restored storageKey for ${restored} project(s) in config.`);
          if (!dryRun) {
            writeFileSync(effectiveConfigPath, stringifyYaml(parsed, { indent: 2 }));
          }
        }
      }
    }
  }

  log("\nRollback complete. Old hash-based directories restored.");
}
