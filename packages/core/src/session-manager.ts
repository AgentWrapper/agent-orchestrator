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

import { statSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  isIssueNotFoundError,
  isRestorable,
  NON_RESTORABLE_STATUSES,
  SessionNotRestorableError,
  WorkspaceMissingError,
  type SessionManager,
  type Session,
  type SessionId,
  type SessionSpawnConfig,
  type OrchestratorSpawnConfig,
  type SessionStatus,
  type CleanupResult,
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
  writeMetadata,
  updateMetadata,
  deleteMetadata,
  listMetadata,
  reserveSessionId,
} from "./metadata.js";
import { buildPrompt } from "./prompt-builder.js";
import {
  getSessionsDir,
  getProjectBaseDir,
  generateTmuxName,
  generateConfigHash,
  validateAndStoreOrigin,
} from "./paths.js";

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

/** Safely parse JSON, returning null on failure. */
function safeJsonParse<T>(str: string): T | null {
  try {
    return JSON.parse(str) as T;
  } catch {
    return null;
  }
}

/** Valid session statuses for validation. */
const VALID_STATUSES: ReadonlySet<string> = new Set([
  "spawning",
  "working",
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
  "done",
  "terminated",
]);

/** Validate and normalize a status string. */
function validateStatus(raw: string | undefined): SessionStatus {
  // Bash scripts write "starting" — treat as "working"
  if (raw === "starting") return "working";
  if (raw && VALID_STATUSES.has(raw)) return raw as SessionStatus;
  return "spawning";
}

/** Reconstruct a Session object from raw metadata key=value pairs. */
function metadataToSession(
  sessionId: SessionId,
  meta: Record<string, string>,
  createdAt?: Date,
  modifiedAt?: Date,
): Session {
  return {
    id: sessionId,
    projectId: meta["project"] ?? "",
    status: validateStatus(meta["status"]),
    activity: null,
    branch: meta["branch"] || null,
    issueId: meta["issue"] || null,
    pr: meta["pr"]
      ? (() => {
          // Parse owner/repo from GitHub PR URL: https://github.com/owner/repo/pull/123
          const prUrl = meta["pr"];
          const ghMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
          return {
            number: ghMatch
              ? parseInt(ghMatch[3], 10)
              : parseInt(prUrl.match(/\/(\d+)$/)?.[1] ?? "0", 10),
            url: prUrl,
            title: "",
            owner: ghMatch?.[1] ?? "",
            repo: ghMatch?.[2] ?? "",
            branch: meta["branch"] ?? "",
            baseBranch: "",
            isDraft: false,
          };
        })()
      : null,
    workspacePath: meta["worktree"] || null,
    runtimeHandle: meta["runtimeHandle"]
      ? safeJsonParse<RuntimeHandle>(meta["runtimeHandle"])
      : null,
    agentInfo: meta["summary"] ? { summary: meta["summary"], agentSessionId: null } : null,
    createdAt: meta["createdAt"] ? new Date(meta["createdAt"]) : (createdAt ?? new Date()),
    lastActivityAt: modifiedAt ?? new Date(),
    restoredAt: meta["restoredAt"] ? new Date(meta["restoredAt"]) : undefined,
    metadata: meta,
  };
}

export interface SessionManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
}

/** Cached enrichment result for a single session. */
interface EnrichmentCacheEntry {
  /** Metadata file mtime in milliseconds — used as the dirty flag. */
  metaMtimeMs: number;
  /** The fully enriched Session object from the last poll. */
  session: Session;
}

/** Create a SessionManager instance. */
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { config, registry } = deps;

  /**
   * Enrichment cache — avoids re-running expensive subprocess enrichment
   * (tmux isAlive, JSONL parsing) for sessions whose metadata file has not
   * changed since the last poll.
   *
   * Key: sessionId, Value: { metaMtimeMs, session }
   *
   * Cache is only used by list(). get() always does full enrichment because
   * it is called for single-session detail views where freshness matters more.
   */
  const enrichmentCache = new Map<string, EnrichmentCacheEntry>();

  /**
   * Get the sessions directory for a project.
   */
  function getProjectSessionsDir(project: ProjectConfig): string {
    return getSessionsDir(config.configPath, project.path);
  }

  /**
   * List all session files across all projects (or filtered by projectId).
   * Scans project-specific directories under ~/.agent-orchestrator/{hash}-{projectId}/sessions/
   *
   * Note: projectId is the config key (e.g., "test-project"), not the path basename.
   */
  function listAllSessions(projectIdFilter?: string): { sessionName: string; projectId: string }[] {
    const results: { sessionName: string; projectId: string }[] = [];

    // Scan each project's sessions directory
    for (const [projectKey, project] of Object.entries(config.projects)) {
      // Use config key as projectId for consistency with metadata
      const projectId = projectKey;

      // Filter by project if specified
      if (projectIdFilter && projectId !== projectIdFilter) continue;

      const sessionsDir = getSessionsDir(config.configPath, project.path);
      if (!existsSync(sessionsDir)) continue;

      const files = readdirSync(sessionsDir);
      for (const file of files) {
        if (file === "archive" || file.startsWith(".")) continue;
        const fullPath = join(sessionsDir, file);
        try {
          if (statSync(fullPath).isFile()) {
            results.push({ sessionName: file, projectId });
          }
        } catch {
          // Skip files that can't be stat'd
        }
      }
    }

    return results;
  }

  /** Resolve which plugins to use for a project. */
  function resolvePlugins(project: ProjectConfig, agentOverride?: string) {
    const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
    const agent = registry.get<Agent>("agent", agentOverride ?? project.agent ?? config.defaults.agent);
    const workspace = registry.get<Workspace>(
      "workspace",
      project.workspace ?? config.defaults.workspace,
    );
    const tracker = project.tracker
      ? registry.get<Tracker>("tracker", project.tracker.plugin)
      : null;
    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;

    return { runtime, agent, workspace, tracker, scm };
  }

  /**
   * Ensure session has a runtime handle (fabricate one if missing) and enrich
   * with live runtime state + activity detection. Used by both list() and get().
   */
  async function ensureHandleAndEnrich(
    session: Session,
    sessionName: string,
    project: ProjectConfig,
    plugins: ReturnType<typeof resolvePlugins>,
  ): Promise<void> {
    const handleFromMetadata = session.runtimeHandle !== null;
    if (!handleFromMetadata) {
      session.runtimeHandle = {
        id: sessionName,
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
  const TERMINAL_SESSION_STATUSES = new Set([
    "killed", "done", "merged", "terminated", "cleanup",
  ]);

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

    const plugins = resolvePlugins(project);
    if (!plugins.runtime) {
      throw new Error(`Runtime plugin '${project.runtime ?? config.defaults.runtime}' not found`);
    }

    // Allow --agent override to swap the agent plugin for this session
    if (spawnConfig.agent) {
      const overrideAgent = registry.get<Agent>("agent", spawnConfig.agent);
      if (!overrideAgent) {
        throw new Error(`Agent plugin '${spawnConfig.agent}' not found`);
      }
      plugins.agent = overrideAgent;
    }

    if (!plugins.agent) {
      throw new Error(`Agent plugin '${project.agent ?? config.defaults.agent}' not found`);
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
    const existingSessions = listMetadata(sessionsDir);
    let num = getNextSessionNumber(existingSessions, project.sessionPrefix);
    let sessionId: string;
    let tmuxName: string | undefined;
    for (let attempts = 0; attempts < 10; attempts++) {
      sessionId = `${project.sessionPrefix}-${num}`;
      // Generate tmux name if using new architecture
      if (config.configPath) {
        tmuxName = generateTmuxName(config.configPath, project.sessionPrefix, num);
      }
      if (reserveSessionId(sessionsDir, sessionId)) break;
      num++;
      if (attempts === 9) {
        throw new Error(
          `Failed to reserve session ID after 10 attempts (prefix: ${project.sessionPrefix})`,
        );
      }
    }
    // Reassign to satisfy TypeScript's flow analysis (not redundant from compiler's perspective)
    sessionId = `${project.sessionPrefix}-${num}`;
    if (config.configPath) {
      tmuxName = generateTmuxName(config.configPath, project.sessionPrefix, num);
    }

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
      const isBranchSafe =
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes("..");
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
            if (workspacePath !== project.path) {
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
    });

    // Get agent launch config and create runtime — clean up workspace on failure
    const agentLaunchConfig = {
      sessionId,
      projectConfig: project,
      issueId: spawnConfig.issueId,
      prompt: composedPrompt ?? spawnConfig.prompt,
      permissions: project.agentConfig?.permissions,
      model: project.agentConfig?.model,
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
        },
      });
    } catch (err) {
      // Clean up workspace and reserved ID if agent config or runtime creation failed
      if (plugins.workspace && workspacePath !== project.path) {
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
      metadata: {},
    };

    try {
      writeMetadata(sessionsDir, sessionId, {
        worktree: workspacePath,
        branch,
        status: "spawning",
        tmuxName, // Store tmux name for mapping
        issue: spawnConfig.issueId,
        project: spawnConfig.projectId,
        agent: plugins.agent.name, // Persist agent name for lifecycle manager
        createdAt: new Date().toISOString(),
        runtimeHandle: JSON.stringify(handle),
      });

      if (plugins.agent.postLaunchSetup) {
        await plugins.agent.postLaunchSetup(session);
      }
    } catch (err) {
      // Clean up runtime and workspace on post-launch failure
      try {
        await plugins.runtime.destroy(handle);
      } catch {
        /* best effort */
      }
      if (plugins.workspace && workspacePath !== project.path) {
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
    if (plugins.agent.promptDelivery === "post-launch" && agentLaunchConfig.prompt) {
      try {
        // Wait for agent to start and be ready for input
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        await plugins.runtime.sendMessage(handle, agentLaunchConfig.prompt);
      } catch {
        // Non-fatal: agent is running but didn't receive the initial prompt.
        // User can retry with `ao send`.
      }
    }

    return session;
  }

  async function spawnOrchestrator(orchestratorConfig: OrchestratorSpawnConfig): Promise<Session> {
    const project = config.projects[orchestratorConfig.projectId];
    if (!project) {
      throw new Error(`Unknown project: ${orchestratorConfig.projectId}`);
    }

    const plugins = resolvePlugins(project);
    if (!plugins.runtime) {
      throw new Error(`Runtime plugin '${project.runtime ?? config.defaults.runtime}' not found`);
    }
    if (!plugins.agent) {
      throw new Error(`Agent plugin '${project.agent ?? config.defaults.agent}' not found`);
    }

    const sessionId = `${project.sessionPrefix}-orchestrator`;

    // Generate tmux name if using new architecture
    let tmuxName: string | undefined;
    if (config.configPath) {
      const hash = generateConfigHash(config.configPath);
      tmuxName = `${hash}-${sessionId}`;
    }

    // Get the sessions directory for this project
    const sessionsDir = getProjectSessionsDir(project);

    // Validate and store .origin file
    if (config.configPath) {
      validateAndStoreOrigin(config.configPath, project.path);
    }

    // Setup agent hooks for automatic metadata updates
    if (plugins.agent.setupWorkspaceHooks) {
      await plugins.agent.setupWorkspaceHooks(project.path, { dataDir: sessionsDir });
    }

    // Write system prompt to a file to avoid shell/tmux truncation.
    // Long prompts (2000+ chars) get mangled when inlined in shell commands
    // via tmux send-keys or paste-buffer. File-based approach is reliable.
    let systemPromptFile: string | undefined;
    if (orchestratorConfig.systemPrompt) {
      const baseDir = getProjectBaseDir(config.configPath, project.path);
      mkdirSync(baseDir, { recursive: true });
      systemPromptFile = join(baseDir, "orchestrator-prompt.md");
      writeFileSync(systemPromptFile, orchestratorConfig.systemPrompt, "utf-8");
    }

    // Get agent launch config — uses systemPromptFile, no issue/tracker interaction.
    // Orchestrator ALWAYS gets skip permissions — it must run ao CLI commands autonomously.
    const agentLaunchConfig = {
      sessionId,
      projectConfig: project,
      permissions: "skip" as const,
      model: project.agentConfig?.model,
      systemPromptFile,
    };

    const launchCommand = plugins.agent.getLaunchCommand(agentLaunchConfig);
    const environment = plugins.agent.getEnvironment(agentLaunchConfig);

    const handle = await plugins.runtime.create({
      sessionId: tmuxName ?? sessionId,
      workspacePath: project.path,
      launchCommand,
      environment: {
        ...environment,
        AO_SESSION: sessionId,
        AO_DATA_DIR: sessionsDir,
        AO_SESSION_NAME: sessionId,
        ...(tmuxName && { AO_TMUX_NAME: tmuxName }),
      },
    });

    // Write metadata and run post-launch setup
    const session: Session = {
      id: sessionId,
      projectId: orchestratorConfig.projectId,
      status: "working",
      activity: "active",
      branch: project.defaultBranch,
      issueId: null,
      pr: null,
      workspacePath: project.path,
      runtimeHandle: handle,
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };

    try {
      writeMetadata(sessionsDir, sessionId, {
        worktree: project.path,
        branch: project.defaultBranch,
        status: "working",
        role: "orchestrator",
        tmuxName,
        project: orchestratorConfig.projectId,
        createdAt: new Date().toISOString(),
        runtimeHandle: JSON.stringify(handle),
      });

      if (plugins.agent.postLaunchSetup) {
        await plugins.agent.postLaunchSetup(session);
      }
    } catch (err) {
      // Clean up runtime on post-launch failure
      try {
        await plugins.runtime.destroy(handle);
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

    return session;
  }

  async function list(projectId?: string): Promise<Session[]> {
    const allSessions = listAllSessions(projectId);

    // Track which session IDs are still present so we can prune stale cache entries
    const currentSessionIds = new Set<string>();

    const sessionPromises = allSessions.map(async ({ sessionName, projectId: sessionProjectId }) => {
      const project = config.projects[sessionProjectId];
      if (!project) return null;

      const sessionsDir = getProjectSessionsDir(project);

      // Stat the metadata file first — we need mtime for both the dirty
      // check and for lastActivityAt.
      let metaMtimeMs: number | undefined;
      let createdAt: Date | undefined;
      let modifiedAt: Date | undefined;
      try {
        const metaPath = join(sessionsDir, sessionName);
        const stats = statSync(metaPath);
        createdAt = stats.birthtime;
        modifiedAt = stats.mtime;
        metaMtimeMs = stats.mtimeMs;
      } catch {
        // If stat fails, timestamps will fall back to current time
      }

      currentSessionIds.add(sessionName);

      // ── Dirty flag: skip enrichment when metadata file is unchanged ──
      // If the metadata mtime matches the cached value AND the cached
      // session was in a terminal status (where activity is always "exited"
      // and no subprocess checks are needed), reuse the cached result.
      // Non-terminal sessions always re-enrich because their activity
      // state comes from JSONL files that change independently of metadata.
      if (metaMtimeMs !== undefined) {
        const cached = enrichmentCache.get(sessionName);
        if (
          cached &&
          cached.metaMtimeMs === metaMtimeMs &&
          TERMINAL_SESSION_STATUSES.has(cached.session.status)
        ) {
          // Shallow copy so callers cannot mutate the cached object
          return { ...cached.session };
        }
      }

      const raw = readMetadataRaw(sessionsDir, sessionName);
      if (!raw) return null;

      const session = metadataToSession(sessionName, raw, createdAt, modifiedAt);

      const plugins = resolvePlugins(project, raw["agent"]);
      // Cap per-session enrichment at 2s — subprocess calls (tmux/ps) can be
      // slow under load. If we time out, session keeps its metadata values.
      const enrichTimeout = new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      await Promise.race([ensureHandleAndEnrich(session, sessionName, project, plugins), enrichTimeout]);

      // Update the enrichment cache with the fresh result
      if (metaMtimeMs !== undefined) {
        enrichmentCache.set(sessionName, { metaMtimeMs, session });
      }

      return session;
    });

    const results = await Promise.all(sessionPromises);

    // Prune cache entries for sessions that no longer exist on disk.
    // Only prune on unfiltered calls — a filtered list(projectId) only sees
    // one project's sessions and would incorrectly evict entries from others.
    if (!projectId) {
      for (const cachedId of enrichmentCache.keys()) {
        if (!currentSessionIds.has(cachedId)) {
          enrichmentCache.delete(cachedId);
        }
      }
    }

    return results.filter((s): s is Session => s !== null);
  }

  async function get(sessionId: SessionId): Promise<Session | null> {
    // Try to find the session in any project's sessions directory
    for (const project of Object.values(config.projects)) {
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

      const session = metadataToSession(sessionId, raw, createdAt, modifiedAt);

      const plugins = resolvePlugins(project, raw["agent"]);
      await ensureHandleAndEnrich(session, sessionId, project, plugins);

      return session;
    }

    return null;
  }

  async function kill(sessionId: SessionId): Promise<void> {
    // Find the session in any project's sessions directory
    let raw: Record<string, string> | null = null;
    let sessionsDir: string | null = null;
    let project: ProjectConfig | undefined;

    for (const proj of Object.values(config.projects)) {
      const dir = getProjectSessionsDir(proj);
      const metadata = readMetadataRaw(dir, sessionId);
      if (metadata) {
        raw = metadata;
        sessionsDir = dir;
        project = proj;
        break;
      }
    }

    if (!raw || !sessionsDir) {
      throw new Error(`Session ${sessionId} not found`);
    }

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

    // Destroy workspace — skip if worktree is the project path (no isolation was used)
    const worktree = raw["worktree"];
    const isProjectPath = project && worktree === project.path;
    if (worktree && !isProjectPath) {
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

    // Archive metadata
    deleteMetadata(sessionsDir, sessionId, true);
  }

  async function cleanup(
    projectId?: string,
    options?: { dryRun?: boolean },
  ): Promise<CleanupResult> {
    const result: CleanupResult = { killed: [], skipped: [], errors: [] };
    const sessions = await list(projectId);

    for (const session of sessions) {
      try {
        // Never clean up orchestrator sessions — they manage the lifecycle.
        // Check explicit role metadata first, fall back to naming convention
        // for pre-existing sessions spawned before the role field was added.
        if (
          session.metadata["role"] === "orchestrator" ||
          session.id.endsWith("-orchestrator")
        ) {
          result.skipped.push(session.id);
          continue;
        }

        const project = config.projects[session.projectId];
        if (!project) {
          result.skipped.push(session.id);
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
            await kill(session.id);
          }
          result.killed.push(session.id);
        } else {
          result.skipped.push(session.id);
        }
      } catch (err) {
        result.errors.push({
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  async function send(sessionId: SessionId, message: string): Promise<void> {
    // Find the session in any project's sessions directory
    let raw: Record<string, string> | null = null;
    for (const project of Object.values(config.projects)) {
      const sessionsDir = getProjectSessionsDir(project);
      const metadata = readMetadataRaw(sessionsDir, sessionId);
      if (metadata) {
        raw = metadata;
        break;
      }
    }

    if (!raw) throw new Error(`Session ${sessionId} not found`);

    // Build handle: use stored runtimeHandle, or fall back to session ID as tmux session name
    let handle: RuntimeHandle;
    if (raw["runtimeHandle"]) {
      const parsed = safeJsonParse<RuntimeHandle>(raw["runtimeHandle"]);
      if (!parsed) {
        throw new Error(`Corrupted runtime handle for session ${sessionId}`);
      }
      handle = parsed;
    } else {
      // Sessions created by bash scripts don't have runtimeHandle — use session ID as tmux handle
      handle = { id: sessionId, runtimeName: config.defaults.runtime, data: {} };
    }

    // Prefer handle.runtimeName to find the correct plugin
    const project = config.projects[raw["project"] ?? ""];
    const runtimePlugin = registry.get<Runtime>(
      "runtime",
      handle.runtimeName ??
        (project ? (project.runtime ?? config.defaults.runtime) : config.defaults.runtime),
    );
    if (!runtimePlugin) {
      throw new Error(`No runtime plugin for session ${sessionId}`);
    }

    await runtimePlugin.sendMessage(handle, message);
  }

  async function restore(sessionId: SessionId): Promise<Session> {
    // 1. Find session metadata across all projects (active first, then archive)
    let raw: Record<string, string> | null = null;
    let sessionsDir: string | null = null;
    let project: ProjectConfig | undefined;
    let projectId: string | undefined;
    let fromArchive = false;

    for (const [key, proj] of Object.entries(config.projects)) {
      const dir = getProjectSessionsDir(proj);
      const metadata = readMetadataRaw(dir, sessionId);
      if (metadata) {
        raw = metadata;
        sessionsDir = dir;
        project = proj;
        projectId = key;
        break;
      }
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
      throw new Error(`Session ${sessionId} not found`);
    }

    // If restored from archive, recreate the active metadata file
    if (fromArchive) {
      writeMetadata(sessionsDir, sessionId, {
        worktree: raw["worktree"] ?? "",
        branch: raw["branch"] ?? "",
        status: raw["status"] ?? "killed",
        role: raw["role"],
        tmuxName: raw["tmuxName"],
        issue: raw["issue"],
        pr: raw["pr"],
        summary: raw["summary"],
        project: raw["project"],
        createdAt: raw["createdAt"],
        runtimeHandle: raw["runtimeHandle"],
      });
    }

    // 2. Reconstruct Session from metadata and enrich with live runtime state.
    //    metadataToSession sets activity: null, so without enrichment a crashed
    //    session (status "working", agent exited) would not be detected as terminal
    //    and isRestorable would reject it.
    const session = metadataToSession(sessionId, raw);
    const plugins = resolvePlugins(project, raw["agent"]);
    await enrichSessionWithRuntimeState(session, plugins, true);

    // 3. Validate restorability
    if (!isRestorable(session)) {
      if (NON_RESTORABLE_STATUSES.has(session.status)) {
        throw new SessionNotRestorableError(sessionId, `status is "${session.status}"`);
      }
      throw new SessionNotRestorableError(sessionId, "session is not in a terminal state");
    }

    // 4. Validate required plugins (plugins already resolved above for enrichment)
    if (!plugins.runtime) {
      throw new Error(`Runtime plugin '${project.runtime ?? config.defaults.runtime}' not found`);
    }
    if (!plugins.agent) {
      throw new Error(`Agent plugin '${project.agent ?? config.defaults.agent}' not found`);
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
      projectConfig: project,
      issueId: session.issueId ?? undefined,
      permissions: project.agentConfig?.permissions,
      model: project.agentConfig?.model,
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
        await plugins.agent.postLaunchSetup(restoredSession);
      } catch {
        // Non-fatal — session is already running
      }
    }

    return restoredSession;
  }

  return { spawn, spawnOrchestrator, restore, list, get, kill, cleanup, send };
}
