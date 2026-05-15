/**
 * Session Manager — CRUD for agent sessions.
 *
 * Orchestrates Runtime, Agent, and Workspace plugins to:
 * - Spawn new sessions (create workspace → create runtime → launch agent)
 * - List sessions (from metadata + live runtime checks)
 * - Kill sessions (agent → runtime → workspace cleanup)
 * - Cleanup completed sessions (PR merged / issue closed)
 * - Send messages to running sessions
 *
 * Reference: scripts/claude-ao-session, scripts/send-to-session
 */

import { statSync, existsSync, writeFileSync, mkdirSync, utimesSync, unlinkSync } from "node:fs";
import { recordActivityEvent } from "./activity-events.js";
import { execFile } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  isIssueNotFoundError,
  isRestorable,
  isTerminalSession,
  NON_RESTORABLE_STATUSES,
  SessionNotFoundError,
  SessionNotRestorableError,
  WorkspaceMissingError,
  type OpenCodeSessionManager,
  type Session,
  type SessionId,
  type SessionSpawnConfig,
  type OrchestratorSpawnConfig,
  type CleanupResult,
  type ClaimPROptions,
  type ClaimPRResult,
  type KillOptions,
  type KillResult,
  type LifecycleKillReason,
  type OrchestratorConfig,
  type ProjectConfig,
  type Runtime,
  type Agent,
  type Workspace,
  type WorkspaceCreateConfig,
  type Tracker,
  type SCM,
  type PluginRegistry,
  type RuntimeHandle,
  type Issue,
  type CanonicalSessionLifecycle,
  PR_STATE,
} from "./types.js";
import {
  readMetadataRaw,
  writeMetadata,
  updateMetadata,
  applyMetadataUpdates,
  mutateMetadata,
  deleteMetadata,
  listMetadata,
  reserveSessionId,
} from "./metadata.js";
import {
  buildLifecycleMetadataPatch,
  clearTerminalMarkersForNonTerminalState,
  cloneLifecycle,
  createInitialCanonicalLifecycle,
  deriveLegacyStatus,
  parseCanonicalLifecycle,
} from "./lifecycle-state.js";
import { buildPrompt } from "./prompt-builder.js";
import { classifyActivitySignal, createActivitySignal } from "./activity-signal.js";
import {
  getProjectSessionsDir,
  getProjectWorktreesDir,
  getProjectDir,
  generateSessionName,
} from "./paths.js";
import { asValidOpenCodeSessionId } from "./opencode-session-id.js";
import {
  getCachedOpenCodeSessionList,
  getOpenCodeChildEnv,
  invalidateOpenCodeSessionListCache,
  resetOpenCodeSessionListCache as resetSharedOpenCodeSessionListCache,
  type OpenCodeSessionListEntry,
} from "./opencode-shared.js";
import { writeWorkspaceOpenCodeAgentsMd } from "./opencode-agents-md.js";
import { writeOpenCodeConfig } from "./opencode-config.js";
import { CleanupStack } from "./cleanup-stack.js";
import {
  getOrchestratorSessionId,
  normalizeOrchestratorSessionStrategy,
} from "./orchestrator-session-strategy.js";
import { sessionFromMetadata } from "./utils/session-from-metadata.js";
import { safeJsonParse, validateStatus } from "./utils/validation.js";
import { isGitBranchNameSafe } from "./utils.js";
import { resolveAgentSelection, resolveSessionRole } from "./agent-selection.js";
import {
  buildAgentPath,
  setupPathWrapperWorkspace,
  PREFERRED_GH_PATH,
} from "./agent-workspace-hooks.js";

const execFileAsync = promisify(execFile);
const OPENCODE_DISCOVERY_TIMEOUT_MS = 10_000;
const OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS = 10_000;
// On Windows, execFile cannot resolve .cmd shim extensions without invoking the shell.
// windowsHide:true suppresses the conhost popup that the shell would otherwise flash.
const EXEC_SHELL_OPTION =
  process.platform === "win32" ? ({ shell: true, windowsHide: true } as const) : ({} as const);


function errorIncludesSessionNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { stderr?: string; stdout?: string };
  const combined = [err.message, e.stderr, e.stdout].filter(Boolean).join("\n");
  return /session not found/i.test(combined);
}

async function deleteOpenCodeSession(sessionId: string): Promise<void> {
  const validatedSessionId = asValidOpenCodeSessionId(sessionId);
  if (!validatedSessionId) return;
  const retryDelaysMs = [0, 200, 600];
  let lastError: unknown;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      await execFileAsync("opencode", ["session", "delete", validatedSessionId], {
        timeout: 30_000,
        ...EXEC_SHELL_OPTION,
        env: getOpenCodeChildEnv(),
      });
      // Drop cached list immediately so reuse / remap / restore call sites
      // do not observe the deleted id for the remainder of the TTL window.
      invalidateOpenCodeSessionListCache();
      return;
    } catch (err) {
      if (errorIncludesSessionNotFound(err)) {
        invalidateOpenCodeSessionListCache();
        return;
      }
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Re-export so existing core test-utils + session-manager call sites keep working. */
export function resetOpenCodeSessionListCache(): void {
  resetSharedOpenCodeSessionListCache();
}

async function fetchOpenCodeSessionList(
  timeoutMs: number = OPENCODE_DISCOVERY_TIMEOUT_MS,
): Promise<OpenCodeSessionListEntry[]> {
  return getCachedOpenCodeSessionList({ timeoutMs });
}

async function discoverOpenCodeSessionIdsByTitle(
  sessionId: string,
  timeoutMs = OPENCODE_DISCOVERY_TIMEOUT_MS,
  sessionListPromise?: Promise<OpenCodeSessionListEntry[]>,
): Promise<string[]> {
  const sessions = await (sessionListPromise ?? fetchOpenCodeSessionList(timeoutMs));
  const title = `AO:${sessionId}`;
  return sessions
    .filter((entry) => entry.title === title)
    .sort((a, b) => {
      const ta = a.updatedAt ?? -Infinity;
      const tb = b.updatedAt ?? -Infinity;
      if (ta === tb) return 0;
      return tb - ta;
    })
    .map((entry) => entry.id);
}

async function discoverOpenCodeSessionIdByTitle(
  sessionId: string,
  timeoutMs?: number,
  sessionListPromise?: Promise<OpenCodeSessionListEntry[]>,
): Promise<string | undefined> {
  const matches = await discoverOpenCodeSessionIdsByTitle(sessionId, timeoutMs, sessionListPromise);
  return matches[0];
}

/** Escape regex metacharacters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Get the next session number for a project. */
function getNextSessionNumber(existingSessions: string[], prefix: string): number {
  let max = 0;
  const pattern = new RegExp(`^${escapeRegex(prefix)}-(\\d+)$`);
  for (const name of existingSessions) {
    const match = name.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return max + 1;
}

function getSessionNumber(sessionId: string, prefix: string): number | undefined {
  const match = sessionId.match(new RegExp(`^${escapeRegex(prefix)}-(\\d+)$`));
  if (!match) return undefined;

  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

const PR_TRACKING_STATUSES: ReadonlySet<string> = new Set([
  "pr_open",
  "ci_failed",
  "review_pending",
  "changes_requested",
  "approved",
  "mergeable",
]);

const STALE_PR_OWNERSHIP_STATUSES: ReadonlySet<string> = new Set([
  ...PR_TRACKING_STATUSES,
  "merged",
]);

/**
 * Maximum length for the `displayName` metadata field.
 * Long enough to express intent ("Refactor session manager to use flat metadata files")
 * without overflowing kanban cards and tabs in the dashboard.
 */
const DISPLAY_NAME_MAX_LENGTH = 80;

/**
 * Derive a human-readable display name from any available task context.
 *
 * Priority:
 *   1. Issue title (always the best signal when present)
 *   2. First meaningful line of a freeform prompt
 *
 * The result is trimmed, collapsed to single-line, and truncated to
 * {@link DISPLAY_NAME_MAX_LENGTH} characters (with an ellipsis).
 * Returns `undefined` when no usable context exists so callers can skip
 * writing the field entirely.
 */
function deriveDisplayName(input: { issueTitle?: string; prompt?: string }): string | undefined {
  const pickLine = (text: string): string => {
    const line = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return line ?? "";
  };

  const truncate = (text: string): string => {
    const collapsed = text.replace(/\s+/g, " ").trim();
    // Split on code points so emoji / astral characters aren't cleaved into
    // lone UTF-16 surrogates at the truncation boundary.
    const codePoints = Array.from(collapsed);
    if (codePoints.length <= DISPLAY_NAME_MAX_LENGTH) return collapsed;
    // Leave room for the ellipsis character.
    return `${codePoints
      .slice(0, DISPLAY_NAME_MAX_LENGTH - 1)
      .join("")
      .trimEnd()}…`;
  };

  if (input.issueTitle && input.issueTitle.trim()) {
    return truncate(input.issueTitle);
  }

  if (input.prompt && input.prompt.trim()) {
    const line = pickLine(input.prompt);
    if (line) return truncate(line);
  }

  return undefined;
}

const SEND_RESTORE_READY_TIMEOUT_MS = 5_000;
const SEND_RESTORE_READY_POLL_MS = 500;
const SEND_CONFIRMATION_ATTEMPTS = 6;
const SEND_CONFIRMATION_POLL_MS = 500;
const SEND_CONFIRMATION_OUTPUT_LINES = 20;
const SEND_BOOTSTRAP_READY_TIMEOUT_MS = 20_000;
const SEND_BOOTSTRAP_STABLE_POLLS = 2;
const ENSURE_ORCHESTRATOR_CONFLICT_WAIT_MS = 20_000;
const ENSURE_ORCHESTRATOR_CONFLICT_POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isAgentProcessNotDefinitelyMissing(
  agent: Agent,
  handle: RuntimeHandle,
): Promise<boolean> {
  try {
    return (await agent.isProcessRunning(handle)) !== false;
  } catch {
    // Send/restore readiness should only block on a definitive "process missing"
    // verdict. Probe failures are no verdict, so keep waiting or fall back to
    // terminal output instead of forcing a restore.
    return true;
  }
}

function isFixedOrchestratorReservationError(err: unknown, sessionId: string): boolean {
  return err instanceof Error && err.message.includes(`Orchestrator session "${sessionId}" already exists`);
}

async function getTmuxForegroundCommand(sessionName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["display-message", "-p", "-t", sessionName, "#{pane_current_command}"],
      { timeout: 5_000, windowsHide: true },
    );
    const command = stdout.trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}

/** Parse lifecycle from raw metadata for writeMetadata (restore path). */
function parseLifecycleFromRaw(
  raw: Record<string, string>,
): CanonicalSessionLifecycle | undefined {
  const source = raw["lifecycle"] ?? raw["statePayload"];
  if (!source) return undefined;
  try {
    return JSON.parse(source) as CanonicalSessionLifecycle;
  } catch {
    return undefined;
  }
}

/** Reconstruct a Session object from raw metadata key=value pairs. */
function metadataToSession(
  sessionId: SessionId,
  meta: Record<string, string>,
  projectId: string,
  sessionPrefix?: string,
  createdAt?: Date,
  modifiedAt?: Date,
): Session {
  const sessionKind =
    meta["role"] === "orchestrator" ||
    (sessionPrefix
      ? new RegExp(`^${escapeRegex(sessionPrefix)}-orchestrator-\\d+$`).test(sessionId)
      : false)
      ? "orchestrator"
      : "worker";
  return sessionFromMetadata(sessionId, meta, {
    projectId,
    sessionKind,
    createdAt,
    lastActivityAt: modifiedAt ?? new Date(),
  });
}

export interface SessionManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
}

/** Create a SessionManager instance. */
export function createSessionManager(deps: SessionManagerDeps): OpenCodeSessionManager {
  const { config, registry } = deps;

  interface LocatedSession {
    raw: Record<string, string>;
    sessionsDir: string;
    project: ProjectConfig;
    projectId: string;
  }

  interface ActiveSessionRecord {
    sessionName: string;
    raw: Record<string, string>;
    modifiedAt?: Date;
  }

  function normalizePath(path: string): string {
    return resolve(path).replace(/[/\\]$/, "");
  }

  function isPathInside(path: string, parentPath: string): boolean {
    const normalizedPath = normalizePath(path);
    const normalizedParent = normalizePath(parentPath);
    const sep = process.platform === "win32" ? "\\" : "/";
    return (
      normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}${sep}`)
    );
  }

  function getManagedWorkspaceRoots(projectId: string, projectPath: string): string[] {
    const roots = [getProjectWorktreesDir(projectId)];
    // Legacy: some worktrees live under ~/.worktrees/{basename}
    const legacyIds = new Set<string>();
    legacyIds.add(projectId);
    legacyIds.add(basename(projectPath));

    for (const id of legacyIds) {
      roots.push(join(homedir(), ".worktrees", id));
    }

    return roots;
  }

  function shouldDestroyWorkspacePath(
    project: ProjectConfig | undefined,
    projectId: string | undefined,
    workspacePath: string,
  ): boolean {
    if (!project || !projectId) return false;
    if (normalizePath(workspacePath) === normalizePath(project.path)) return false;

    const roots = getManagedWorkspaceRoots(projectId, project.path);
    return roots.some((root) => isPathInside(workspacePath, root));
  }

  function isOrchestratorSessionRecord(
    sessionId: string,
    raw: Record<string, string> | null | undefined,
    sessionPrefix?: string,
  ): boolean {
    if (!raw) return false;
    if (raw["role"] === "orchestrator") return true;
    // Check the -orchestrator-N pattern only when the prefix is known so the
    // regex is anchored to the project prefix, preventing false-positives when
    // the user-configured sessionPrefix itself ends with "-orchestrator".
    if (sessionPrefix) {
      if (sessionId === `${sessionPrefix}-orchestrator`) {
        return true;
      }
      return new RegExp(`^${escapeRegex(sessionPrefix)}-orchestrator-\\d+$`).test(sessionId);
    }
    return false;
  }

  function isCleanupProtectedSession(
    project: ProjectConfig,
    sessionId: string,
    metadata?: Record<string, string> | null,
  ): boolean {
    if (sessionId === `${project.sessionPrefix}-orchestrator`) {
      return true;
    }
    return isOrchestratorSessionRecord(sessionId, metadata ?? {}, project.sessionPrefix);
  }

  function requiresNativeRestore(agentName: string): boolean {
    // kimicode is intentionally excluded: kimi's session dir only exists if the
    // previous launch ran far enough to write to ~/.kimi/sessions. A failed
    // launch (e.g. the --agent-file YAML crash) leaves no session to resume,
    // and falling back to a fresh getLaunchCommand is the only sensible choice.
    return (
      agentName === "claude-code" ||
      agentName === "codex" ||
      agentName === "opencode"
    );
  }

  function applyMetadataUpdatesToRaw(
    raw: Record<string, string>,
    updates: Partial<Record<string, string>>,
  ): Record<string, string> {
    let next = { ...raw };
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      if (value === "") {
        const { [key]: _removed, ...rest } = next;
        void _removed;
        next = rest;
        continue;
      }
      next[key] = value;
    }
    return next;
  }

  function buildUpdatedLifecycle(
    sessionId: string,
    raw: Record<string, string>,
    updater: (lifecycle: ReturnType<typeof parseCanonicalLifecycle>) => void,
  ) {
    const lifecycle = cloneLifecycle(
      parseCanonicalLifecycle(raw, {
        sessionId,
        status: validateStatus(raw["status"]),
      }),
    );
    updater(lifecycle);
    clearTerminalMarkersForNonTerminalState(lifecycle);
    return lifecycle;
  }

  function lifecycleMetadataUpdates(
    raw: Record<string, string>,
    lifecycle: ReturnType<typeof parseCanonicalLifecycle>,
  ): Partial<Record<string, string>> {
    return buildLifecycleMetadataPatch(lifecycle);
  }

  function updateMetadataPreservingMtime(
    sessionsDir: string,
    sessionName: string,
    updates: Partial<Record<string, string>>,
    modifiedAt?: Date,
  ): void {
    const metaPath = join(sessionsDir, `${sessionName}.json`);
    let preservedMtime = modifiedAt;
    if (!preservedMtime) {
      try {
        preservedMtime = statSync(metaPath).mtime;
      } catch {
        preservedMtime = undefined;
      }
    }

    updateMetadata(sessionsDir, sessionName, updates);

    if (!preservedMtime) return;
    try {
      utimesSync(metaPath, preservedMtime, preservedMtime);
    } catch {
      void 0;
    }
  }

  const SESSION_CACHE_TTL_MS = 35_000;
  let sessionCache: {
    sessions: Session[];
    expiresAt: number;
  } | null = null;
  const ensureOrchestratorPromises = new Map<string, Promise<Session>>();

  function invalidateCache(): void {
    sessionCache = null;
  }

  function repairSingleSessionMetadataOnRead(
    sessionsDir: string,
    record: ActiveSessionRecord,
    sessionPrefix?: string,
  ): ActiveSessionRecord {
    const repaired = { ...record, raw: { ...record.raw } };
    if (!isOrchestratorSessionRecord(repaired.sessionName, repaired.raw, sessionPrefix)) {
      return repaired;
    }

    const updates: Partial<Record<string, string>> = {};
    if (repaired.raw["role"] !== "orchestrator") {
      updates["role"] = "orchestrator";
    }
    if (repaired.raw["pr"]) {
      updates["pr"] = "";
    }
    if (repaired.raw["prAutoDetect"] !== "off" && repaired.raw["prAutoDetect"] !== "false") {
      updates["prAutoDetect"] = "false";
    }
    if (STALE_PR_OWNERSHIP_STATUSES.has(repaired.raw["status"] ?? "")) {
      updates["status"] = "working";
    }

    if (Object.keys(updates).length > 0) {
      const lifecycle = buildUpdatedLifecycle(repaired.sessionName, repaired.raw, (next) => {
        next.session.kind = "orchestrator";
        next.pr.state = "none";
        next.pr.reason = "not_created";
        next.pr.number = null;
        next.pr.url = null;
        next.pr.lastObservedAt = null;
        if (updates["status"] === "working") {
          next.session.state = "working";
          next.session.reason = "task_in_progress";
        }
      });
      updateMetadataPreservingMtime(
        sessionsDir,
        repaired.sessionName,
        { ...updates, ...lifecycleMetadataUpdates(repaired.raw, lifecycle) },
        repaired.modifiedAt,
      );
      repaired.raw = applyMetadataUpdatesToRaw(repaired.raw, {
        ...updates,
        ...lifecycleMetadataUpdates(repaired.raw, lifecycle),
      });
    }

    return repaired;
  }

  function sessionMetadataTimestamp(record: ActiveSessionRecord): number {
    const metadataTimestamp = Date.parse(record.raw["restoredAt"] ?? record.raw["createdAt"] ?? "");
    if (record.modifiedAt) return record.modifiedAt.getTime();
    return Number.isNaN(metadataTimestamp) ? 0 : metadataTimestamp;
  }

  function repairSessionMetadataOnRead(
    sessionsDir: string,
    records: ActiveSessionRecord[],
    sessionPrefix?: string,
  ): ActiveSessionRecord[] {
    const repaired = records.map((record) => ({ ...record, raw: { ...record.raw } }));
    const duplicatePRAttachments = new Map<string, ActiveSessionRecord[]>();

    for (const record of repaired) {
      if (!record.raw["lifecycle"] && (!record.raw["statePayload"] || record.raw["stateVersion"] !== "2")) {
        const lifecycle = cloneLifecycle(
          parseCanonicalLifecycle(record.raw, {
            sessionId: record.sessionName,
            status: validateStatus(record.raw["status"]),
            createdAt: record.raw["createdAt"] ? new Date(record.raw["createdAt"]) : undefined,
            sessionKind: isOrchestratorSessionRecord(record.sessionName, record.raw, sessionPrefix)
              ? "orchestrator"
              : "worker",
          }),
        );
        const canonicalUpdates = lifecycleMetadataUpdates(record.raw, lifecycle);
        updateMetadataPreservingMtime(
          sessionsDir,
          record.sessionName,
          canonicalUpdates,
          record.modifiedAt,
        );
        record.raw = applyMetadataUpdatesToRaw(record.raw, canonicalUpdates);
      }

      if (isOrchestratorSessionRecord(record.sessionName, record.raw, sessionPrefix)) {
        record.raw = repairSingleSessionMetadataOnRead(sessionsDir, record, sessionPrefix).raw;
        continue;
      }

      const prUrl = record.raw["pr"];
      if (!prUrl) continue;

      const attached = duplicatePRAttachments.get(prUrl) ?? [];
      attached.push(record);
      duplicatePRAttachments.set(prUrl, attached);
    }

    for (const attachedRecords of duplicatePRAttachments.values()) {
      if (attachedRecords.length < 2) continue;

      const [owner, ...staleRecords] = [...attachedRecords].sort((a, b) => {
        const trackingDiff =
          Number(PR_TRACKING_STATUSES.has(b.raw["status"] ?? "")) -
          Number(PR_TRACKING_STATUSES.has(a.raw["status"] ?? ""));
        if (trackingDiff !== 0) return trackingDiff;

        const timestampDiff = sessionMetadataTimestamp(b) - sessionMetadataTimestamp(a);
        if (timestampDiff !== 0) return timestampDiff;

        return b.sessionName.localeCompare(a.sessionName);
      });

      void owner;

      for (const record of staleRecords) {
        const updates: Partial<Record<string, string>> = {
          pr: "",
          prAutoDetect: "false",
          ...(PR_TRACKING_STATUSES.has(record.raw["status"] ?? "") ? { status: "working" } : {}),
        };
        const lifecycle = buildUpdatedLifecycle(record.sessionName, record.raw, (next) => {
          next.pr.state = "none";
          next.pr.reason = "not_created";
          next.pr.number = null;
          next.pr.url = null;
          next.pr.lastObservedAt = null;
          if (updates["status"] === "working") {
            next.session.state = "working";
            next.session.reason = "task_in_progress";
          }
        });
        const lifecycleUpdates = lifecycleMetadataUpdates(record.raw, lifecycle);
        updateMetadataPreservingMtime(
          sessionsDir,
          record.sessionName,
          { ...updates, ...lifecycleUpdates },
          record.modifiedAt,
        );
        record.raw = applyMetadataUpdatesToRaw(record.raw, { ...updates, ...lifecycleUpdates });
      }
    }

    return repaired;
  }

  function loadActiveSessionRecords(projectId: string, project: ProjectConfig): ActiveSessionRecord[] {
    const sessionsDir = getProjectSessionsDir(projectId);
    if (!existsSync(sessionsDir)) return [];

    const records = listMetadata(sessionsDir).flatMap((sessionName) => {
      const raw = readMetadataRaw(sessionsDir, sessionName);
      if (!raw) return [];

      let modifiedAt: Date | undefined;
      try {
        modifiedAt = statSync(join(sessionsDir, `${sessionName}.json`)).mtime;
      } catch {
        void 0;
      }

      return [{ sessionName, raw, modifiedAt } satisfies ActiveSessionRecord];
    });

    return repairSessionMetadataOnRead(sessionsDir, records, project.sessionPrefix);
  }

  function sortSessionIdsForReuse(ids: string[]): string[] {
    const numericSuffix = (id: string): number | undefined => {
      const match = id.match(/-(\d+)$/);
      if (!match) return undefined;
      const parsed = Number.parseInt(match[1], 10);
      return Number.isNaN(parsed) ? undefined : parsed;
    };

    return [...ids].sort((a, b) => {
      const aNum = numericSuffix(a);
      const bNum = numericSuffix(b);
      if (aNum !== undefined && bNum !== undefined && aNum !== bNum) {
        return bNum - aNum;
      }
      if (aNum !== undefined && bNum === undefined) return -1;
      if (aNum === undefined && bNum !== undefined) return 1;
      return b.localeCompare(a);
    });
  }

  function findOpenCodeSessionIds(
    sessionsDir: string,
    criteria: { issueId?: string; sessionId?: string },
  ): string[] {
    const matchesCriteria = (id: string, raw: Record<string, string> | null): boolean => {
      if (!raw) return false;
      if (raw["agent"] !== "opencode") return false;
      if (criteria.issueId !== undefined && raw["issue"] !== criteria.issueId) return false;
      if (criteria.sessionId !== undefined && id !== criteria.sessionId) return false;
      return true;
    };

    const ids: string[] = [];
    const maybeAdd = (id: string, raw: Record<string, string> | null) => {
      if (!matchesCriteria(id, raw)) return;
      const mapped = asValidOpenCodeSessionId(raw?.["opencodeSessionId"]);
      if (!mapped) return;
      ids.push(mapped);
    };

    for (const id of sortSessionIdsForReuse(listMetadata(sessionsDir))) {
      maybeAdd(id, readMetadataRaw(sessionsDir, id));
    }

    return [...new Set(ids)];
  }

  async function resolveOpenCodeSessionReuse(options: {
    sessionsDir: string;
    criteria: { issueId?: string; sessionId?: string };
    strategy: "reuse" | "delete" | "ignore";
    includeTitleDiscoveryForSessionId?: boolean;
  }): Promise<string | undefined> {
    const { sessionsDir, criteria, strategy, includeTitleDiscoveryForSessionId = false } = options;
    if (strategy === "ignore") return undefined;

    let candidateIds = findOpenCodeSessionIds(sessionsDir, criteria);

    if (strategy === "delete") {
      if (includeTitleDiscoveryForSessionId && criteria.sessionId) {
        candidateIds = [
          ...candidateIds,
          ...(await discoverOpenCodeSessionIdsByTitle(criteria.sessionId)),
        ];
      }

      for (const openCodeSessionId of [...new Set(candidateIds)]) {
        await deleteOpenCodeSession(openCodeSessionId);
      }
      return undefined;
    }

    if (candidateIds.length === 0 && criteria.sessionId) {
      candidateIds = await discoverOpenCodeSessionIdsByTitle(criteria.sessionId);
    }

    return candidateIds[0];
  }

  async function listRemoteSessionNumbers(project: ProjectConfig): Promise<number[]> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["ls-remote", "--heads", "origin", `session/${project.sessionPrefix}-*`],
        {
          cwd: project.path,
          timeout: 5_000,
          ...EXEC_SHELL_OPTION,
        },
      );

      return stdout
        .split("\n")
        .flatMap((line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return [];

          const ref = trimmed.split(/\s+/)[1] ?? "";
          const match = ref.match(
            new RegExp(`refs/heads/session/${escapeRegex(project.sessionPrefix)}-(\\d+)$`),
          );
          if (!match) return [];

          const parsed = Number.parseInt(match[1], 10);
          return Number.isNaN(parsed) ? [] : [parsed];
        })
        .filter((num: number, index: number, values: number[]) => values.indexOf(num) === index);
    } catch {
      return [];
    }
  }

  async function reserveNextSessionIdentity(
    project: ProjectConfig,
    sessionsDir: string,
  ): Promise<{
    num: number;
    sessionId: string;
    tmuxName: string | undefined;
  }> {
    const usedNumbers = new Set<number>();
    for (const sessionName of listMetadata(sessionsDir)) {
      const num = getSessionNumber(sessionName, project.sessionPrefix);
      if (num !== undefined) usedNumbers.add(num);
    }
    for (const num of await listRemoteSessionNumbers(project)) {
      usedNumbers.add(num);
    }

    let num = getNextSessionNumber(
      [...usedNumbers].map((value) => `${project.sessionPrefix}-${value}`),
      project.sessionPrefix,
    );
    for (let attempts = 0; attempts < 10_000; attempts++) {
      const sessionId = `${project.sessionPrefix}-${num}`;
      const tmuxName = project.path
        ? generateSessionName(project.sessionPrefix, num)
        : undefined;

      if (!usedNumbers.has(num) && reserveSessionId(sessionsDir, sessionId)) {
        return { num, sessionId, tmuxName };
      }

      usedNumbers.add(num);
      num += 1;
    }

    throw new Error(
      `Failed to reserve session ID after 10000 attempts (prefix: ${project.sessionPrefix})`,
    );
  }

  function reserveFixedOrchestratorIdentity(
    project: ProjectConfig,
    sessionsDir: string,
  ): { sessionId: string; tmuxName: string | undefined } {
    const sessionId = getOrchestratorSessionId(project);
    if (!reserveSessionId(sessionsDir, sessionId)) {
      throw new Error(
        `Orchestrator session "${sessionId}" already exists. Use ensureOrchestrator() to reuse or restore it.`,
      );
    }

    return {
      sessionId,
      tmuxName: config.configPath ? sessionId : undefined,
    };
  }

  /** Resolve which plugins to use for a project. */
  function resolvePlugins(project: ProjectConfig, agentName?: string) {
    const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
    const agent = registry.get<Agent>("agent", agentName ?? project.agent ?? config.defaults.agent);
    const workspace = registry.get<Workspace>(
      "workspace",
      project.workspace ?? config.defaults.workspace,
    );
    // After config validation, plugin is always set if tracker/scm exists
    // (either from user config or auto-generated from package/path)
    const tracker = project.tracker?.plugin
      ? registry.get<Tracker>("tracker", project.tracker.plugin)
      : null;
    const scm = project.scm?.plugin ? registry.get<SCM>("scm", project.scm.plugin) : null;

    return { runtime, agent, workspace, tracker, scm };
  }

  function resolveSelectionForSession(
    project: ProjectConfig,
    sessionId: string,
    metadata: Record<string, string>,
  ) {
    return resolveAgentSelection({
      role: resolveSessionRole(
        sessionId,
        metadata,
        project.sessionPrefix,
        Object.values(config.projects).map((p) => p.sessionPrefix),
      ),
      project,
      defaults: config.defaults,
      persistedAgent: metadata["agent"],
    });
  }

  async function ensureOpenCodeSessionMapping(
    session: Session,
    sessionName: string,
    sessionsDir: string,
    effectiveAgentName: string,
    sessionListPromise?: Promise<OpenCodeSessionListEntry[]>,
  ): Promise<void> {
    if (effectiveAgentName !== "opencode") return;
    if (asValidOpenCodeSessionId(session.metadata["opencodeSessionId"])) return;

    const discovered = await discoverOpenCodeSessionIdByTitle(
      sessionName,
      OPENCODE_DISCOVERY_TIMEOUT_MS,
      sessionListPromise,
    );
    if (!discovered) return;

    session.metadata["opencodeSessionId"] = discovered;
    updateMetadata(sessionsDir, sessionName, { opencodeSessionId: discovered });
  }

  function findSessionRecord(sessionId: SessionId): LocatedSession | null {
    for (const [projectId, project] of Object.entries(config.projects)) {
      const sessionsDir = getProjectSessionsDir(projectId);
      const raw = readMetadataRaw(sessionsDir, sessionId);
      if (!raw) continue;

      let modifiedAt: Date | undefined;
      try {
        modifiedAt = statSync(join(sessionsDir, `${sessionId}.json`)).mtime;
      } catch {
        modifiedAt = undefined;
      }

      const repaired = repairSingleSessionMetadataOnRead(
        sessionsDir,
        { sessionName: sessionId, raw, modifiedAt },
        project.sessionPrefix,
      );

      return { raw: repaired.raw, sessionsDir, project, projectId };
    }

    return null;
  }

  function requireSessionRecord(sessionId: SessionId): LocatedSession {
    const located = findSessionRecord(sessionId);
    if (!located) {
      throw new SessionNotFoundError(sessionId);
    }
    return located;
  }

  /**
   * Ensure session has a runtime handle (fabricate one if missing) and enrich
   * with live runtime state + activity detection. Used by both list() and get().
   */
  async function ensureHandleAndEnrich(
    session: Session,
    sessionName: string,
    sessionsDir: string,
    project: ProjectConfig,
    effectiveAgentName: string,
    plugins: ReturnType<typeof resolvePlugins>,
    sessionListPromise?: Promise<OpenCodeSessionListEntry[]>,
  ): Promise<void> {
    await ensureOpenCodeSessionMapping(
      session,
      sessionName,
      sessionsDir,
      effectiveAgentName,
      sessionListPromise,
    );

    const tmuxNameFromMetadata = session.metadata["tmuxName"]?.trim();
    const hasTmuxNameFromMetadata =
      typeof tmuxNameFromMetadata === "string" && tmuxNameFromMetadata.length > 0;
    const handleFromMetadata = session.runtimeHandle !== null || hasTmuxNameFromMetadata;
    if (!handleFromMetadata) {
      session.runtimeHandle = {
        id: sessionName,
        runtimeName: project.runtime ?? config.defaults.runtime,
        data: {},
      };
    } else if (!session.runtimeHandle && hasTmuxNameFromMetadata) {
      session.runtimeHandle = {
        id: tmuxNameFromMetadata,
        runtimeName: project.runtime ?? config.defaults.runtime,
        data: {},
      };
    }
    await enrichSessionWithRuntimeState(session, plugins, handleFromMetadata, sessionsDir);
  }

  /**
   * Enrich session with live runtime state (alive/exited) and activity detection.
   * Mutates the session object in place.
   */
  const TERMINAL_SESSION_STATUSES = new Set(["killed", "done", "merged", "terminated", "cleanup"]);

  async function enrichSessionWithRuntimeState(
    session: Session,
    plugins: ReturnType<typeof resolvePlugins>,
    handleFromMetadata: boolean,
    sessionsDir: string,
  ): Promise<void> {
    // Check runtime liveness first — for all statuses except "spawning".
    // Skip spawning sessions because tmux may not be fully initialized yet,
    // and a false-negative from isAlive() would permanently mark the session
    // as "killed" (see #1035).
    // This also fixes #1081: terminal statuses (merged, done, etc.) should not
    // force activity to "exited" if the agent process is still alive.
    // Fabricated handles (constructed as fallback for external sessions) should
    // NOT override status to "killed" — we don't know if the session ever had
    // a tmux session, and we'd clobber meaningful statuses like "pr_open".
    if (
      handleFromMetadata &&
      session.runtimeHandle &&
      plugins.runtime &&
      session.status !== "spawning"
    ) {
      try {
        const alive = await plugins.runtime.isAlive(session.runtimeHandle);
        if (!alive) {
          session.lifecycle.runtime.state = "missing";
          session.lifecycle.runtime.reason =
            session.runtimeHandle.runtimeName === "tmux" ? "tmux_missing" : "process_missing";
          session.lifecycle.runtime.lastObservedAt = new Date().toISOString();
          if (
            session.lifecycle.session.state !== "done" &&
            session.lifecycle.session.state !== "terminated"
          ) {
            session.lifecycle.session.state = "detecting";
            session.lifecycle.session.reason = "runtime_lost";
            session.lifecycle.session.lastTransitionAt = new Date().toISOString();
          }
          // Process is confirmed dead — set activity to exited.
          // Only update status to "killed" if not already in a terminal state.
          if (!TERMINAL_SESSION_STATUSES.has(session.status)) {
            session.status = "killed";
          }
          session.activity = "exited";
          session.activitySignal = createActivitySignal("valid", {
            activity: "exited",
            source: "runtime",
          });
          return;
        }
      } catch {
        // Can't check liveness — continue to activity detection
        session.lifecycle.runtime.state = "probe_failed";
        session.lifecycle.runtime.reason = "probe_error";
        session.lifecycle.runtime.lastObservedAt = new Date().toISOString();
      }
    }

    // Detect activity independently of runtime handle and session status.
    // Activity detection reads JSONL files on disk — it only needs workspacePath,
    // not a runtime handle. Gating on runtimeHandle caused sessions created by
    // external scripts (which don't store runtimeHandle) to always show "unknown".
    // This now runs for ALL sessions, including terminal statuses, so a merged
    // session with a live agent shows accurate activity (ready/idle/waiting_input).
    session.activitySignal = createActivitySignal("unavailable");
    if (plugins.agent) {
      try {
        const detected = await plugins.agent.getActivityState(session, config.readyThresholdMs);
        if (detected !== null) {
          session.activitySignal = classifyActivitySignal(detected, "native");
          session.activity = detected.state;
          session.lifecycle.runtime.state = "alive";
          session.lifecycle.runtime.reason = "process_running";
          session.lifecycle.runtime.lastObservedAt = new Date().toISOString();
          if (detected.timestamp && detected.timestamp > session.lastActivityAt) {
            session.lastActivityAt = detected.timestamp;
          }
        } else {
          session.activitySignal = createActivitySignal("null", { source: "native" });
        }
      } catch {
        session.activitySignal = createActivitySignal("probe_failure", { source: "native" });
      }

      // Enrich with live agent session info (summary, cost).
      let info: Awaited<ReturnType<Agent["getSessionInfo"]>>;
      try {
        info = await plugins.agent.getSessionInfo(session);
      } catch {
        // Can't get session info — keep existing values
        info = null;
      }

      if (info) {
        session.agentInfo = info;
        const metadataUpdates = info.metadata ?? {};
        if (Object.keys(metadataUpdates).length > 0) {
          try {
            updateMetadata(sessionsDir, session.id, metadataUpdates);
            session.metadata = applyMetadataUpdates(session.metadata, metadataUpdates);
            invalidateCache();
          } catch {
            // Persisting agent metadata is best-effort; keep live agent info.
          }
        }
      }
    }
  }

  // Define methods as local functions so `this` is not needed
  async function spawn(spawnConfig: SessionSpawnConfig): Promise<Session> {
    recordActivityEvent({
      projectId: spawnConfig.projectId,
      source: "session-manager",
      kind: "session.spawn_started",
      summary: "spawn started",
      data: { agent: spawnConfig.agent ?? undefined },
    });

    try {
      return await _spawnInner(spawnConfig);
    } catch (err) {
      recordActivityEvent({
        projectId: spawnConfig.projectId,
        source: "session-manager",
        kind: "session.spawn_failed",
        level: "error",
        summary: `spawn failed`,
        data: { reason: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  async function _spawnInner(spawnConfig: SessionSpawnConfig): Promise<Session> {
    const project = config.projects[spawnConfig.projectId];
    if (!project) {
      throw new Error(`Unknown project: ${spawnConfig.projectId}`);
    }

    const selection = resolveAgentSelection({
      role: "worker",
      project,
      defaults: config.defaults,
      spawnAgentOverride: spawnConfig.agent,
    });
    const plugins = resolvePlugins(project, selection.agentName);
    if (!plugins.runtime) {
      throw new Error(`Runtime plugin '${project.runtime ?? config.defaults.runtime}' not found`);
    }

    if (!plugins.agent) {
      throw new Error(`Agent plugin '${selection.agentName}' not found`);
    }

    // Validate issue exists BEFORE creating any resources
    let resolvedIssue: Issue | undefined;
    if (spawnConfig.issueId && plugins.tracker) {
      try {
        // Fetch and validate the issue exists
        resolvedIssue = await plugins.tracker.getIssue(spawnConfig.issueId, project);
      } catch (err) {
        // Issue fetch failed - determine why
        if (isIssueNotFoundError(err)) {
          // Ad-hoc issue string — proceed without tracker context.
          // Branch will be generated as feat/{issueId} (line 329-331)
        } else {
          // Other error (auth, network, etc) - fail fast
          throw new Error(`Failed to fetch issue ${spawnConfig.issueId}: ${err}`, { cause: err });
        }
      }
    }

    // Get the sessions directory for this project
    const sessionsDir = getProjectSessionsDir(spawnConfig.projectId);

    // CleanupStack: each side effect pushes its undo as soon as the resource
    // exists. On any failure below we runAll() in LIFO order; on success we
    // dismiss(). Replaces the previous nested rollback ladder — adding a new
    // step now requires pushing one cleanup, with no risk of forgetting prior
    // ones.
    const cleanupStack = new CleanupStack();
    try {
      // Determine session ID — atomically reserve to prevent concurrent collisions
      const { sessionId, tmuxName } = await reserveNextSessionIdentity(project, sessionsDir);
      cleanupStack.push(() => deleteMetadata(sessionsDir, sessionId));

      // Determine branch name — explicit branch always takes priority
      let branch: string;
      if (spawnConfig.branch) {
        branch = spawnConfig.branch;
      } else if (spawnConfig.issueId && plugins.tracker && resolvedIssue) {
        const fromIssue = resolvedIssue.branchName;
        branch =
          fromIssue && isGitBranchNameSafe(fromIssue)
            ? fromIssue
            : plugins.tracker.branchName(spawnConfig.issueId, project);
      } else if (spawnConfig.issueId) {
        // If the issueId is already branch-safe (e.g. "INT-9999"), use as-is.
        // Otherwise sanitize free-text (e.g. "fix login bug") into a valid slug.
        const id = spawnConfig.issueId;
        const isBranchSafe = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes("..");
        const slug = isBranchSafe
          ? id
          : id
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .slice(0, 60)
              .replace(/^-+|-+$/g, "");
        branch = `feat/${slug || sessionId}`;
      } else {
        branch = `session/${sessionId}`;
      }

      // Create workspace (if workspace plugin is available)
      let workspacePath = project.path;
      if (plugins.workspace) {
        const wsInfo = await plugins.workspace.create({
          projectId: spawnConfig.projectId,
          project,
          sessionId,
          branch,
          worktreeDir: getProjectWorktreesDir(spawnConfig.projectId),
        });
        workspacePath = wsInfo.path;
        // Only register destroy when the path is inside a managed root —
        // matches the prior shouldDestroyWorkspacePath gate so we never
        // destroy a user-owned project directory.
        if (shouldDestroyWorkspacePath(project, spawnConfig.projectId, workspacePath)) {
          const ws = plugins.workspace;
          cleanupStack.push(() => ws.destroy(workspacePath));
        }
        if (plugins.workspace.postCreate) {
          await plugins.workspace.postCreate(wsInfo, project);
        }
      }

      // Generate prompt with validated issue
      let issueContext: string | undefined;
      if (spawnConfig.issueId && plugins.tracker && resolvedIssue) {
        try {
          issueContext = await plugins.tracker.generatePrompt(spawnConfig.issueId, project);
        } catch {
          // Non-fatal: continue without detailed issue context
          // Silently ignore errors - caller can check if issueContext is undefined
        }
      }

      // If an orchestrator session exists on disk for this project, give the
      // worker the literal command to message it. Existence-on-disk is the
      // signal: if metadata was ever written for the canonical orchestrator
      // ID, the orchestrator workflow is in play here.
      const orchestratorSessionId = `${project.sessionPrefix}-orchestrator`;
      const orchestratorExists = readMetadataRaw(sessionsDir, orchestratorSessionId) !== null;

      const { systemPrompt, taskPrompt } = buildPrompt({
        project,
        projectId: spawnConfig.projectId,
        issueId: spawnConfig.issueId,
        issueContext,
        userPrompt: spawnConfig.prompt,
        ...(orchestratorExists && { orchestratorSessionId }),
      });

      const baseDir = getProjectDir(spawnConfig.projectId);
      mkdirSync(baseDir, { recursive: true });
      const systemPromptFile = join(baseDir, `worker-prompt-${sessionId}.md`);
      writeFileSync(systemPromptFile, systemPrompt, "utf-8");
      cleanupStack.push(() => unlinkSync(systemPromptFile));

      // need a seperate config file to pass instructions for opencode session
      let opencodeConfigFile: string | undefined;
      if (plugins.agent.name === "opencode") {
        opencodeConfigFile = writeOpenCodeConfig(baseDir, sessionId, [systemPromptFile]);
        const cfg = opencodeConfigFile;
        cleanupStack.push(() => unlinkSync(cfg));
      }

      // Get agent launch config and create runtime
      const opencodeIssueSessionStrategy = project.opencodeIssueSessionStrategy ?? "reuse";
      const reusedOpenCodeSessionId =
        plugins.agent.name === "opencode" && spawnConfig.issueId
          ? await resolveOpenCodeSessionReuse({
              sessionsDir,
              criteria: { issueId: spawnConfig.issueId },
              strategy: opencodeIssueSessionStrategy,
            })
          : undefined;

      const agentLaunchConfig = {
        sessionId,
        projectConfig: {
          ...project,
          agentConfig: {
            ...selection.agentConfig,
            ...(reusedOpenCodeSessionId ? { opencodeSessionId: reusedOpenCodeSessionId } : {}),
          },
        },
        workspacePath,
        issueId: spawnConfig.issueId,
        prompt: taskPrompt,
        systemPromptFile,
        permissions: selection.permissions,
        model: selection.model,
        subagent: spawnConfig.subagent ?? selection.subagent,
      };

      const launchCommand = plugins.agent.getLaunchCommand(agentLaunchConfig);
      const environment = plugins.agent.getEnvironment(agentLaunchConfig);

      if (plugins.agent.preLaunchSetup) {
        await plugins.agent.preLaunchSetup(workspacePath);
      }

      // Install workspace hooks before launching the agent so that
      // PostToolUse hooks (e.g. Claude Code's metadata-updater) are
      // in place before the agent's first tool call.
      if (plugins.agent.setupWorkspaceHooks) {
        await plugins.agent.setupWorkspaceHooks(workspacePath, { dataDir: sessionsDir });
      }
      if (plugins.agent.name !== "claude-code") {
        await setupPathWrapperWorkspace(workspacePath);
      }

      const handle = await plugins.runtime.create({
        sessionId: tmuxName ?? sessionId, // Use tmux name for runtime if available
        workspacePath,
        launchCommand,
        environment: {
          ...environment,
          ...(opencodeConfigFile ? { OPENCODE_CONFIG: opencodeConfigFile } : {}),
          ...(project.env ?? {}),
          PATH: buildAgentPath(environment["PATH"] ?? process.env["PATH"]),
          GH_PATH: PREFERRED_GH_PATH,
          ...(process.env["AO_AGENT_GH_TRACE"] && {
            AO_AGENT_GH_TRACE: process.env["AO_AGENT_GH_TRACE"],
          }),
          AO_SESSION: sessionId,
          AO_DATA_DIR: sessionsDir, // Pass sessions directory (not root dataDir)
          AO_SESSION_NAME: sessionId, // User-facing session name
          ...(tmuxName && { AO_TMUX_NAME: tmuxName }), // Tmux session name if using new arch
          AO_CALLER_TYPE: "agent",
          AO_PROJECT_ID: spawnConfig.projectId,
          AO_CONFIG_PATH: config.configPath,
          ...(config.port !== undefined &&
            config.port !== null && { AO_PORT: String(config.port) }),
        },
      });
      const rt = plugins.runtime;
      cleanupStack.push(() => rt.destroy(handle));

      // Derive a stable display name from task context. Unlike issue-title
      // enrichment (which is a live tracker API call), this value is captured at
      // spawn time and persisted, so the dashboard has a good name even when the
      // tracker is unavailable or the session has no attached PR yet.
      const displayName = deriveDisplayName({
        issueTitle: resolvedIssue?.title,
        prompt: spawnConfig.prompt,
      });

      // Write metadata and run post-launch setup
      const createdAt = new Date();
      const lifecycle = createInitialCanonicalLifecycle("worker", createdAt);
      lifecycle.runtime.handle = handle;
      lifecycle.runtime.tmuxName = tmuxName ?? null;

      const session: Session = {
        id: sessionId,
        projectId: spawnConfig.projectId,
        status: deriveLegacyStatus(lifecycle),
        activity: "active",
        activitySignal: createActivitySignal("valid", {
          activity: "active",
          timestamp: createdAt,
          source: "runtime",
        }),
        lifecycle,
        branch,
        issueId: spawnConfig.issueId ?? null,
        pr: null,
        workspacePath,
        runtimeHandle: handle,
        agentInfo: null,
        createdAt,
        lastActivityAt: createdAt,
        metadata: {
          ...(reusedOpenCodeSessionId ? { opencodeSessionId: reusedOpenCodeSessionId } : {}),
          ...(spawnConfig.prompt ? { userPrompt: spawnConfig.prompt } : {}),
          ...(displayName ? { displayName } : {}),
        },
      };

      writeMetadata(sessionsDir, sessionId, {
        worktree: workspacePath,
        branch,
        status: deriveLegacyStatus(lifecycle),
        ...buildLifecycleMetadataPatch(lifecycle),
        // Override stringified lifecycle/runtimeHandle from the patch
        // with their canonical object forms. `buildLifecycleMetadataPatch`
        // produces `Partial<Record<string, string>>` for the
        // updateMetadata/mutateMetadata path; spreading it directly into
        // a typed `SessionMetadata` literal silently widens the
        // `lifecycle`/`runtimeHandle` fields to strings, which then get
        // re-encoded by `JSON.stringify` and rejected by
        // `parseLifecycleField` on the next read.
        lifecycle,
        tmuxName, // Store tmux name for mapping
        issue: spawnConfig.issueId,
        issueTitle: resolvedIssue?.title, // Store issue title for event enrichment
        project: spawnConfig.projectId,
        agent: selection.agentName, // Persist agent name for lifecycle manager
        createdAt: createdAt.toISOString(),
        runtimeHandle: handle,
        opencodeSessionId: reusedOpenCodeSessionId,
        userPrompt: spawnConfig.prompt,
        displayName,
      });

      if (plugins.agent.postLaunchSetup) {
        await plugins.agent.postLaunchSetup(session);
      }

      if (
        plugins.agent.name === "opencode" &&
        opencodeIssueSessionStrategy === "reuse" &&
        !session.metadata["opencodeSessionId"]
      ) {
        const discovered = await discoverOpenCodeSessionIdByTitle(
          sessionId,
          OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS,
        );
        if (discovered) {
          session.metadata["opencodeSessionId"] = discovered;
        }
      }

      if (Object.keys(session.metadata || {}).length > 0) {
        updateMetadata(sessionsDir, sessionId, session.metadata);
      }
      invalidateCache();

      // Past this point every resource that needed an undo is on disk in its
      // final form. Dismiss the stack so nothing below can trigger a rollback.
      cleanupStack.dismiss();

      // Prompt is delivered inline via the agent's launch command (positional argument).
      // No post-launch polling needed — the prompt is part of process invocation.
      recordActivityEvent({
        projectId: spawnConfig.projectId,
        sessionId,
        source: "session-manager",
        kind: "session.spawned",
        summary: `spawned: ${sessionId}`,
        data: { agent: plugins.agent.name, branch: session.branch ?? undefined },
      });

      return session;
    } catch (err) {
      // Log cleanup failures so they don't disappear silently. The original
      // code used /* best effort */ swallows; the stack preserves that
      // behavior (cleanup errors don't propagate) but surfaces them for debug.
      await cleanupStack.runAll((cleanupErr) => {
        console.error("[session-manager] spawn rollback step failed:", cleanupErr);
      });
      throw err;
    }
  }

  async function spawnOrchestrator(orchestratorConfig: OrchestratorSpawnConfig): Promise<Session> {
    const project = config.projects[orchestratorConfig.projectId];
    if (!project) {
      throw new Error(`Unknown project: ${orchestratorConfig.projectId}`);
    }

    const selection = resolveAgentSelection({
      role: "orchestrator",
      project,
      defaults: config.defaults,
      spawnAgentOverride: orchestratorConfig.agent,
    });
    const plugins = resolvePlugins(project, selection.agentName);
    if (!plugins.runtime) {
      throw new Error(`Runtime plugin '${project.runtime ?? config.defaults.runtime}' not found`);
    }
    if (!plugins.agent) {
      throw new Error(`Agent plugin '${selection.agentName}' not found`);
    }

    // Get the sessions directory for this project
    const sessionsDir = getProjectSessionsDir(orchestratorConfig.projectId);

    const orchestratorSessionStrategy = normalizeOrchestratorSessionStrategy(
      project.orchestratorSessionStrategy,
    );

    const identity = reserveFixedOrchestratorIdentity(project, sessionsDir);
    const sessionId = identity.sessionId;
    const tmuxName = identity.tmuxName;

    // The main orchestrator is deterministic, but still uses an isolated worktree.
    const branch = `orchestrator/${sessionId}`;

    if (!plugins.workspace) {
      try {
        deleteMetadata(sessionsDir, sessionId);
      } catch {
        /* best effort */
      }
      throw new Error(
        `spawnOrchestrator requires a workspace plugin but none is configured for project '${orchestratorConfig.projectId}'`,
      );
    }

    const workspaceConfig = {
      projectId: orchestratorConfig.projectId,
      project,
      sessionId,
      branch,
      worktreeDir: getProjectWorktreesDir(orchestratorConfig.projectId),
    } satisfies WorkspaceCreateConfig;

    let workspacePath: string;
    let adoptedManagedWorkspace = false;
    try {
      const adoptedInfo = await plugins.workspace.findManagedWorkspace?.(workspaceConfig);
      const wsInfo = adoptedInfo ?? (await plugins.workspace.create(workspaceConfig));
      workspacePath = wsInfo.path;
      adoptedManagedWorkspace = adoptedInfo !== undefined && adoptedInfo !== null;
    } catch (err) {
      try {
        deleteMetadata(sessionsDir, sessionId);
      } catch {
        /* best effort */
      }
      throw err;
    }

    // Helper: undo worktree + metadata if anything between workspace creation
    // and a fully-written metadata record fails.
    const cleanupWorktreeAndMetadata = async (promptFile?: string): Promise<void> => {
      if (!adoptedManagedWorkspace) {
        try {
          // plugins.workspace is guaranteed non-null here: we threw above if it was null
          await plugins.workspace!.destroy(workspacePath);
        } catch {
          /* best effort */
        }
      }
      try {
        deleteMetadata(sessionsDir, sessionId);
      } catch {
        /* best effort */
      }
      if (promptFile) {
        try {
          unlinkSync(promptFile);
        } catch {
          /* best effort */
        }
      }
    };

    // Setup agent hooks for automatic metadata updates.
    // Claude Code uses native PostToolUse hooks for metadata writes — skip
    // PATH wrappers to avoid two concurrent writers (wrapper + hook) hitting
    // the same metadata file with no locking.
    try {
      if (plugins.agent.setupWorkspaceHooks) {
        await plugins.agent.setupWorkspaceHooks(workspacePath, { dataDir: sessionsDir });
      }
      if (plugins.agent.name !== "claude-code") {
        await setupPathWrapperWorkspace(workspacePath);
      }
    } catch (err) {
      await cleanupWorktreeAndMetadata();
      throw err;
    }

    // Write system prompt to a file to avoid shell/tmux truncation.
    // Long prompts (2000+ chars) get mangled when inlined in shell commands
    // via tmux send-keys or paste-buffer. File-based approach is reliable.
    let systemPromptFile: string | undefined;
    if (orchestratorConfig.systemPrompt) {
      try {
        const projectDir = getProjectDir(orchestratorConfig.projectId);
        mkdirSync(projectDir, { recursive: true });
        systemPromptFile = join(projectDir, `orchestrator-prompt-${sessionId}.md`);
        writeFileSync(systemPromptFile, orchestratorConfig.systemPrompt, "utf-8");
      } catch (err) {
        await cleanupWorktreeAndMetadata(systemPromptFile);
        throw err;
      }
    }

    if (plugins.agent.name === "opencode" && systemPromptFile) {
      try {
        writeWorkspaceOpenCodeAgentsMd(workspacePath, systemPromptFile);
      } catch (err) {
        await cleanupWorktreeAndMetadata(systemPromptFile);
        throw err;
      }
    }

    let reusableOpenCodeSessionId: string | undefined;
    try {
      reusableOpenCodeSessionId =
        plugins.agent.name === "opencode" && orchestratorSessionStrategy === "reuse"
          ? await resolveOpenCodeSessionReuse({
              sessionsDir,
              criteria: { sessionId },
              strategy: "reuse",
            })
          : undefined;
      if (plugins.agent.name === "opencode" && orchestratorSessionStrategy === "delete") {
        await resolveOpenCodeSessionReuse({
          sessionsDir,
          criteria: { sessionId },
          strategy: "delete",
          includeTitleDiscoveryForSessionId: true,
        });
      }
    } catch (err) {
      await cleanupWorktreeAndMetadata(systemPromptFile);
      throw err;
    }

    // Get agent launch config — uses systemPromptFile, no issue/tracker interaction.
    // Orchestrator ALWAYS gets permissionless mode — it must run ao CLI commands autonomously.
    const agentLaunchConfig = {
      sessionId,
      projectConfig: {
        ...project,
        agentConfig: {
          ...selection.agentConfig,
          permissions: "permissionless" as const,
          ...(reusableOpenCodeSessionId ? { opencodeSessionId: reusableOpenCodeSessionId } : {}),
        },
      },
      workspacePath,
      permissions: "permissionless" as const,
      model: selection.model,
      systemPromptFile,
      subagent: selection.subagent,
    };

    const launchCommand = plugins.agent.getLaunchCommand(agentLaunchConfig);
    const environment = plugins.agent.getEnvironment(agentLaunchConfig);

    if (plugins.agent.preLaunchSetup) {
      await plugins.agent.preLaunchSetup(workspacePath);
    }

    // Create runtime — clean up worktree and metadata on failure
    let handle: RuntimeHandle;
    try {
      handle = await plugins.runtime.create({
        sessionId: tmuxName ?? sessionId,
        workspacePath,
        launchCommand,
        environment: {
          ...environment,
          ...(project.env ?? {}),
          PATH: buildAgentPath(environment["PATH"] ?? process.env["PATH"]),
          GH_PATH: PREFERRED_GH_PATH,
          ...(process.env["AO_AGENT_GH_TRACE"] && {
            AO_AGENT_GH_TRACE: process.env["AO_AGENT_GH_TRACE"],
          }),
          AO_SESSION: sessionId,
          AO_DATA_DIR: sessionsDir,
          AO_SESSION_NAME: sessionId,
          ...(tmuxName && { AO_TMUX_NAME: tmuxName }),
          AO_CALLER_TYPE: "orchestrator",
          AO_PROJECT_ID: orchestratorConfig.projectId,
          AO_CONFIG_PATH: config.configPath,
          ...(config.port !== undefined &&
            config.port !== null && { AO_PORT: String(config.port) }),
        },
      });
    } catch (err) {
      await cleanupWorktreeAndMetadata(systemPromptFile);
      throw err;
    }

    // Derive a stable display name from the orchestrator's system prompt so
    // the dashboard shows something more useful than "Ao Orchestrator 8".
    const displayName = deriveDisplayName({
      prompt: orchestratorConfig.systemPrompt,
    });

    // Write metadata and run post-launch setup
    const createdAt = new Date();
    const lifecycle = createInitialCanonicalLifecycle("orchestrator", createdAt);
    lifecycle.session.state = "working";
    lifecycle.session.reason = "task_in_progress";
    lifecycle.session.startedAt = createdAt.toISOString();
    lifecycle.session.lastTransitionAt = createdAt.toISOString();
    lifecycle.runtime.handle = handle;
    lifecycle.runtime.tmuxName = tmuxName ?? null;

    const session: Session = {
      id: sessionId,
      projectId: orchestratorConfig.projectId,
      status: deriveLegacyStatus(lifecycle),
      activity: "active",
      activitySignal: createActivitySignal("valid", {
        activity: "active",
        timestamp: createdAt,
        source: "runtime",
      }),
      lifecycle,
      branch,
      issueId: null,
      pr: null,
      workspacePath,
      runtimeHandle: handle,
      agentInfo: null,
      createdAt,
      lastActivityAt: createdAt,
      metadata: {
        ...(reusableOpenCodeSessionId ? { opencodeSessionId: reusableOpenCodeSessionId } : {}),
        ...(displayName ? { displayName } : {}),
      },
    };

    try {
      writeMetadata(sessionsDir, sessionId, {
        worktree: workspacePath,
        branch,
        status: deriveLegacyStatus(lifecycle),
        ...buildLifecycleMetadataPatch(lifecycle),
        // Object overrides for the typed writeMetadata path —
        // see the spawnSession site for the rationale.
        lifecycle,
        role: "orchestrator",
        tmuxName,
        project: orchestratorConfig.projectId,
        agent: selection.agentName,
        createdAt: createdAt.toISOString(),
        runtimeHandle: handle,
        opencodeSessionId: reusableOpenCodeSessionId,
        displayName,
      });

      if (plugins.agent.postLaunchSetup) {
        await plugins.agent.postLaunchSetup(session);
      }

      if (
        plugins.agent.name === "opencode" &&
        orchestratorSessionStrategy === "reuse" &&
        !session.metadata["opencodeSessionId"]
      ) {
        const discovered = await discoverOpenCodeSessionIdByTitle(
          sessionId,
          OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS,
        );
        if (discovered) {
          session.metadata["opencodeSessionId"] = discovered;
        }
      }

      if (Object.keys(session.metadata || {}).length > 0) {
        updateMetadata(sessionsDir, sessionId, session.metadata);
      }
      invalidateCache();
    } catch (err) {
      // Clean up runtime on post-launch failure
      try {
        await plugins.runtime.destroy(handle);
      } catch {
        /* best effort */
      }
      await cleanupWorktreeAndMetadata(systemPromptFile);
      throw err;
    }

    return session;
  }

  async function waitForConcurrentOrchestrator(sessionId: string): Promise<Session | null> {
    const deadline = Date.now() + ENSURE_ORCHESTRATOR_CONFLICT_WAIT_MS;
    while (Date.now() < deadline) {
      const existing = await get(sessionId);
      if (existing?.metadata["role"] === "orchestrator") {
        return existing;
      }
      await sleep(ENSURE_ORCHESTRATOR_CONFLICT_POLL_MS);
    }
    return null;
  }

  async function ensureOrchestratorInternal(orchestratorConfig: OrchestratorSpawnConfig): Promise<Session> {
    const project = config.projects[orchestratorConfig.projectId];
    if (!project) {
      throw new Error(`Unknown project: ${orchestratorConfig.projectId}`);
    }

    const sessionId = getOrchestratorSessionId(project);
    const existing = await get(sessionId);
    if (existing) {
      const orchestratorSessionStrategy = normalizeOrchestratorSessionStrategy(
        project.orchestratorSessionStrategy,
      );
      if (
        orchestratorSessionStrategy === "delete" ||
        orchestratorSessionStrategy === "ignore"
      ) {
        await kill(sessionId, { purgeOpenCode: orchestratorSessionStrategy === "delete" });
        deleteMetadata(getProjectSessionsDir(orchestratorConfig.projectId), sessionId);
        return spawnOrchestrator(orchestratorConfig);
      }
      if (existing.lifecycle.session.state === "done") {
        throw new SessionNotRestorableError(
          sessionId,
          `canonical orchestrator session is terminal with status "${existing.status}". Remove or clean up this session before starting a new orchestrator.`,
        );
      }
      if (isRestorable(existing)) {
        return restore(sessionId);
      }
      if (!isTerminalSession(existing)) {
        return existing;
      }
      throw new SessionNotRestorableError(
        sessionId,
        `canonical orchestrator session is terminal with status "${existing.status}". Remove or clean up this session before starting a new orchestrator.`,
      );
    }

    try {
      return await spawnOrchestrator(orchestratorConfig);
    } catch (err) {
      if (!isFixedOrchestratorReservationError(err, sessionId)) {
        throw err;
      }

      const concurrent = await waitForConcurrentOrchestrator(sessionId);
      if (concurrent) return concurrent;
      throw err;
    }
  }

  async function ensureOrchestrator(orchestratorConfig: OrchestratorSpawnConfig): Promise<Session> {
    const project = config.projects[orchestratorConfig.projectId];
    if (!project) {
      throw new Error(`Unknown project: ${orchestratorConfig.projectId}`);
    }

    const sessionId = getOrchestratorSessionId(project);
    const existingPromise = ensureOrchestratorPromises.get(sessionId);
    if (existingPromise) return existingPromise;

    const promise = ensureOrchestratorInternal(orchestratorConfig).finally(() => {
      ensureOrchestratorPromises.delete(sessionId);
    });
    ensureOrchestratorPromises.set(sessionId, promise);
    return promise;
  }

  async function list(projectId?: string): Promise<Session[]> {
    const allSessions = Object.entries(config.projects).flatMap(([entryProjectId, project]) => {
      if (projectId && entryProjectId !== projectId) return [];
      return loadActiveSessionRecords(entryProjectId, project).map((record) => ({
        sessionName: record.sessionName,
        projectId: entryProjectId,
        raw: record.raw,
      }));
    });
    let openCodeSessionListPromise: Promise<OpenCodeSessionListEntry[]> | undefined;

    const tasks = allSessions.map(async ({ sessionName, projectId: sessionProjectId, raw }) => {
      const project = config.projects[sessionProjectId];
      if (!project) return null;

      const sessionsDir = getProjectSessionsDir(sessionProjectId);

      let createdAt: Date | undefined;
      let modifiedAt: Date | undefined;
      try {
        const metaPath = join(sessionsDir, `${sessionName}.json`);
        const stats = statSync(metaPath);
        createdAt = stats.birthtime;
        modifiedAt = stats.mtime;
      } catch {
        // If stat fails, timestamps will fall back to current time
      }

      const session = metadataToSession(
        sessionName,
        raw,
        sessionProjectId,
        project.sessionPrefix,
        createdAt,
        modifiedAt,
      );
      const selection = resolveSelectionForSession(project, sessionName, raw);
      const effectiveAgentName = selection.agentName;
      const plugins = resolvePlugins(project, effectiveAgentName);
      const sessionListPromise =
        effectiveAgentName === "opencode"
          ? (openCodeSessionListPromise ??= fetchOpenCodeSessionList())
          : undefined;

      let enrichTimeoutId: ReturnType<typeof setTimeout> | null = null;
      const enrichTimeout = new Promise<void>((resolve) => {
        enrichTimeoutId = setTimeout(resolve, OPENCODE_DISCOVERY_TIMEOUT_MS + 2_000);
      });
      const enrichPromise = ensureHandleAndEnrich(
        session,
        sessionName,
        sessionsDir,
        project,
        effectiveAgentName,
        plugins,
        sessionListPromise,
      ).catch(() => {});
      try {
        await Promise.race([enrichPromise, enrichTimeout]);
      } finally {
        if (enrichTimeoutId) {
          clearTimeout(enrichTimeoutId);
        }
      }

      // Persist lifecycle to disk when enrichment detected a dead runtime.
      // enrichSessionWithRuntimeState updates the in-memory lifecycle but
      // doesn't write to disk — without this, the stale "alive" state persists
      // and the dashboard shows terminated sessions on the active sidebar.
      if (
        session.lifecycle &&
        (session.lifecycle.runtime.state === "missing" ||
          session.lifecycle.runtime.state === "exited") &&
        session.lifecycle.session.state !== "terminated" &&
        session.lifecycle.session.state !== "done"
      ) {
        try {
          const persisted = buildUpdatedLifecycle(sessionName, raw, (next) => {
            next.session.state = "terminated";
            next.session.reason = "runtime_lost";
            next.session.terminatedAt = new Date().toISOString();
            next.session.lastTransitionAt = next.session.terminatedAt;
            next.runtime.state = session.lifecycle!.runtime.state;
            next.runtime.reason = session.lifecycle!.runtime.reason;
            next.runtime.lastObservedAt = new Date().toISOString();
          });
          updateMetadata(sessionsDir, sessionName, lifecycleMetadataUpdates(raw, persisted));
          session.lifecycle = persisted;
          session.status = deriveLegacyStatus(persisted);
        } catch {
          // Persist failed — in-memory state is still correct for this request
        }
      }

      return session;
    });

    const resolved = await Promise.all(tasks);
    return resolved.filter((session): session is Session => session !== null);
  }

  async function listCached(projectId?: string): Promise<Session[]> {
    if (sessionCache && Date.now() < sessionCache.expiresAt) {
      return projectId
        ? sessionCache.sessions.filter((session) => session.projectId === projectId)
        : sessionCache.sessions;
    }

    const sessions = await list();
    sessionCache = {
      sessions,
      expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
    };

    return projectId ? sessions.filter((session) => session.projectId === projectId) : sessions;
  }

  async function get(sessionId: SessionId): Promise<Session | null> {
    // Try to find the session in any project's sessions directory
    for (const [projectId, project] of Object.entries(config.projects)) {
      const sessionsDir = getProjectSessionsDir(projectId);
      const raw = readMetadataRaw(sessionsDir, sessionId);
      if (!raw) continue;

      // Get file timestamps for createdAt/lastActivityAt
      let createdAt: Date | undefined;
      let modifiedAt: Date | undefined;
      try {
        const metaPath = join(sessionsDir, `${sessionId}.json`);
        const stats = statSync(metaPath);
        createdAt = stats.birthtime;
        modifiedAt = stats.mtime;
      } catch {
        // If stat fails, timestamps will fall back to current time
      }

      const repaired = repairSingleSessionMetadataOnRead(
        sessionsDir,
        { sessionName: sessionId, raw, modifiedAt },
        project.sessionPrefix,
      );

      const session = metadataToSession(
        sessionId,
        repaired.raw,
        projectId,
        project.sessionPrefix,
        createdAt,
        modifiedAt,
      );

      const selection = resolveSelectionForSession(project, sessionId, repaired.raw);
      const effectiveAgentName = selection.agentName;
      const plugins = resolvePlugins(project, effectiveAgentName);
      await ensureHandleAndEnrich(
        session,
        sessionId,
        sessionsDir,
        project,
        effectiveAgentName,
        plugins,
      );

      return session;
    }

    return null;
  }

  async function kill(sessionId: SessionId, options?: KillOptions): Promise<KillResult> {
    const located = findSessionRecord(sessionId);
    if (!located) {
      // Session not found via findSessionRecord — check if it exists with
      // a terminated lifecycle so auto-cleanup retries don't throw.
      for (const [killProjectId] of Object.entries(config.projects)) {
        const sessionsDir = getProjectSessionsDir(killProjectId);
        const raw = readMetadataRaw(sessionsDir, sessionId);
        if (raw) {
          const lifecycle = parseLifecycleFromRaw(raw);
          if (lifecycle?.session.state === "terminated") {
            return { cleaned: false, alreadyTerminated: true };
          }
        }
      }
      throw new SessionNotFoundError(sessionId);
    }
    const { raw, sessionsDir, project, projectId } = located;

    // Idempotency: if lifecycle already says terminated, don't re-run destroys
    // (which could double-purge opencode or race with concurrent kills).
    const existingLifecycle = parseCanonicalLifecycle(raw);
    if (existingLifecycle?.session.state === "terminated") {
      return { cleaned: false, alreadyTerminated: true };
    }

    const killReason: LifecycleKillReason = options?.reason ?? "manually_killed";
    const cleanupAgent = resolveSelectionForSession(project, sessionId, raw).agentName;

    // Destroy runtime — prefer handle.runtimeName to find the correct plugin
    if (raw["runtimeHandle"]) {
      const handle = safeJsonParse<RuntimeHandle>(raw["runtimeHandle"]);
      if (handle) {
        const runtimePlugin = registry.get<Runtime>(
          "runtime",
          handle.runtimeName ??
            (project ? (project.runtime ?? config.defaults.runtime) : config.defaults.runtime),
        );
        if (runtimePlugin) {
          try {
            await runtimePlugin.destroy(handle);
          } catch {
            // Runtime might already be gone
          }
        }
      }
    }

    const worktree = raw["worktree"];
    if (worktree && shouldDestroyWorkspacePath(project, projectId, worktree)) {
      const workspacePlugin = project
        ? resolvePlugins(project).workspace
        : registry.get<Workspace>("workspace", config.defaults.workspace);
      if (workspacePlugin) {
        try {
          await workspacePlugin.destroy(worktree);
        } catch {
          // Workspace might already be gone
        }
      }
    }

    let didPurgeOpenCodeSession = false;
    if (options?.purgeOpenCode === true && cleanupAgent === "opencode") {
      const mappedOpenCodeSessionId =
        asValidOpenCodeSessionId(raw["opencodeSessionId"]) ??
        (await discoverOpenCodeSessionIdByTitle(
          sessionId,
          OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS,
        ));

      if (mappedOpenCodeSessionId) {
        try {
          await deleteOpenCodeSession(mappedOpenCodeSessionId);
          didPurgeOpenCodeSession = true;
        } catch {
          void 0;
        }
      }
    }

    const runtimeReason =
      killReason === "pr_merged"
        ? "pr_merged_cleanup"
        : killReason === "auto_cleanup"
          ? "auto_cleanup"
          : "manual_kill_requested";
    const terminatedLifecycle = buildUpdatedLifecycle(sessionId, raw, (next) => {
      next.session.state = "terminated";
      next.session.reason = killReason;
      next.session.terminatedAt = new Date().toISOString();
      next.session.lastTransitionAt = next.session.terminatedAt;
      next.runtime.state = raw["runtimeHandle"] || raw["tmuxName"] ? "missing" : "exited";
      next.runtime.reason = runtimeReason;
      next.runtime.lastObservedAt = new Date().toISOString();
    });
    updateMetadata(sessionsDir, sessionId, {
      ...lifecycleMetadataUpdates(raw, terminatedLifecycle),
      ...(didPurgeOpenCodeSession && {
        opencodeSessionId: "",
        opencodeCleanedAt: new Date().toISOString(),
      }),
    });

    invalidateCache();
    recordActivityEvent({
      projectId,
      sessionId,
      source: "session-manager",
      kind: "session.killed",
      summary: `killed: ${sessionId}`,
      data: { reason: killReason },
    });
    return { cleaned: true, alreadyTerminated: false };
  }

  async function cleanup(
    projectId?: string,
    options?: { dryRun?: boolean; purgeOpenCode?: boolean },
  ): Promise<CleanupResult> {
    const result: CleanupResult = { killed: [], skipped: [], errors: [] };
    const sessions = await list(projectId);

    const killedKeys = new Set<string>();
    const skippedKeys = new Set<string>();

    const toEntryKey = (entryProjectId: string, id: string): string => `${entryProjectId}:${id}`;
    const fromEntryKey = (entryKey: string): { projectId: string; id: string } => {
      const separatorIndex = entryKey.indexOf(":");
      if (separatorIndex === -1) {
        return { projectId: "", id: entryKey };
      }
      return {
        projectId: entryKey.slice(0, separatorIndex),
        id: entryKey.slice(separatorIndex + 1),
      };
    };

    const pushKilled = (entryProjectId: string, id: string): void => {
      const key = toEntryKey(entryProjectId, id);
      skippedKeys.delete(key);
      killedKeys.add(key);
    };

    const pushSkipped = (entryProjectId: string, id: string): void => {
      const key = toEntryKey(entryProjectId, id);
      if (killedKeys.has(key)) return;
      skippedKeys.add(key);
    };

    const shouldPurgeOpenCode = options?.purgeOpenCode !== false;

    for (const session of sessions) {
      try {
        const project = config.projects[session.projectId];
        if (!project) {
          pushSkipped(session.projectId, session.id);
          continue;
        }

        if (isCleanupProtectedSession(project, session.id, session.metadata)) {
          pushSkipped(session.projectId, session.id);
          continue;
        }

        const plugins = resolvePlugins(project);
        let shouldKill = false;

        // Check if PR was closed without merging.
        if (session.pr && plugins.scm) {
          try {
            const prState = await plugins.scm.getPRState(session.pr);
            if (prState === PR_STATE.CLOSED) {
              shouldKill = true;
            }
          } catch {
            // Can't check PR — skip
          }
        }

        // Check if issue is completed
        if (!shouldKill && session.issueId && plugins.tracker) {
          try {
            const completed = await plugins.tracker.isCompleted(session.issueId, project);
            if (completed) shouldKill = true;
          } catch {
            // Can't check issue — skip
          }
        }

        // Check if runtime is dead
        if (!shouldKill && session.runtimeHandle && plugins.runtime) {
          try {
            const alive = await plugins.runtime.isAlive(session.runtimeHandle);
            if (!alive) shouldKill = true;
          } catch {
            // Can't check — skip
          }
        }

        if (shouldKill) {
          if (!options?.dryRun) {
            await kill(session.id, { purgeOpenCode: shouldPurgeOpenCode });
          }
          pushKilled(session.projectId, session.id);
        } else {
          pushSkipped(session.projectId, session.id);
        }
      } catch (err) {
        result.errors.push({
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Clean up terminated sessions with uncleaned OpenCode mappings.
    // These sessions are already in sessions/ (returned by listMetadata) and may
    // have been processed by the first loop via list(). We skip sessions that were
    // already killed above, but still process those that were only skipped.
    for (const [projectKey, project] of Object.entries(config.projects)) {
      if (projectId && projectKey !== projectId) continue;

      const sessionsDir = getProjectSessionsDir(projectKey);
      for (const terminatedId of listMetadata(sessionsDir)) {
        const entryKey = toEntryKey(projectKey, terminatedId);
        if (killedKeys.has(entryKey)) continue;

        const terminatedRaw = readMetadataRaw(sessionsDir, terminatedId);
        if (!terminatedRaw) continue;

        const lifecycle = parseLifecycleFromRaw(terminatedRaw);
        if (lifecycle?.session.state !== "terminated") continue;

        if (isCleanupProtectedSession(project, terminatedId, terminatedRaw)) {
          pushSkipped(projectKey, terminatedId);
          continue;
        }

        const cleanupAgent = resolveSelectionForSession(project, terminatedId, terminatedRaw).agentName;
        const mappedOpenCodeSessionId = asValidOpenCodeSessionId(terminatedRaw["opencodeSessionId"]);
        if (cleanupAgent === "opencode" && terminatedRaw["opencodeCleanedAt"]) {
          pushSkipped(projectKey, terminatedId);
          continue;
        }
        if (cleanupAgent === "opencode" && mappedOpenCodeSessionId && shouldPurgeOpenCode) {
          if (!options?.dryRun) {
            try {
              await deleteOpenCodeSession(mappedOpenCodeSessionId);
              mutateMetadata(sessionsDir, terminatedId, (existing) => ({
                ...existing,
                opencodeSessionId: "",
                opencodeCleanedAt: new Date().toISOString(),
              }));
            } catch (err) {
              result.errors.push({
                sessionId: terminatedId,
                error: `Failed to delete OpenCode session ${mappedOpenCodeSessionId}: ${err instanceof Error ? err.message : String(err)}`,
              });
              continue;
            }
          }
          pushKilled(projectKey, terminatedId);
        } else {
          pushSkipped(projectKey, terminatedId);
        }
      }
    }

    const allEntryKeys = [...killedKeys, ...skippedKeys];
    const idCounts = new Map<string, number>();
    for (const entryKey of allEntryKeys) {
      const { id } = fromEntryKey(entryKey);
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }

    const formatEntry = (entryKey: string): string => {
      const { projectId: entryProjectId, id } = fromEntryKey(entryKey);
      return (idCounts.get(id) ?? 0) > 1 ? `${entryProjectId}:${id}` : id;
    };

    result.killed = [...killedKeys].map(formatEntry);
    result.skipped = [...skippedKeys].map(formatEntry);

    return result;
  }

  async function send(sessionId: SessionId, message: string): Promise<void> {
    const { raw, sessionsDir, project } = requireSessionRecord(sessionId);

    const selection = resolveSelectionForSession(project, sessionId, raw);
    const selectedAgent = selection.agentName;
    if (selectedAgent === "opencode" && !asValidOpenCodeSessionId(raw["opencodeSessionId"])) {
      const discovered = await discoverOpenCodeSessionIdByTitle(
        sessionId,
        OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS,
      );
      if (discovered) {
        raw["opencodeSessionId"] = discovered;
        updateMetadata(sessionsDir, sessionId, { opencodeSessionId: discovered });
        invalidateCache();
      }
    }
    const parsedHandle = raw["runtimeHandle"]
      ? safeJsonParse<RuntimeHandle>(raw["runtimeHandle"])
      : null;
    const runtimeName = parsedHandle?.runtimeName ?? project.runtime ?? config.defaults.runtime;
    const agentName = selectedAgent;

    const runtimePlugin = registry.get<Runtime>("runtime", runtimeName);
    if (!runtimePlugin) {
      throw new Error(`No runtime plugin for session ${sessionId}`);
    }

    const agentPlugin = registry.get<Agent>("agent", agentName);
    if (!agentPlugin) {
      throw new Error(`No agent plugin for session ${sessionId}`);
    }

    const captureOutput = async (handle: RuntimeHandle): Promise<string> => {
      try {
        return (await runtimePlugin.getOutput(handle, SEND_CONFIRMATION_OUTPUT_LINES)) ?? "";
      } catch {
        return "";
      }
    };

    const detectActivityFromOutput = (output: string) => {
      if (!output) return null;
      try {
        return agentPlugin.detectActivity(output);
      } catch {
        return null;
      }
    };

    const hasQueuedMessage = (output: string): boolean => {
      return output.includes("Press up to edit queued messages");
    };

    const getOpenCodeSessionUpdatedAt = async (): Promise<number | undefined> => {
      const mappedSessionId = asValidOpenCodeSessionId(raw["opencodeSessionId"]);
      if (agentName !== "opencode" || !mappedSessionId) {
        return undefined;
      }

      const sessions = await fetchOpenCodeSessionList(OPENCODE_DISCOVERY_TIMEOUT_MS);
      return sessions.find((entry) => entry.id === mappedSessionId)?.updatedAt;
    };

    const waitForInteractiveReadiness = async (
      session: Session,
      timeoutMs: number,
    ): Promise<void> => {
      const handle = session.runtimeHandle;
      if (!handle) {
        return;
      }

      const deadline = Date.now() + timeoutMs;
      let lastSettledOutput: string | null = null;
      let stablePolls = 0;

      while (true) {
        const [runtimeAlive, processRunning, output, foregroundCommand] = await Promise.all([
          runtimePlugin.isAlive(handle).catch(() => true),
          isAgentProcessNotDefinitelyMissing(agentPlugin, handle),
          captureOutput(handle),
          handle.runtimeName === "tmux"
            ? getTmuxForegroundCommand(handle.id)
            : Promise.resolve(agentPlugin.processName),
        ]);

        const outputReady = output.trim().length > 0;
        const foregroundReady =
          foregroundCommand === null || foregroundCommand === agentPlugin.processName;
        const settledOutput = outputReady ? output.trimEnd() : null;
        const isStable = settledOutput !== null && settledOutput === lastSettledOutput;

        if (
          runtimeAlive &&
          processRunning &&
          foregroundReady &&
          (hasQueuedMessage(output) || isStable)
        ) {
          stablePolls += 1;
          if (stablePolls >= SEND_BOOTSTRAP_STABLE_POLLS) {
            return;
          }
        } else {
          stablePolls = 0;
        }

        lastSettledOutput = settledOutput;

        if (Date.now() >= deadline) {
          return;
        }

        await sleep(SEND_RESTORE_READY_POLL_MS);
      }
    };

    const waitForRestoredSession = async (restoredSession: Session): Promise<boolean> => {
      const handle = restoredSession.runtimeHandle;
      if (!handle) {
        return false;
      }

      const deadline = Date.now() + SEND_RESTORE_READY_TIMEOUT_MS;
      while (true) {
        const [runtimeAlive, processRunning, output, foregroundCommand] = await Promise.all([
          runtimePlugin.isAlive(handle).catch(() => true),
          isAgentProcessNotDefinitelyMissing(agentPlugin, handle),
          captureOutput(handle),
          handle.runtimeName === "tmux"
            ? getTmuxForegroundCommand(handle.id)
            : Promise.resolve(agentPlugin.processName),
        ]);

        const foregroundReady =
          foregroundCommand === null || foregroundCommand === agentPlugin.processName;

        if (runtimeAlive && foregroundReady && (processRunning || output.trim().length > 0)) {
          return true;
        }

        if (Date.now() >= deadline) {
          return false;
        }

        await sleep(SEND_RESTORE_READY_POLL_MS);
      }
    };

    const restoreForDelivery = async (reason: string, session: Session): Promise<Session> => {
      if (session.lifecycle.session.state === "done") {
        throw new Error(`Cannot send to session ${sessionId}: ${reason}`);
      }

      try {
        const restored = await restore(sessionId);
        const ready = await waitForRestoredSession(restored);
        if (!ready) {
          throw new Error("restored session did not become ready for delivery");
        }
        return restored;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Cannot send to session ${sessionId}: ${reason} (${detail})`, {
          cause: err,
        });
      }
    };

    const prepareSession = async (forceRestore = false): Promise<Session> => {
      const current = await get(sessionId);
      if (!current) {
        throw new SessionNotFoundError(sessionId);
      }

      const handle =
        current.runtimeHandle ??
        ({
          id: sessionId,
          runtimeName,
          data: {},
        } satisfies RuntimeHandle);
      const normalized = current.runtimeHandle ? current : { ...current, runtimeHandle: handle };

      if (forceRestore || isRestorable(normalized)) {
        return restoreForDelivery(
          forceRestore
            ? "session needed to be restarted before delivery"
            : "session is not running",
          normalized,
        );
      }

      let [runtimeAlive, processRunning] = await Promise.all([
        runtimePlugin.isAlive(handle).catch(() => true),
        isAgentProcessNotDefinitelyMissing(agentPlugin, handle),
      ]);

      if (normalized.status === "spawning" && runtimeAlive) {
        await waitForInteractiveReadiness(normalized, SEND_BOOTSTRAP_READY_TIMEOUT_MS);
        [runtimeAlive, processRunning] = await Promise.all([
          runtimePlugin.isAlive(handle).catch(() => true),
          isAgentProcessNotDefinitelyMissing(agentPlugin, handle),
        ]);
      }

      if (!runtimeAlive || !processRunning) {
        return restoreForDelivery(
          !runtimeAlive ? "runtime is not alive" : "agent process is not running",
          normalized,
        );
      }

      return normalized;
    };

    const sendWithConfirmation = async (session: Session): Promise<void> => {
      const handle = session.runtimeHandle;
      if (!handle) {
        throw new Error(`Session ${sessionId} has no runtime handle`);
      }

      const baselineOutput = await captureOutput(handle);
      const baselineActivity = detectActivityFromOutput(baselineOutput) ?? session.activity;
      const baselineUpdatedAt = await getOpenCodeSessionUpdatedAt();

      await runtimePlugin.sendMessage(handle, message);

      for (let attempt = 1; attempt <= SEND_CONFIRMATION_ATTEMPTS; attempt++) {
        // Sleep before each check (including the first) so the runtime has time
        // to reflect the message in its output.
        await sleep(SEND_CONFIRMATION_POLL_MS);

        const output = await captureOutput(handle);
        const activity = detectActivityFromOutput(output) ?? session.activity;
        const updatedAt = await getOpenCodeSessionUpdatedAt();
        const delivered =
          (baselineUpdatedAt !== undefined &&
            updatedAt !== undefined &&
            updatedAt > baselineUpdatedAt) ||
          hasQueuedMessage(output) ||
          (output.length > 0 && output !== baselineOutput) ||
          (baselineActivity !== "active" && activity === "active") ||
          (baselineActivity !== "waiting_input" && activity === "waiting_input");

        if (delivered) {
          return;
        }
      }

      // Message was already sent via runtimePlugin.sendMessage above — if we
      // cannot *confirm* delivery (e.g. agent is slow to show output), treat it
      // as a soft success rather than throwing.  Throwing here caused the caller
      // to report failure, which prevented the dispatch-hash from updating and
      // led to duplicate messages on the next poll cycle.
      return;
    };

    let prepared = await prepareSession();

    try {
      await sendWithConfirmation(prepared);
    } catch (err) {
      const shouldRetryWithRestore = prepared.restoredAt === undefined && isRestorable(prepared);

      if (!shouldRetryWithRestore) {
        if (err instanceof Error) {
          throw err;
        }
        throw new Error(String(err), { cause: err });
      }

      prepared = await prepareSession(true);
      try {
        await sendWithConfirmation(prepared);
      } catch (retryErr) {
        if (retryErr instanceof Error) {
          throw retryErr;
        }
        throw new Error(String(retryErr), { cause: retryErr });
      }
    }
  }

  async function claimPR(
    sessionId: SessionId,
    prRef: string,
    options?: ClaimPROptions,
  ): Promise<ClaimPRResult> {
    const reference = prRef.trim();
    if (!reference) throw new Error("PR reference is required");

    const { raw, sessionsDir, project, projectId } = requireSessionRecord(sessionId);
    if (isOrchestratorSessionRecord(sessionId, raw, project.sessionPrefix)) {
      throw new Error(`Session ${sessionId} is an orchestrator session and cannot claim PRs`);
    }

    const plugins = resolvePlugins(
      project,
      resolveSelectionForSession(project, sessionId, raw).agentName,
    );
    const scm = plugins.scm;
    if (!scm?.resolvePR || !scm.checkoutPR) {
      throw new Error(
        `SCM plugin ${project.scm?.plugin ? `"${project.scm.plugin}" ` : ""}does not support claiming existing PRs`,
      );
    }

    const pr = await scm.resolvePR(reference, project);
    const prState = await scm.getPRState(pr);
    if (prState !== PR_STATE.OPEN) {
      throw new Error(`Cannot claim PR #${pr.number} because it is ${prState}`);
    }

    const conflictingSessions = new Set<SessionId>();
    const activeRecords = loadActiveSessionRecords(projectId, project).filter(
      (record) => record.sessionName !== sessionId,
    );

    for (const { sessionName, raw: otherRaw } of activeRecords) {
      if (!otherRaw || isOrchestratorSessionRecord(sessionName, otherRaw, project.sessionPrefix))
        continue;

      const samePr = otherRaw["pr"] === pr.url;
      const sameBranch =
        otherRaw["branch"] === pr.branch && (otherRaw["prAutoDetect"] ?? "on") !== "off" && otherRaw["prAutoDetect"] !== "false";

      if (samePr || sameBranch) {
        conflictingSessions.add(sessionName);
      }
    }

    const takenOverFrom = [...conflictingSessions];

    const workspacePath = raw["worktree"];
    if (!workspacePath) {
      throw new Error(`Session ${sessionId} has no workspace to check out PR #${pr.number}`);
    }

    const branchChanged = await scm.checkoutPR(pr, workspacePath);

    const claimLifecycle = buildUpdatedLifecycle(sessionId, raw, (next) => {
      next.pr.state = "open";
      next.pr.reason = "in_progress";
      next.pr.number = pr.number;
      next.pr.url = pr.url;
      next.pr.lastObservedAt = new Date().toISOString();
    });
    updateMetadata(sessionsDir, sessionId, {
      pr: pr.url,
      status: deriveLegacyStatus(claimLifecycle),
      branch: pr.branch,
      prAutoDetect: "",
      ...lifecycleMetadataUpdates(raw, claimLifecycle),
    });
    invalidateCache();

    for (const previousSessionId of takenOverFrom) {
      const previousRaw = readMetadataRaw(sessionsDir, previousSessionId);
      if (!previousRaw) continue;

      const previousLifecycle = buildUpdatedLifecycle(previousSessionId, previousRaw, (next) => {
        next.pr.state = "none";
        next.pr.reason = "not_created";
        next.pr.number = null;
        next.pr.url = null;
        next.pr.lastObservedAt = null;
        if (PR_TRACKING_STATUSES.has(previousRaw["status"] ?? "")) {
          next.session.state = "working";
          next.session.reason = "task_in_progress";
        }
      });
      updateMetadata(sessionsDir, previousSessionId, {
        pr: "",
        prAutoDetect: "false",
        ...(PR_TRACKING_STATUSES.has(previousRaw["status"] ?? "")
          ? { status: "working" }
          : {}),
        ...lifecycleMetadataUpdates(previousRaw, previousLifecycle),
      });
      invalidateCache();
    }

    let githubAssigned = false;
    let githubAssignmentError: string | undefined;
    if (options?.assignOnGithub) {
      if (!scm.assignPRToCurrentUser) {
        githubAssignmentError = `SCM plugin "${scm.name}" does not support assigning PRs`;
      } else {
        try {
          await scm.assignPRToCurrentUser(pr);
          githubAssigned = true;
        } catch (err) {
          githubAssignmentError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    return {
      sessionId,
      projectId,
      pr,
      branchChanged,
      githubAssigned,
      githubAssignmentError,
      takenOverFrom,
    };
  }

  async function remap(sessionId: SessionId, force = false): Promise<string> {
    const { raw, sessionsDir, project } = requireSessionRecord(sessionId);

    const selection = resolveSelectionForSession(project, sessionId, raw);
    const selectedAgent = selection.agentName;
    if (selectedAgent !== "opencode") {
      throw new Error(`Session ${sessionId} is not using the opencode agent`);
    }

    const mapped = asValidOpenCodeSessionId(raw["opencodeSessionId"]);
    const discovered = force
      ? await discoverOpenCodeSessionIdByTitle(sessionId, OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS)
      : (mapped ??
        (await discoverOpenCodeSessionIdByTitle(
          sessionId,
          OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS,
        )));
    if (!discovered) {
      throw new Error(`OpenCode session mapping is missing for ${sessionId}`);
    }

    updateMetadata(sessionsDir, sessionId, { opencodeSessionId: discovered });
    return discovered;
  }

  async function restore(sessionId: SessionId): Promise<Session> {
    // 1. Find session metadata across all projects
    const activeRecord = findSessionRecord(sessionId);
    if (!activeRecord) {
      throw new SessionNotFoundError(sessionId);
    }

    let raw: Record<string, string> = activeRecord.raw;
    const sessionsDir: string = activeRecord.sessionsDir;
    const project: ProjectConfig = activeRecord.project;
    const projectId: string = activeRecord.projectId;

    const selection = resolveSelectionForSession(project, sessionId, raw);
    const selectedAgent = selection.agentName;
    if (selectedAgent === "opencode" && !asValidOpenCodeSessionId(raw["opencodeSessionId"])) {
      const discovered = await discoverOpenCodeSessionIdByTitle(
        sessionId,
        OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS,
      );
      if (!discovered) {
        throw new SessionNotRestorableError(sessionId, "OpenCode session mapping is missing");
      }
      raw = { ...raw, opencodeSessionId: discovered };
      updateMetadata(sessionsDir, sessionId, { opencodeSessionId: discovered });
    }

    // 2. Reconstruct Session from metadata and enrich with live runtime state.
    //    metadataToSession sets activity: null, so without enrichment a crashed
    //    session (status "working", agent exited) would not be detected as terminal
    //    and isRestorable would reject it.
    const session = metadataToSession(sessionId, raw, projectId, project.sessionPrefix);
    const plugins = resolvePlugins(project, selection.agentName);
    await enrichSessionWithRuntimeState(session, plugins, true, sessionsDir);

    // 3. Validate restorability
    if (!isRestorable(session)) {
      const reason = NON_RESTORABLE_STATUSES.has(session.status)
        ? `status "${session.status}" is not restorable`
        : `session is not in a terminal state (status: "${session.status}", activity: "${session.activity}")`;
      throw new SessionNotRestorableError(sessionId, reason);
    }

    // 4. Validate required plugins (plugins already resolved above for enrichment)
    if (!plugins.runtime) {
      throw new Error(`Runtime plugin '${project.runtime ?? config.defaults.runtime}' not found`);
    }
    if (!plugins.agent) {
      throw new Error(`Agent plugin '${selection.agentName}' not found`);
    }

    // 5. Check workspace
    const workspacePath = raw["worktree"] || project.path;
    const workspaceExists = plugins.workspace?.exists
      ? await plugins.workspace.exists(workspacePath)
      : existsSync(workspacePath);

    if (!workspaceExists) {
      // Try to restore workspace if plugin supports it
      if (!plugins.workspace?.restore) {
        throw new WorkspaceMissingError(workspacePath, "workspace plugin does not support restore");
      }
      if (!session.branch) {
        throw new WorkspaceMissingError(workspacePath, "branch metadata is missing");
      }
      try {
        const wsInfo = await plugins.workspace.restore(
          {
            projectId,
            project,
            sessionId,
            branch: session.branch,
            worktreeDir: getProjectWorktreesDir(projectId),
          },
          workspacePath,
        );

        // Run post-create hooks on restored workspace
        if (plugins.workspace.postCreate) {
          await plugins.workspace.postCreate(wsInfo, project);
        }
      } catch (err) {
        throw new WorkspaceMissingError(
          workspacePath,
          `restore failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (plugins.agent.name === "opencode" && selection.role === "orchestrator") {
      const projectDir = getProjectDir(projectId);
      const systemPromptFile = join(projectDir, `orchestrator-prompt-${sessionId}.md`);
      if (existsSync(systemPromptFile)) {
        try {
          writeWorkspaceOpenCodeAgentsMd(workspacePath, systemPromptFile);
        } catch (err) {
          throw new Error(
            `failed to restore OpenCode orchestrator AGENTS.md: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
      }
    }

    let opencodeConfigPath: string | undefined;
    if (plugins.agent.name === "opencode" && selection.role !== "orchestrator") {
      const baseDir = getProjectDir(projectId!);
      const systemPromptFile = join(baseDir, `worker-prompt-${sessionId}.md`);
      if (existsSync(systemPromptFile)) {
        opencodeConfigPath = writeOpenCodeConfig(baseDir, sessionId, [systemPromptFile]);
      }
    }

    // 6. Destroy old runtime if still alive (e.g. tmux session survives agent crash)
    if (session.runtimeHandle) {
      try {
        await plugins.runtime.destroy(session.runtimeHandle);
      } catch {
        // Best effort — may already be gone
      }
    }

    // 7. Get launch command — try restore command first, fall back to fresh launch
    let launchCommand: string;
    const projectConfigForLaunch: ProjectConfig = {
      ...project,
      agentConfig: {
        ...selection.agentConfig,
        ...(selection.role === "orchestrator" ? { permissions: "permissionless" as const } : {}),
        ...(session.metadata?.opencodeSessionId
          ? { opencodeSessionId: session.metadata.opencodeSessionId }
          : {}),
      },
    };
    // Orchestrator launches need the original systemPromptFile so the agent
    // boots as the orchestrator (not a bare TUI). spawnOrchestrator wrote it to
    // {baseDir}/orchestrator-prompt-{sessionId}.md and references it via
    // agentLaunchConfig.systemPromptFile. On restore we must re-attach it,
    // otherwise getLaunchCommand() (the fallback when getRestoreCommand returns
    // null — e.g. Codex with no resumable thread for the worktree) starts a
    // plain agent without orchestrator instructions.
    const orchestratorSystemPromptFile = ((): string | undefined => {
      if (selection.role !== "orchestrator") return undefined;
      // V2 storage: orchestrator-prompt-{sessionId}.md lives in the project dir
      // (~/.agent-orchestrator/projects/{projectId}/), not the legacy hashed base dir.
      const baseDir = getProjectDir(projectId);
      const file = join(baseDir, `orchestrator-prompt-${sessionId}.md`);
      return existsSync(file) ? file : undefined;
    })();

    const agentLaunchConfig = {
      sessionId,
      projectConfig: projectConfigForLaunch,
      workspacePath,
      issueId: session.issueId ?? undefined,
      permissions: selection.role === "orchestrator" ? "permissionless" : selection.permissions,
      model: selection.model,
      subagent: selection.subagent,
      ...(orchestratorSystemPromptFile && { systemPromptFile: orchestratorSystemPromptFile }),
    };

    if (plugins.agent.getRestoreCommand) {
      const restoreCmd = await plugins.agent.getRestoreCommand(session, projectConfigForLaunch);
      if (restoreCmd) {
        launchCommand = restoreCmd;
        updateMetadata(sessionsDir, sessionId, { restoreFallbackReason: "" });
      } else {
        const reason = `${plugins.agent.name}.getRestoreCommand returned null`;
        updateMetadata(sessionsDir, sessionId, {
          restoreFallbackReason: reason,
        });
        if (requiresNativeRestore(plugins.agent.name)) {
          throw new SessionNotRestorableError(sessionId, reason);
        }
        launchCommand = plugins.agent.getLaunchCommand(agentLaunchConfig);
      }
    } else {
      launchCommand = plugins.agent.getLaunchCommand(agentLaunchConfig);
      updateMetadata(sessionsDir, sessionId, { restoreFallbackReason: "" });
    }

    const environment = plugins.agent.getEnvironment(agentLaunchConfig);

    if (plugins.agent.preLaunchSetup) {
      await plugins.agent.preLaunchSetup(workspacePath);
    }

    // 8. Create runtime (reuse tmuxName from metadata)
    const tmuxName = raw["tmuxName"];
    const handle = await plugins.runtime.create({
      sessionId: tmuxName ?? sessionId,
      workspacePath,
      launchCommand,
      environment: {
        ...environment,
        ...(opencodeConfigPath ? { OPENCODE_CONFIG: opencodeConfigPath } : {}),
        ...(project.env ?? {}),
        PATH: buildAgentPath(environment["PATH"] ?? process.env["PATH"]),
        GH_PATH: PREFERRED_GH_PATH,
        ...(process.env["AO_AGENT_GH_TRACE"] && {
          AO_AGENT_GH_TRACE: process.env["AO_AGENT_GH_TRACE"],
        }),
        AO_SESSION: sessionId,
        AO_DATA_DIR: sessionsDir,
        AO_SESSION_NAME: sessionId,
        ...(tmuxName && { AO_TMUX_NAME: tmuxName }),
        AO_CALLER_TYPE: "agent",
        ...(projectId && { AO_PROJECT_ID: projectId }),
        AO_CONFIG_PATH: config.configPath,
        ...(config.port !== undefined && config.port !== null && { AO_PORT: String(config.port) }),
      },
    });

    // 9. Update metadata — reset lifecycle to working state
    const now = new Date().toISOString();
    const restoredLifecycle = cloneLifecycle(session.lifecycle);
    restoredLifecycle.session.state = "working";
    restoredLifecycle.session.reason = "task_in_progress";
    restoredLifecycle.session.lastTransitionAt = now;
    restoredLifecycle.session.terminatedAt = null;
    restoredLifecycle.session.completedAt = null;
    restoredLifecycle.runtime.state = "alive";
    restoredLifecycle.runtime.reason = "process_running";
    restoredLifecycle.runtime.handle = handle;
    restoredLifecycle.runtime.lastObservedAt = now;

    // Reset terminal PR state so the lifecycle manager doesn't immediately
    // re-terminate the session. The old PR is done — if the agent creates
    // a new one, PR auto-detect will pick it up.
    if (restoredLifecycle.pr.state === "merged" || restoredLifecycle.pr.state === "closed") {
      restoredLifecycle.pr.state = "none";
      restoredLifecycle.pr.reason = "cleared_on_restore";
      restoredLifecycle.pr.number = null;
      restoredLifecycle.pr.url = null;
      restoredLifecycle.pr.lastObservedAt = null;
    }

    updateMetadata(sessionsDir, sessionId, {
      ...buildLifecycleMetadataPatch(restoredLifecycle),
      restoredAt: now,
      mergedPendingCleanupSince: "",
    });
    invalidateCache();

    // 10. Run postLaunchSetup (non-fatal)
    const restoredStatus = deriveLegacyStatus(restoredLifecycle);
    const restoredSession: Session = {
      ...session,
      status: restoredStatus,
      activity: "active",
      workspacePath,
      runtimeHandle: handle,
      restoredAt: new Date(now),
    };

    if (plugins.agent.postLaunchSetup) {
      try {
        const metadataBeforePostLaunch = { ...(restoredSession.metadata ?? {}) };
        await plugins.agent.postLaunchSetup(restoredSession);

        const metadataAfterPostLaunch = restoredSession.metadata ?? {};
        const metadataUpdates = Object.fromEntries(
          Object.entries(metadataAfterPostLaunch).filter(
            ([key, value]) => metadataBeforePostLaunch[key] !== value,
          ),
        );

        if (Object.keys(metadataUpdates).length > 0) {
          updateMetadata(sessionsDir, sessionId, metadataUpdates);
          invalidateCache();
        }
      } catch {
        // Non-fatal — session is already running
      }
    }

    return restoredSession;
  }

  return {
    spawn,
    spawnOrchestrator,
    ensureOrchestrator,
    restore,
    list,
    listCached,
    invalidateCache,
    get,
    kill,
    cleanup,
    send,
    claimPR,
    remap,
  };
}
