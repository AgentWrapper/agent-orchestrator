import "server-only";

/**
 * Server-side singleton for core services.
 *
 * Lazily initializes config, plugin registry, and session manager.
 * Cached in globalThis to survive Next.js HMR reloads in development.
 *
 * NOTE: Plugins are explicitly imported here because Next.js webpack
 * cannot resolve dynamic `import(variable)` expressions used by the
 * core plugin registry's loadBuiltins(). Static imports let webpack
 * bundle them correctly.
 */

import {
  getGlobalConfigPath,
  loadConfig,
  ConfigNotFoundError,
  createPluginRegistry,
  createSessionManager,
  createLifecycleManager,
  type LoadedConfig,
  type PluginRegistry,
  type OpenCodeSessionManager,
  type LifecycleManager,
  type SCM,
  type ProjectConfig,
  type Tracker,
  type Issue,
  type Session,
  isOrchestratorSession,
  TERMINAL_STATUSES,
} from "@aoagents/ao-core";

// Static plugin imports — webpack needs these to be string literals
import pluginRuntimeTmux from "@aoagents/ao-plugin-runtime-tmux";
import pluginRuntimeProcess from "@aoagents/ao-plugin-runtime-process";
import pluginAgentClaudeCode from "@aoagents/ao-plugin-agent-claude-code";
import pluginAgentCodex from "@aoagents/ao-plugin-agent-codex";
import pluginAgentCursor from "@aoagents/ao-plugin-agent-cursor";
import pluginAgentKimicode from "@aoagents/ao-plugin-agent-kimicode";
import pluginAgentOpencode from "@aoagents/ao-plugin-agent-opencode";
import pluginWorkspaceWorktree from "@aoagents/ao-plugin-workspace-worktree";
import pluginScmGithub from "@aoagents/ao-plugin-scm-github";
import pluginTrackerGithub from "@aoagents/ao-plugin-tracker-github";
import pluginTrackerLinear from "@aoagents/ao-plugin-tracker-linear";

export interface Services {
  config: LoadedConfig;
  registry: PluginRegistry;
  sessionManager: OpenCodeSessionManager;
  lifecycleManager: LifecycleManager;
}

// Cache in globalThis for Next.js HMR stability
const globalForServices = globalThis as typeof globalThis & {
  _aoServices?: Services;
  _aoServicesInit?: Promise<Services>;
  _aoServicesGeneration?: number;
};

/** Get (or lazily initialize) the core services singleton. */
export function getServices(): Promise<Services> {
  if (globalForServices._aoServices) {
    return Promise.resolve(globalForServices._aoServices);
  }
  if (!globalForServices._aoServicesInit) {
    const generation = globalForServices._aoServicesGeneration ?? 0;
    const initPromise = initServices()
      .then((services) => {
        if ((globalForServices._aoServicesGeneration ?? 0) !== generation) {
          services.lifecycleManager.stop();
          return getServices();
        }

        globalForServices._aoServices = services;
        return services;
      })
      .catch((err) => {
        // Clear the cached promise so the next call retries instead of
        // permanently returning a rejected promise.
        if (globalForServices._aoServicesInit === initPromise) {
          globalForServices._aoServicesInit = undefined;
        }
        throw err;
      });

    globalForServices._aoServicesInit = initPromise;
  }
  return globalForServices._aoServicesInit;
}

/** Clear the cached services singleton so subsequent requests reload config/plugins. */
export function invalidatePortfolioServicesCache(): void {
  globalForServices._aoServicesGeneration = (globalForServices._aoServicesGeneration ?? 0) + 1;
  if (globalForServices._aoServices) {
    globalForServices._aoServices.lifecycleManager.stop();
  }
  globalForServices._aoServices = undefined;
  globalForServices._aoServicesInit = undefined;
}

async function initServices(): Promise<Services> {
  const config = loadDashboardConfig();
  const registry = createPluginRegistry();

  // Register plugins explicitly (webpack can't handle dynamic import() in core)
  registry.register(pluginRuntimeTmux);
  registry.register(pluginRuntimeProcess);
  registry.register(pluginAgentClaudeCode);
  registry.register(pluginAgentCodex);
  registry.register(pluginAgentCursor);
  registry.register(pluginAgentKimicode);
  registry.register(pluginAgentOpencode);
  registry.register(pluginWorkspaceWorktree);
  registry.register(pluginScmGithub);
  registry.register(pluginTrackerGithub);
  registry.register(pluginTrackerLinear);

  const sessionManager = createSessionManager({ config, registry });

  // Lifecycle manager for webhook-triggered checks only — no independent polling.
  // The CLI process (`ao`) runs the 30s polling loop and writes PR enrichment
  // data to session metadata files. The dashboard reads from metadata instead
  // of calling GitHub API directly. This means the dashboard is NOT self-sufficient:
  // if the CLI process isn't running, sessions will have no PR enrichment data,
  // no state transitions, and no reactions. The SSE endpoint surfaces whatever
  // metadata the CLI has written — stale data is expected when CLI is down.
  const lifecycleManager = createLifecycleManager({ config, registry, sessionManager });

  return { config, registry, sessionManager, lifecycleManager };
}

function loadDashboardConfig(): LoadedConfig {
  const globalConfigPath = getGlobalConfigPath();

  try {
    return loadConfig(globalConfigPath);
  } catch (error) {
    // The dashboard prefers the global portfolio config, but users may still
    // launch it from a single repo that only has a local agent-orchestrator.yaml.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return loadConfig();
    }
    if (error instanceof ConfigNotFoundError) {
      return loadConfig();
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Backlog auto-claim — polls for labeled issues and auto-spawns agents
// ---------------------------------------------------------------------------

const BACKLOG_LABEL = "agent:backlog";
const BACKLOG_POLL_INTERVAL = 60_000; // 1 minute
const MAX_CONCURRENT_AGENTS = 5; // Max active agent sessions across all projects

const globalForBacklog = globalThis as typeof globalThis & {
  _aoBacklogStarted?: boolean;
  _aoBacklogTimer?: ReturnType<typeof setInterval>;
};

/** Start the backlog auto-claim loop. Idempotent — safe to call multiple times. */
export function startBacklogPoller(): void {
  if (globalForBacklog._aoBacklogStarted) return;
  globalForBacklog._aoBacklogStarted = true;

  // Run immediately, then on interval
  void pollBacklog();
  globalForBacklog._aoBacklogTimer = setInterval(() => void pollBacklog(), BACKLOG_POLL_INTERVAL);
}

// Track which issues we've already processed to avoid repeated API calls
const processedIssues = new Set<string>();

/** Label GitHub issues for verification when their PRs have been merged. */
async function labelIssuesForVerification(
  sessions: Session[],
  config: LoadedConfig,
  registry: PluginRegistry,
): Promise<void> {
  const mergedSessions = sessions.filter(
    (s) =>
      s.lifecycle.pr.state === "merged" &&
      s.issueId &&
      !processedIssues.has(`${s.projectId}:${s.issueId}`),
  );

  for (const session of mergedSessions) {
    const key = `${session.projectId}:${session.issueId}`;
    const project = config.projects[session.projectId];
    if (!project?.tracker?.plugin) {
      processedIssues.add(key);
      continue;
    }

    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker?.updateIssue) {
      processedIssues.add(key);
      continue;
    }

    const issueId = session.issueId;
    if (!issueId) {
      processedIssues.add(key);
      continue;
    }

    try {
      await tracker.updateIssue(
        issueId,
        {
          labels: ["merged-unverified"],
          removeLabels: ["agent:backlog", "agent:in-progress"],
          comment: `PR merged. Issue awaiting human verification on staging.`,
        },
        project,
      );
    } catch (err) {
      console.error(`[backlog] Failed to close issue ${session.issueId}:`, err);
    }
    processedIssues.add(key);
  }
}

/**
 * Detect reopened issues (open + agent:done label) and swap the label
 * back to agent:backlog so pollBacklog picks them up on the next cycle.
 */
async function relabelReopenedIssues(
  config: LoadedConfig,
  registry: PluginRegistry,
): Promise<void> {
  for (const [, project] of Object.entries(config.projects)) {
    if (!project.tracker?.plugin) continue;
    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker?.listIssues || !tracker.updateIssue) continue;

    let reopened: Issue[];
    try {
      reopened = await tracker.listIssues(
        { state: "open", labels: ["agent:done"], limit: 20 },
        project,
      );
    } catch {
      continue;
    }

    for (const issue of reopened) {
      try {
        await tracker.updateIssue(
          issue.id,
          {
            labels: [BACKLOG_LABEL],
            removeLabels: ["agent:done"],
            comment: "Issue reopened — returning to agent backlog.",
          },
          project,
        );
        console.log(`[backlog] Relabeled reopened issue ${issue.id} → ${BACKLOG_LABEL}`);
      } catch (err) {
        console.error(`[backlog] Failed to relabel reopened issue ${issue.id}:`, err);
      }
    }
  }
}

export async function pollBacklog(): Promise<void> {
  try {
    const { config, registry, sessionManager } = await getServices();

    // Get all sessions
    const allSessions = await sessionManager.list();
    // Label issues for verification when PRs are merged
    await labelIssuesForVerification(allSessions, config, registry);

    // Detect reopened issues: open state + agent:done label → relabel as agent:backlog
    await relabelReopenedIssues(config, registry);

    const allSessionPrefixes = Object.entries(config.projects).map(
      ([id, p]) => p.sessionPrefix ?? id,
    );
    const workerSessions = allSessions.filter(
      (session) =>
        !isOrchestratorSession(
          session,
          config.projects[session.projectId]?.sessionPrefix ?? session.projectId,
          allSessionPrefixes,
        ) && !TERMINAL_STATUSES.has(session.status),
    );
    const activeIssueIds = new Set(
      workerSessions
        .map((session) => session.issueId?.toLowerCase())
        .filter((issueId): issueId is string => Boolean(issueId)),
    );

    // Auto-scaling: respect max concurrent agents
    let availableSlots = MAX_CONCURRENT_AGENTS - workerSessions.length;
    if (availableSlots <= 0) return; // At capacity

    for (const [projectId, project] of Object.entries(config.projects)) {
      if (availableSlots <= 0) break;
      if (!project.tracker?.plugin) continue;

      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (!tracker?.listIssues) continue;

      let backlogIssues: Issue[];
      try {
        backlogIssues = await tracker.listIssues(
          { state: "open", labels: [BACKLOG_LABEL], limit: 10 },
          project,
        );
      } catch {
        continue; // Tracker unavailable — skip this project
      }

      for (const issue of backlogIssues) {
        if (availableSlots <= 0) break;

        // Skip if already being worked on
        if (activeIssueIds.has(issue.id.toLowerCase())) continue;

        try {
          await sessionManager.spawn({ projectId, issueId: issue.id });
          availableSlots--;

          activeIssueIds.add(issue.id.toLowerCase());

          // Mark as claimed on the tracker
          if (tracker.updateIssue) {
            await tracker.updateIssue(
              issue.id,
              {
                labels: ["agent:in-progress"],
                removeLabels: ["agent:backlog"],
                comment: "Claimed by agent orchestrator — session spawned.",
              },
              project,
            );
          }
        } catch (err) {
          console.error(`[backlog] Failed to spawn session for issue ${issue.id}:`, err);
        }
      }
    }
  } catch (err) {
    console.error("[backlog] Poll failed:", err);
  }
}

/** Get backlog issues across all projects (for dashboard display). */
export async function getBacklogIssues(): Promise<Array<Issue & { projectId: string }>> {
  const results: Array<Issue & { projectId: string }> = [];
  try {
    const { config, registry } = await getServices();
    for (const [projectId, project] of Object.entries(config.projects)) {
      if (!project.tracker?.plugin) continue;
      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (!tracker?.listIssues) continue;

      try {
        const issues = await tracker.listIssues(
          { state: "open", labels: [BACKLOG_LABEL], limit: 20 },
          project,
        );
        for (const issue of issues) {
          results.push({ ...issue, projectId });
        }
      } catch {
        // Skip unavailable trackers
      }
    }
  } catch {
    // Services unavailable
  }
  return results;
}

/** Get issues labeled merged-unverified across all projects (for dashboard verify tab). */
export async function getVerifyIssues(): Promise<Array<Issue & { projectId: string }>> {
  const results: Array<Issue & { projectId: string }> = [];
  try {
    const { config, registry } = await getServices();
    for (const [projectId, project] of Object.entries(config.projects)) {
      if (!project.tracker?.plugin) continue;
      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (!tracker?.listIssues) continue;

      try {
        const issues = await tracker.listIssues(
          { state: "open", labels: ["merged-unverified"], limit: 20 },
          project,
        );
        for (const issue of issues) {
          results.push({ ...issue, projectId });
        }
      } catch {
        // Skip unavailable trackers
      }
    }
  } catch {
    // Services unavailable
  }
  return results;
}

/** Resolve the SCM plugin for a project. Returns null if not configured. */
export function getSCM(registry: PluginRegistry, project: ProjectConfig | undefined): SCM | null {
  if (!project?.scm?.plugin) return null;
  return registry.get<SCM>("scm", project.scm.plugin);
}
