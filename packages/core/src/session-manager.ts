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

import { statSync, existsSync, readdirSync, writeFileSync, mkdirSync, utimesSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  isIssueNotFoundError,
  isRestorable,
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
  type OrchestratorConfig,
  type ProjectConfig,
  type Runtime,
  type Agent,
  type Workspace,
  type Tracker,
  type SCM,
  type PluginRegistry,
  type RuntimeHandle,
  type Issue,
  PR_STATE,
} from "./types.js";
import {
  readMetadataRaw,
  readArchivedMetadataRaw,
  updateArchivedMetadata,
  writeMetadata,
  updateMetadata,
  deleteMetadata,
  listMetadata,
  reserveSessionId,
} from "./metadata.js";
import { buildPrompt } from "./prompt-builder.js";
import {
  getSessionsDir,
  getWorktreesDir,
  getProjectBaseDir,
  generateConfigHash,
  generateTmuxName,
  validateAndStoreOrigin,
} from "./paths.js";
import { asValidOpenCodeSessionId } from "./opencode-session-id.js";
import { normalizeOrchestratorSessionStrategy } from "./orchestrator-session-strategy.js";
import { sessionFromMetadata } from "./utils/session-from-metadata.js";
import { safeJsonParse } from "./utils/validation.js";
import { resolveAgentSelection, resolveSessionRole } from "./agent-selection.js";

const execFileAsync = promisify(execFile);
const OPENCODE_DISCOVERY_TIMEOUT_MS = 10_000;
const OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS = 10_000;

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
      });
      return;
    } catch (err) {
      if (errorIncludesSessionNotFound(err)) {
        return;
      }
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

interface OpenCodeSessionListEntry {
  id: string;
  title: string;
  updatedAt?: number;
}

async function fetchOpenCodeSessionList(
  timeoutMs = OPENCODE_DISCOVERY_TIMEOUT_MS,
): Promise<OpenCodeSessionListEntry[]> {
  try {
    const { stdout } = await execFileAsync("opencode", ["session", "list", "--format", "json"], {
      timeout: timeoutMs,
    });
    const parsed = safeJsonParse<unknown>(stdout);
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const title = typeof entry["title"] === "string" ? entry["title"] : "";
      const id = asValidOpenCodeSessionId(entry["id"]);
      if (!id) return [];
      const rawUpdated = entry["updated"];
      let updatedAt: number | undefined;
      if (typeof rawUpdated === "number" && Number.isFinite(rawUpdated)) {
        updatedAt = rawUpdated;
      } else if (typeof rawUpdated === "string") {
        const parsedUpdated = Date.parse(rawUpdated);
        if (!Number.isNaN(parsedUpdated)) {
          updatedAt = parsedUpdated;
        }
      }
      return [{ id, title, ...(updatedAt !== undefined ? { updatedAt } : {}) }];
    });
  } catch {
    return [];
  }
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

const SEND_RESTORE_READY_TIMEOUT_MS = 5_000;
const SEND_RESTORE_READY_POLL_MS = 500;
const SEND_CONFIRMATION_ATTEMPTS = 6;
const SEND_CONFIRMATION_POLL_MS = 500;
const SEND_CONFIRMATION_OUTPUT_LINES = 20;
const SEND_BOOTSTRAP_READY_TIMEOUT_MS = 20_000;
const SEND_BOOTSTRAP_STABLE_POLLS = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getTmuxForegroundCommand(sessionName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["display-message", "-p", "-t", sessionName, "#{pane_current_command}"],
      { timeout: 5_000 },
    );
    const command = stdout.trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}

/** Reconstruct a Session object from raw metadata key=value pairs. */
function metadataToSession(
  sessionId: SessionId,
  meta: Record<string, string>,
  projectId: string,
  createdAt?: Date,
  modifiedAt?: Date,
): Session {
  return sessionFromMetadata(sessionId, meta, {
    projectId,
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

  /**
   * Get the sessions directory for a project.
   */
  function getProjectSessionsDir(project: ProjectConfig): string {
    return getSessionsDir(config.configPath, project.path);
  }

  function normalizePath(path: string): string {
    return resolve(path).replace(/\/$/, "");
  }

  function isPathInside(path: string, parentPath: string): boolean {
    const normalizedPath = normalizePath(path);
    const normalizedParent = normalizePath(parentPath);
    return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
  }

  function getManagedWorkspaceRoots(project: ProjectConfig, projectId?: string): string[] {
    const roots = [getWorktreesDir(config.configPath, project.path)];
    const legacyIds = new Set<string>();
    if (projectId) {
      legacyIds.add(projectId);
    }
    legacyIds.add(basename(project.path));

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
    if (!project) return false;
    if (normalizePath(workspacePath) === normalizePath(project.path)) return false;

    const roots = getManagedWorkspaceRoots(project, projectId);
    return roots.some((root) => isPathInside(workspacePath, root));
  }

  function listArchivedSessionIds(sessionsDir: string): string[] {
    const archiveDir = join(sessionsDir, "archive");
    if (!existsSync(archiveDir)) return [];
    const ids = new Set<string>();
    for (const file of readdirSync(archiveDir)) {
      const match = file.match(/^([a-zA-Z0-9_-]+)_\d/);
      if (match?.[1]) ids.add(match[1]);
    }
    return [...ids];
  }

  function isOrchestratorSessionRecord(
    sessionId: string,
    raw: Record<string, string> | null | undefined,
    sessionPrefix?: string,
  ): boolean {
    if (!raw) return false;
    if (raw["role"] === "orchestrator" || sessionId.endsWith("-orchestrator")) return true;
    // Check the -orchestrator-N pattern only when the prefix is known so the
    // regex is anchored to the project prefix, preventing false-positives when
    // the user-configured sessionPrefix itself ends with "-orchestrator".
    if (sessionPrefix) {
      return new RegExp(`^${escapeRegex(sessionPrefix)}-orchestrator-\\d+$`).test(sessionId);
    }
    return false;
  }

  function isCleanupProtectedSession(
    project: ProjectConfig,
    sessionId: string,
    metadata?: Record<string, string> | null,
  ): boolean {
    return isOrchestratorSessionRecord(sessionId, metadata ?? {}, project.sessionPrefix);
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

  function updateMetadataPreservingMtime(
    sessionsDir: string,
    sessionName: string,
    updates: Partial<Record<string, string>>,
    modifiedAt?: Date,
  ): void {
    const metaPath = join(sessionsDir, sessionName);
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
    if (repaired.raw["prAutoDetect"] !== "off") {
      updates["prAutoDetect"] = "off";
    }
    if (STALE_PR_OWNERSHIP_STATUSES.has(repaired.raw["status"] ?? "")) {
      updates["status"] = "working";
    }

    if (Object.keys(updates).length > 0) {
      updateMetadataPreservingMtime(
        sessionsDir,
        repaired.sessionName,
        updates,
        repaired.modifiedAt,
      );
      repaired.raw = applyMetadataUpdatesToRaw(repaired.raw, updates);
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
          prAutoDetect: "off",
          ...(PR_TRACKING_STATUSES.has(record.raw["status"] ?? "") ? { status: "working" } : {}),
        };
        updateMetadataPreservingMtime(sessionsDir, record.sessionName, updates, record.modifiedAt);
        record.raw = applyMetadataUpdatesToRaw(record.raw, updates);
      }
    }

    return repaired;
  }

  function loadActiveSessionRecords(project: ProjectConfig): ActiveSessionRecord[] {
    const sessionsDir = getProjectSessionsDir(project);
    if (!existsSync(sessionsDir)) return [];

    const records = listMetadata(sessionsDir).flatMap((sessionName) => {
      const raw = readMetadataRaw(sessionsDir, sessionName);
      if (!raw) return [];

      let modifiedAt: Date | undefined;
      try {
        modifiedAt = statSync(join(sessionsDir, sessionName)).mtime;
      } catch {
        void 0;
      }

      return [{ sessionName, raw, modifiedAt } satisfies ActiveSessionRecord];
    });

    return repairSessionMetadataOnRead(sessionsDir, records, project.sessionPrefix);
  }

  function markArchivedOpenCodeCleanup(sessionsDir: string, sessionId: SessionId): void {
    updateArchivedMetadata(sessionsDir, sessionId, {
      opencodeSessionId: "",
      opencodeCleanedAt: new Date().toISOString(),
    });
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
    for (const id of sortSessionIdsForReuse(listArchivedSessionIds(sessionsDir))) {
      maybeAdd(id, readArchivedMetadataRaw(sessionsDir, id));
    }

    if (criteria.sessionId) {
      maybeAdd(criteria.sessionId, readArchivedMetadataRaw(sessionsDir, criteria.sessionId));
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
    for (const sessionName of [
      ...listMetadata(sessionsDir),
      ...listArchivedSessionIds(sessionsDir),
    ]) {
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
      const tmuxName = config.configPath
        ? generateTmuxName(config.configPath, project.sessionPrefix, num)
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

  /**
   * Reserve a unique orchestrator identity ({prefix}-orchestrator-N) for a worktree-based orchestrator.
   * Unlike worker sessions, orchestrator IDs are assigned locally without remote branch checks.
   */
  function reserveNextOrchestratorIdentity(
    project: ProjectConfig,
    sessionsDir: string,
  ): { num: number; sessionId: string; tmuxName: string | undefined } {
    const orchestratorPrefix = `${project.sessionPrefix}-orchestrator`;
    const usedNumbers = new Set<number>();

    const orchestratorPattern = new RegExp(`^${escapeRegex(orchestratorPrefix)}-(\\d+)$`);
    for (const sessionName of [
      ...listMetadata(sessionsDir),
      ...listArchivedSessionIds(sessionsDir),
    ]) {
      const match = sessionName.match(orchestratorPattern);
      if (match) {
        const parsed = Number.parseInt(match[1], 10);
        if (!Number.isNaN(parsed)) usedNumbers.add(parsed);
      }
    }

    // Build worker-ID patterns for all other projects. If another project has
    // sessionPrefix === orchestratorPrefix (e.g. project B has prefix "app-orchestrator"),
    // then its workers are named "app-orchestrator-1", "app-orchestrator-2", etc. — which
    // would collide with our orchestrator IDs. Detect this impossible configuration early.
    for (const [otherProjectId, otherProject] of Object.entries(config.projects)) {
      const otherPrefix = otherProject.sessionPrefix ?? otherProjectId;
      if (otherPrefix === project.sessionPrefix) continue;
      if (otherPrefix === orchestratorPrefix) {
        // Another project's workers are "{otherPrefix}-\d+" which equals "{orchestratorPrefix}-\d+".
        // Every candidate ID we would generate collides — fail immediately with a clear message.
        throw new Error(
          `Cannot spawn orchestrator for project "${project.sessionPrefix}": the orchestrator ID prefix "${orchestratorPrefix}" ` +
            `conflicts with the session prefix of project "${otherProjectId}" ("${otherPrefix}"). ` +
            `Rename one of the project sessionPrefix values to avoid this overlap.`,
        );
      }
    }

    let num = 1;
    for (let attempts = 0; attempts < 10_000; attempts++) {
      if (!usedNumbers.has(num)) {
        const sessionId = `${orchestratorPrefix}-${num}`;
        const tmuxName = config.configPath
          ? generateTmuxName(config.configPath, orchestratorPrefix, num)
          : undefined;
        if (reserveSessionId(sessionsDir, sessionId)) {
          return { num, sessionId, tmuxName };
        }
      }
      num += 1;
    }

    throw new Error(
      `Failed to reserve orchestrator session ID after 10000 attempts (prefix: ${orchestratorPrefix})`,
    );
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
    const tracker =
      project.tracker?.plugin ? registry.get<Tracker>("tracker", project.tracker.plugin) : null;
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
      const sessionsDir = getProjectSessionsDir(project);
      const raw = readMetadataRaw(sessionsDir, sessionId);
      if (!raw) continue;

      let modifiedAt: Date | undefined;
      try {
        modifiedAt = statSync(join(sessionsDir, sessionId)).mtime;
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
    await enrichSessionWithRuntimeState(session, plugins, handleFromMetadata);
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
  ): Promise<void> {
    // Skip all subprocess/IO work for sessions already known to be terminal.
    if (TERMINAL_SESSION_STATUSES.has(session.status)) {
      session.activity = "exited";
      return;
    }

    // Check runtime liveness — but only if the handle came from metadata.
    // Fabricated handles (constructed as fallback for external sessions) should
    // NOT override status to "killed" — we don't know if the session ever had
    // a tmux session, and we'd clobber meaningful statuses like "pr_open".
    if (handleFromMetadata && session.runtimeHandle && plugins.runtime) {
      try {
        const alive = await plugins.runtime.isAlive(session.runtimeHandle);
        if (!alive) {
          session.status = "killed";
          session.activity = "exited";
          return;
        }
      } catch {
        // Can't check liveness — continue to activity detection
      }
    }

    // Detect activity independently of runtime handle.
    // Activity detection reads JSONL files on disk — it only needs workspacePath,
    // not a runtime handle. Gating on runtimeHandle caused sessions created by
    // external scripts (which don't store runtimeHandle) to always show "unknown".
    if (plugins.agent) {
      try {
        const detected = await plugins.agent.getActivityState(session, config.readyThresholdMs);
        if (detected !== null) {
          session.activity = detected.state;
          if (detected.timestamp && detected.timestamp > session.lastActivityAt) {
            session.lastActivityAt = detected.timestamp;
          }
        }
      } catch {
        // Can't detect activity — keep existing value
      }

      // Enrich with live agent session info (summary, cost).
      try {
        const info = await plugins.agent.getSessionInfo(session);
        if (info) {
          session.agentInfo = info;
        }
      } catch {
        // Can't get session info — keep existing values
      }
    }
  }

  // Define methods as local functions so `this` is not needed
  async function spawn(spawnConfig: SessionSpawnConfig): Promise<Session> {
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
    const sessionsDir = getProjectSessionsDir(project);

    // Validate and store .origin file (new architecture only)
    if (config.configPath) {
      validateAndStoreOrigin(config.configPath, project.path);
    }

    // Determine session ID — atomically reserve to prevent concurrent collisions
    const { sessionId, tmuxName } = await reserveNextSessionIdentity(project, sessionsDir);

    // Determine branch name — explicit branch always takes priority
    let branch: string;
    if (spawnConfig.branch) {
      branch = spawnConfig.branch;
    } else if (spawnConfig.issueId && plugins.tracker && resolvedIssue) {
      branch = plugins.tracker.branchName(spawnConfig.issueId, project);
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
      try {
        const wsInfo = await plugins.workspace.create({
          projectId: spawnConfig.projectId,
          project,
          sessionId,
          branch,
        });
        workspacePath = wsInfo.path;

        // Run post-create hooks — clean up workspace on failure
        if (plugins.workspace.postCreate) {
          try {
            await plugins.workspace.postCreate(wsInfo, project);
          } catch (err) {
            if (shouldDestroyWorkspacePath(project, spawnConfig.projectId, workspacePath)) {
              try {
                await plugins.workspace.destroy(workspacePath);
              } catch {
                /* best effort */
              }
            }
            throw err;
          }
        }
      } catch (err) {
        // Clean up reserved session ID on workspace failure
        try {
          deleteMetadata(sessionsDir, sessionId, false);
        } catch {
          /* best effort */
        }
        throw err;
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

    const composedPrompt = buildPrompt({
      project,
      projectId: spawnConfig.projectId,
      issueId: spawnConfig.issueId,
      issueContext,
      userPrompt: spawnConfig.prompt,
      lineage: spawnConfig.lineage,
      siblings: spawnConfig.siblings,
    });

    // Get agent launch config and create runtime — clean up workspace on failure
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
      issueId: spawnConfig.issueId,
      prompt: composedPrompt,
      permissions: selection.permissions,
      model: selection.model,
      subagent: spawnConfig.subagent ?? selection.subagent,
    };

    let handle: RuntimeHandle;
    try {
      const launchCommand = plugins.agent.getLaunchCommand(agentLaunchConfig);
      const environment = plugins.agent.getEnvironment(agentLaunchConfig);

      handle = await plugins.runtime.create({
        sessionId: tmuxName ?? sessionId, // Use tmux name for runtime if available
        workspacePath,
        launchCommand,
        environment: {
          ...environment,
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
    } catch (err) {
      // Clean up workspace and reserved ID if agent config or runtime creation failed
      if (
        plugins.workspace &&
        shouldDestroyWorkspacePath(project, spawnConfig.projectId, workspacePath)
      ) {
        try {
          await plugins.workspace.destroy(workspacePath);
        } catch {
          /* best effort */
        }
      }
      try {
        deleteMetadata(sessionsDir, sessionId, false);
      } catch {
        /* best effort */
      }
      throw err;
    }

    // Write metadata and run post-launch setup — clean up on failure
    const session: Session = {
      id: sessionId,
      projectId: spawnConfig.projectId,
      status: "spawning",
      activity: "active",
      branch,
      issueId: spawnConfig.issueId ?? null,
      pr: null,
      workspacePath,
      runtimeHandle: handle,
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {
        ...(reusedOpenCodeSessionId ? { opencodeSessionId: reusedOpenCodeSessionId } : {}),
      },
    };

    try {
      writeMetadata(sessionsDir, sessionId, {
        worktree: workspacePath,
        branch,
        status: "spawning",
        tmuxName, // Store tmux name for mapping
        issue: spawnConfig.issueId,
        project: spawnConfig.projectId,
        agent: selection.agentName, // Persist agent name for lifecycle manager
        createdAt: new Date().toISOString(),
        runtimeHandle: JSON.stringify(handle),
        opencodeSessionId: reusedOpenCodeSessionId,
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
    } catch (err) {
      // Clean up runtime and workspace on post-launch failure
      try {
        await plugins.runtime.destroy(handle);
      } catch {
        /* best effort */
      }
      if (
        plugins.workspace &&
        shouldDestroyWorkspacePath(project, spawnConfig.projectId, workspacePath)
      ) {
        try {
          await plugins.workspace.destroy(workspacePath);
        } catch {
          /* best effort */
        }
      }
      try {
        deleteMetadata(sessionsDir, sessionId, false);
      } catch {
        /* best effort */
      }
      throw err;
    }

    // Send initial prompt post-launch for agents that need it (e.g. Claude Code
    // exits after -p, so we send the prompt after it starts in interactive mode).
    // This is intentionally outside the try/catch above — a prompt delivery failure
    // should NOT destroy the session. The agent is running; user can retry with `ao send`.
    let promptDelivered = false;
    if (plugins.agent.promptDelivery === "post-launch" && agentLaunchConfig.prompt) {
      const maxRetries = 3;
      const baseDelayMs = 3_000;
      let lastError: Error | undefined;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // Wait for agent to start and be ready for input
          // Use exponential backoff: 3s, 6s, 9s between attempts
          await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
          await plugins.runtime.sendMessage(handle, agentLaunchConfig.prompt);
          promptDelivered = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          console.error(
            `[session-manager] Prompt delivery attempt ${attempt}/${maxRetries} failed: ${lastError.message}`,
          );
        }
      }

      if (!promptDelivered) {
        console.error(
          `[session-manager] FAILED to deliver prompt to session ${sessionId} after ${maxRetries} attempts. ` +
            `User must send manually with 'ao send'. Last error: ${lastError?.message}`,
        );
      }

      session.metadata["promptDelivered"] = String(promptDelivered);
    } else if (agentLaunchConfig.prompt) {
      session.metadata["promptDelivered"] = "true";
    }

    if (session.metadata["promptDelivered"]) {
      updateMetadata(sessionsDir, sessionId, session.metadata);
    }

    return session;
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
    });
    const plugins = resolvePlugins(project, selection.agentName);
    if (!plugins.runtime) {
      throw new Error(`Runtime plugin '${project.runtime ?? config.defaults.runtime}' not found`);
    }
    if (!plugins.agent) {
      throw new Error(`Agent plugin '${selection.agentName}' not found`);
    }

    const orchestratorSessionStrategy = normalizeOrchestratorSessionStrategy(
      project.orchestratorSessionStrategy,
    );
    const orchestratorWorkspaceMode = project.orchestratorWorkspaceMode ?? "isolated";

    // Get the sessions directory for this project
    const sessionsDir = getProjectSessionsDir(project);

    // Validate and store .origin file before reserving any identity so that
    // a validation failure does not leave an orphaned metadata entry.
    if (config.configPath) {
      validateAndStoreOrigin(config.configPath, project.path);
    }

    let sessionId: string;
    let tmuxName: string | undefined;
    let branch: string;
    let workspacePath: string;

    if (orchestratorWorkspaceMode === "project") {
      sessionId = `${project.sessionPrefix}-orchestrator`;
      tmuxName = config.configPath ? `${generateConfigHash(config.configPath)}-${sessionId}` : undefined;
      branch = project.defaultBranch;
      workspacePath = project.path;

      if (plugins.agent.setupWorkspaceHooks) {
        await plugins.agent.setupWorkspaceHooks(workspacePath, { dataDir: sessionsDir });
      }

      const existingRaw = readMetadataRaw(sessionsDir, sessionId);
      const existingOrchestrator = existingRaw?.["runtimeHandle"]
        ? metadataToSession(sessionId, existingRaw, orchestratorConfig.projectId)
        : null;
      if (existingOrchestrator?.runtimeHandle) {
        const existingAlive = await plugins.runtime
          .isAlive(existingOrchestrator.runtimeHandle)
          .catch(() => false);
        if (
          existingAlive &&
          (orchestratorSessionStrategy === "reuse" || orchestratorSessionStrategy === "ignore")
        ) {
          const persistedRaw = readMetadataRaw(sessionsDir, sessionId);
          if (persistedRaw?.["runtimeHandle"]) {
            const persisted = metadataToSession(
              sessionId,
              persistedRaw,
              orchestratorConfig.projectId,
            );
            persisted.metadata["orchestratorSessionReused"] = "true";
            return persisted;
          }
          await plugins.runtime.destroy(existingOrchestrator.runtimeHandle).catch(() => undefined);
          deleteMetadata(sessionsDir, sessionId, false);
        } else if (existingAlive) {
          await plugins.runtime.destroy(existingOrchestrator.runtimeHandle).catch(() => undefined);
          deleteMetadata(sessionsDir, sessionId, false);
        } else {
          deleteMetadata(
            sessionsDir,
            sessionId,
            orchestratorSessionStrategy === "reuse" || orchestratorSessionStrategy === "ignore",
          );
        }
      }

      let reserved = reserveSessionId(sessionsDir, sessionId);
      if (!reserved) {
        const concurrentRaw = readMetadataRaw(sessionsDir, sessionId);
        const concurrentSession = concurrentRaw?.["runtimeHandle"]
          ? metadataToSession(sessionId, concurrentRaw, orchestratorConfig.projectId)
          : null;
        if (concurrentSession?.runtimeHandle) {
          const concurrentAlive = await plugins.runtime
            .isAlive(concurrentSession.runtimeHandle)
            .catch(() => false);
          if (
            concurrentAlive &&
            (orchestratorSessionStrategy === "reuse" || orchestratorSessionStrategy === "ignore")
          ) {
            concurrentSession.metadata["orchestratorSessionReused"] = "true";
            return concurrentSession;
          }
          if (!concurrentAlive) {
            deleteMetadata(
              sessionsDir,
              sessionId,
              orchestratorSessionStrategy === "reuse" ||
                orchestratorSessionStrategy === "ignore",
            );
            reserved = reserveSessionId(sessionsDir, sessionId);
          }
        } else {
          reserved = reserveSessionId(sessionsDir, sessionId);
        }
        if (!reserved) {
          throw new Error(`Session ${sessionId} already exists but is not in a reusable state`);
        }
      }
    } else {
      // Reserve a new unique orchestrator identity (e.g. {prefix}-orchestrator-1, -2, …).
      // Each isolated orchestrator gets its own numbered session and workspace.
      const identity = reserveNextOrchestratorIdentity(project, sessionsDir);
      sessionId = identity.sessionId;
      tmuxName = identity.tmuxName;
      branch = `orchestrator/${sessionId}`;

      if (!plugins.workspace) {
        try {
          deleteMetadata(sessionsDir, sessionId, false);
        } catch {
          /* best effort */
        }
        throw new Error(
          `spawnOrchestrator requires a workspace plugin but none is configured for project '${orchestratorConfig.projectId}'`,
        );
      }

      try {
        const wsInfo = await plugins.workspace.create({
          projectId: orchestratorConfig.projectId,
          project,
          sessionId,
          branch,
        });
        workspacePath = wsInfo.path;
      } catch (err) {
        try {
          deleteMetadata(sessionsDir, sessionId, false);
        } catch {
          /* best effort */
        }
        throw err;
      }

      try {
        if (plugins.agent.setupWorkspaceHooks) {
          await plugins.agent.setupWorkspaceHooks(workspacePath, { dataDir: sessionsDir });
        }
      } catch (err) {
        try {
          await plugins.workspace.destroy(workspacePath);
        } catch {
          /* best effort */
        }
        try {
          deleteMetadata(sessionsDir, sessionId, false);
        } catch {
          /* best effort */
        }
        throw err;
      }
    }

    const cleanupOrchestratorMetadataAndWorkspace = async (promptFile?: string): Promise<void> => {
      if (orchestratorWorkspaceMode === "isolated" && plugins.workspace) {
        try {
          await plugins.workspace.destroy(workspacePath);
        } catch {
          /* best effort */
        }
      }
      try {
        deleteMetadata(sessionsDir, sessionId, false);
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

    // Write system prompt to a file to avoid shell/tmux truncation.
    // Long prompts (2000+ chars) get mangled when inlined in shell commands
    // via tmux send-keys or paste-buffer. File-based approach is reliable.
    let systemPromptFile: string | undefined;
    if (orchestratorConfig.systemPrompt) {
      try {
        const baseDir = getProjectBaseDir(config.configPath, project.path);
        mkdirSync(baseDir, { recursive: true });
        systemPromptFile = join(baseDir, `orchestrator-prompt-${sessionId}.md`);
        writeFileSync(systemPromptFile, orchestratorConfig.systemPrompt, "utf-8");
      } catch (err) {
        await cleanupOrchestratorMetadataAndWorkspace(systemPromptFile);
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
      await cleanupOrchestratorMetadataAndWorkspace(systemPromptFile);
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
      permissions: "permissionless" as const,
      model: selection.model,
      systemPromptFile,
      subagent: selection.subagent,
    };

    const launchCommand = plugins.agent.getLaunchCommand(agentLaunchConfig);
    const environment = plugins.agent.getEnvironment(agentLaunchConfig);

    // Create runtime — clean up worktree and metadata on failure
    let handle: RuntimeHandle;
    try {
      handle = await plugins.runtime.create({
        sessionId: tmuxName ?? sessionId,
        workspacePath,
        launchCommand,
        environment: {
          ...environment,
          AO_SESSION: sessionId,
          AO_DATA_DIR: sessionsDir,
          AO_SESSION_NAME: sessionId,
          ...(tmuxName && { AO_TMUX_NAME: tmuxName }),
          AO_CALLER_TYPE: "orchestrator",
          AO_PROJECT_ID: orchestratorConfig.projectId,
          AO_CONFIG_PATH: config.configPath,
          ...(config.port !== undefined && config.port !== null && { AO_PORT: String(config.port) }),
        },
      });
    } catch (err) {
      await cleanupOrchestratorMetadataAndWorkspace(systemPromptFile);
      throw err;
    }

    // Write metadata and run post-launch setup
    const session: Session = {
      id: sessionId,
      projectId: orchestratorConfig.projectId,
      status: "working",
      activity: "active",
      branch,
      issueId: null,
      pr: null,
      workspacePath,
      runtimeHandle: handle,
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {
        ...(reusableOpenCodeSessionId ? { opencodeSessionId: reusableOpenCodeSessionId } : {}),
      },
    };

    try {
      writeMetadata(sessionsDir, sessionId, {
        worktree: workspacePath,
        branch,
        status: "working",
        role: "orchestrator",
        tmuxName,
        project: orchestratorConfig.projectId,
        agent: selection.agentName,
        createdAt: new Date().toISOString(),
        runtimeHandle: JSON.stringify(handle),
        opencodeSessionId: reusableOpenCodeSessionId,
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
    } catch (err) {
      // Clean up runtime on post-launch failure
      try {
        await plugins.runtime.destroy(handle);
      } catch {
        /* best effort */
      }
      await cleanupOrchestratorMetadataAndWorkspace(systemPromptFile);
      throw err;
    }

    return session;
  }

  async function list(projectId?: string): Promise<Session[]> {
    const allSessions = Object.entries(config.projects).flatMap(([entryProjectId, project]) => {
      if (projectId && entryProjectId !== projectId) return [];
      return loadActiveSessionRecords(project).map((record) => ({
        sessionName: record.sessionName,
        projectId: entryProjectId,
        raw: record.raw,
      }));
    });
    let openCodeSessionListPromise: Promise<OpenCodeSessionListEntry[]> | undefined;

    const tasks = allSessions.map(async ({ sessionName, projectId: sessionProjectId, raw }) => {
      const project = config.projects[sessionProjectId];
      if (!project) return null;

      const sessionsDir = getProjectSessionsDir(project);

      let createdAt: Date | undefined;
      let modifiedAt: Date | undefined;
      try {
        const metaPath = join(sessionsDir, sessionName);
        const stats = statSync(metaPath);
        createdAt = stats.birthtime;
        modifiedAt = stats.mtime;
      } catch {
        // If stat fails, timestamps will fall back to current time
      }

      const session = metadataToSession(sessionName, raw, sessionProjectId, createdAt, modifiedAt);
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

      return session;
    });

    const resolved = await Promise.all(tasks);
    return resolved.filter((session): session is Session => session !== null);
  }

  async function get(sessionId: SessionId): Promise<Session | null> {
    // Try to find the session in any project's sessions directory
    for (const [projectId, project] of Object.entries(config.projects)) {
      const sessionsDir = getProjectSessionsDir(project);
      const raw = readMetadataRaw(sessionsDir, sessionId);
      if (!raw) continue;

      // Get file timestamps for createdAt/lastActivityAt
      let createdAt: Date | undefined;
      let modifiedAt: Date | undefined;
      try {
        const metaPath = join(sessionsDir, sessionId);
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

      const session = metadataToSession(sessionId, repaired.raw, projectId, createdAt, modifiedAt);

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

  async function kill(sessionId: SessionId, options?: { purgeOpenCode?: boolean }): Promise<void> {
    const { raw, sessionsDir, project, projectId } = requireSessionRecord(sessionId);

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

    // Archive metadata
    deleteMetadata(sessionsDir, sessionId, true);
    if (didPurgeOpenCodeSession) {
      markArchivedOpenCodeCleanup(sessionsDir, sessionId);
    }
  }

  async function cleanup(
    projectId?: string,
    options?: { dryRun?: boolean; purgeOpenCode?: boolean },
  ): Promise<CleanupResult> {
    const result: CleanupResult = { killed: [], skipped: [], errors: [] };
    const sessions = await list(projectId);
    const activeSessionKeys = new Set(
      sessions.map((session) => `${session.projectId}:${session.id}`),
    );

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

        // Check if PR is merged
        if (session.pr && plugins.scm) {
          try {
            const prState = await plugins.scm.getPRState(session.pr);
            if (prState === PR_STATE.MERGED || prState === PR_STATE.CLOSED) {
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

    for (const [projectKey, project] of Object.entries(config.projects)) {
      if (projectId && projectKey !== projectId) continue;

      const sessionsDir = getProjectSessionsDir(project);
      for (const archivedId of listArchivedSessionIds(sessionsDir)) {
        if (activeSessionKeys.has(`${projectKey}:${archivedId}`)) continue;

        const archived = readArchivedMetadataRaw(sessionsDir, archivedId);
        if (!archived) continue;

        if (isCleanupProtectedSession(project, archivedId, archived)) {
          pushSkipped(projectKey, archivedId);
          continue;
        }

        const cleanupAgent = resolveSelectionForSession(project, archivedId, archived).agentName;
        const mappedOpenCodeSessionId = asValidOpenCodeSessionId(archived["opencodeSessionId"]);
        if (cleanupAgent === "opencode" && archived["opencodeCleanedAt"]) {
          pushSkipped(projectKey, archivedId);
          continue;
        }
        if (cleanupAgent === "opencode" && mappedOpenCodeSessionId && shouldPurgeOpenCode) {
          if (!options?.dryRun) {
            try {
              await deleteOpenCodeSession(mappedOpenCodeSessionId);
              markArchivedOpenCodeCleanup(sessionsDir, archivedId);
            } catch (err) {
              result.errors.push({
                sessionId: archivedId,
                error: `Failed to delete OpenCode session ${mappedOpenCodeSessionId}: ${err instanceof Error ? err.message : String(err)}`,
              });
              continue;
            }
          }
          pushKilled(projectKey, archivedId);
        } else {
          pushSkipped(projectKey, archivedId);
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
          agentPlugin.isProcessRunning(handle).catch(() => true),
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

    const waitForRestoredSession = async (restoredSession: Session): Promise<void> => {
      const handle = restoredSession.runtimeHandle;
      if (!handle) {
        return;
      }

      const deadline = Date.now() + SEND_RESTORE_READY_TIMEOUT_MS;
      while (true) {
        const [runtimeAlive, processRunning, output, foregroundCommand] = await Promise.all([
          runtimePlugin.isAlive(handle).catch(() => true),
          agentPlugin.isProcessRunning(handle).catch(() => true),
          captureOutput(handle),
          handle.runtimeName === "tmux"
            ? getTmuxForegroundCommand(handle.id)
            : Promise.resolve(agentPlugin.processName),
        ]);

        const foregroundReady =
          foregroundCommand === null || foregroundCommand === agentPlugin.processName;

        if (runtimeAlive && foregroundReady && (processRunning || output.trim().length > 0)) {
          return;
        }

        if (Date.now() >= deadline) {
          return;
        }

        await sleep(SEND_RESTORE_READY_POLL_MS);
      }
    };

    const restoreForDelivery = async (reason: string, session: Session): Promise<Session> => {
      if (NON_RESTORABLE_STATUSES.has(session.status)) {
        throw new Error(`Cannot send to session ${sessionId}: ${reason}`);
      }

      try {
        const restored = await restore(sessionId);
        await waitForRestoredSession(restored);
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
        agentPlugin.isProcessRunning(handle).catch(() => true),
      ]);

      if (normalized.status === "spawning" && runtimeAlive) {
        await waitForInteractiveReadiness(normalized, SEND_BOOTSTRAP_READY_TIMEOUT_MS);
        [runtimeAlive, processRunning] = await Promise.all([
          runtimePlugin.isAlive(handle).catch(() => true),
          agentPlugin.isProcessRunning(handle).catch(() => true),
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
      const shouldRetryWithRestore =
        prepared.restoredAt === undefined && !NON_RESTORABLE_STATUSES.has(prepared.status);

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
    const activeRecords = loadActiveSessionRecords(project).filter(
      (record) => record.sessionName !== sessionId,
    );

    for (const { sessionName, raw: otherRaw } of activeRecords) {
      if (!otherRaw || isOrchestratorSessionRecord(sessionName, otherRaw, project.sessionPrefix)) continue;

      const samePr = otherRaw["pr"] === pr.url;
      const sameBranch =
        otherRaw["branch"] === pr.branch && (otherRaw["prAutoDetect"] ?? "on") !== "off";

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

    updateMetadata(sessionsDir, sessionId, {
      pr: pr.url,
      status: "pr_open",
      branch: pr.branch,
      prAutoDetect: "",
    });

    for (const previousSessionId of takenOverFrom) {
      const previousRaw = readMetadataRaw(sessionsDir, previousSessionId);
      if (!previousRaw) continue;

      updateMetadata(sessionsDir, previousSessionId, {
        pr: "",
        prAutoDetect: "off",
        ...(PR_TRACKING_STATUSES.has(previousRaw["status"] ?? "") ? { status: "working" } : {}),
      });
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
    // 1. Find session metadata across all projects (active first, then archive)
    let raw: Record<string, string> | null = null;
    let sessionsDir: string | null = null;
    let project: ProjectConfig | undefined;
    let projectId: string | undefined;
    let fromArchive = false;

    const activeRecord = findSessionRecord(sessionId);
    if (activeRecord) {
      raw = activeRecord.raw;
      sessionsDir = activeRecord.sessionsDir;
      project = activeRecord.project;
      projectId = activeRecord.projectId;
    }

    // Fall back to archived metadata (killed/cleaned sessions)
    if (!raw) {
      for (const [key, proj] of Object.entries(config.projects)) {
        const dir = getProjectSessionsDir(proj);
        const archived = readArchivedMetadataRaw(dir, sessionId);
        if (archived) {
          raw = archived;
          sessionsDir = dir;
          project = proj;
          projectId = key;
          fromArchive = true;
          break;
        }
      }
    }

    if (!raw || !sessionsDir || !project || !projectId) {
      throw new SessionNotFoundError(sessionId);
    }

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
      if (!fromArchive) {
        updateMetadata(sessionsDir, sessionId, { opencodeSessionId: discovered });
      }
    }

    // 2. Reconstruct Session from metadata and enrich with live runtime state.
    //    metadataToSession sets activity: null, so without enrichment a crashed
    //    session (status "working", agent exited) would not be detected as terminal
    //    and isRestorable would reject it.
    const session = metadataToSession(sessionId, raw, projectId);
    const plugins = resolvePlugins(project, selection.agentName);
    await enrichSessionWithRuntimeState(session, plugins, true);

    // 3. Validate restorability
    if (!isRestorable(session)) {
      if (NON_RESTORABLE_STATUSES.has(session.status)) {
        throw new SessionNotRestorableError(sessionId, `status is "${session.status}"`);
      }
      throw new SessionNotRestorableError(sessionId, "session is not in a terminal state");
    }

    if (fromArchive) {
      writeMetadata(sessionsDir, sessionId, {
        worktree: raw["worktree"] ?? "",
        branch: raw["branch"] ?? "",
        status: raw["status"] ?? "killed",
        role: raw["role"],
        tmuxName: raw["tmuxName"],
        issue: raw["issue"],
        pr: raw["pr"],
        prAutoDetect:
          raw["prAutoDetect"] === "off" ? "off" : raw["prAutoDetect"] === "on" ? "on" : undefined,
        summary: raw["summary"],
        project: raw["project"],
        agent: raw["agent"],
        createdAt: raw["createdAt"],
        runtimeHandle: raw["runtimeHandle"],
        opencodeSessionId: raw["opencodeSessionId"],
        pinnedSummary: raw["pinnedSummary"],
      });
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
    const agentLaunchConfig = {
      sessionId,
      projectConfig: {
        ...project,
        agentConfig: {
          ...selection.agentConfig,
          ...(selection.role === "orchestrator" ? { permissions: "permissionless" as const } : {}),
          ...(session.metadata?.opencodeSessionId
            ? { opencodeSessionId: session.metadata.opencodeSessionId }
            : {}),
        },
      },
      issueId: session.issueId ?? undefined,
      permissions: selection.role === "orchestrator" ? "permissionless" : selection.permissions,
      model: selection.model,
      subagent: selection.subagent,
    };

    if (plugins.agent.getRestoreCommand) {
      const restoreCmd = await plugins.agent.getRestoreCommand(session, project);
      launchCommand = restoreCmd ?? plugins.agent.getLaunchCommand(agentLaunchConfig);
    } else {
      launchCommand = plugins.agent.getLaunchCommand(agentLaunchConfig);
    }

    const environment = plugins.agent.getEnvironment(agentLaunchConfig);

    // 8. Create runtime (reuse tmuxName from metadata)
    const tmuxName = raw["tmuxName"];
    const handle = await plugins.runtime.create({
      sessionId: tmuxName ?? sessionId,
      workspacePath,
      launchCommand,
      environment: {
        ...environment,
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

    // 9. Update metadata — merge updates, preserving existing fields
    const now = new Date().toISOString();
    updateMetadata(sessionsDir, sessionId, {
      status: "spawning",
      runtimeHandle: JSON.stringify(handle),
      restoredAt: now,
    });

    // 10. Run postLaunchSetup (non-fatal)
    const restoredSession: Session = {
      ...session,
      status: "spawning",
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
        }
      } catch {
        // Non-fatal — session is already running
      }
    }

    return restoredSession;
  }

  return { spawn, spawnOrchestrator, restore, list, get, kill, cleanup, send, claimPR, remap };
}
