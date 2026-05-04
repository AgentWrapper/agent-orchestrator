import chalk from "chalk";
import type { Command } from "commander";
import {
  createInitialCanonicalLifecycle,
  createActivitySignal,
  type Agent,
  type SCM,
  type Session,
  type PRInfo,
  type CIStatus,
  type ReviewDecision,
  type ActivityState,
  type Tracker,
  type ProjectConfig,
  type AgentReportAuditEntry,
  isOrchestratorSession,
  isTerminalSession,
  loadConfig,
  getProjectSessionsDir,
  readAgentReportAuditTrailAsync,
} from "@aoagents/ao-core";
import { git, getTmuxSessions, getTmuxActivity } from "../lib/shell.js";
import {
  banner,
  header,
  formatAge,
  activityIcon,
  ciStatusIcon,
  reviewDecisionIcon,
  padCol,
} from "../lib/format.js";
import { getAgentByName, getAgentByNameFromRegistry, getSCMFromRegistry } from "../lib/plugins.js";
import { getPluginRegistry, getSessionManager } from "../lib/create-session-manager.js";

interface SessionInfo {
  name: string;
  role: "worker" | "orchestrator";
  branch: string | null;
  status: string | null;
  summary: string | null;
  claudeSummary: string | null;
  pr: string | null;
  prNumber: number | null;
  issue: string | null;
  lastActivity: string;
  project: string | null;
  ciStatus: CIStatus | null;
  reviewDecision: ReviewDecision | null;
  pendingThreads: number | null;
  activity: ActivityState | null;
  reports: AgentReportAuditEntry[];
}

interface StatusOptions {
  project?: string;
  json?: boolean;
  watch?: boolean;
  interval?: string;
  includeTerminated?: boolean;
  reports?: string;
}

/** Parse --reports value: "full" → Infinity, positive integer → N, undefined → 0 (off). */
function parseReportsLimit(value: string | undefined): number {
  if (value === undefined) return 0;
  if (value === "full") return Infinity;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error('--reports must be "full" or a positive integer.');
  }
  return n;
}

const DEFAULT_WATCH_INTERVAL_SECONDS = 5;

function parseWatchIntervalSeconds(value?: string): number {
  if (!value) return DEFAULT_WATCH_INTERVAL_SECONDS;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error("--interval must be a positive integer number of seconds.");
  }
  return parsed;
}

function maybeClearScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1Bc");
  }
}

async function gatherSessionInfo(
  session: Session,
  agent: Agent,
  scm: SCM,
  projectConfig: ReturnType<typeof loadConfig>,
  reportsLimit: number = 0,
): Promise<SessionInfo> {
  const sessionPrefix = projectConfig.projects[session.projectId]?.sessionPrefix ?? session.projectId;
  const allSessionPrefixes = Object.entries(projectConfig.projects).map(
    ([id, p]) => p.sessionPrefix ?? id,
  );
  const suppressPROwnership = isOrchestratorSession(session, sessionPrefix, allSessionPrefixes);
  let branch = session.branch;
  const status = session.status;
  const summary = session.metadata["summary"] ?? null;
  const prUrl = suppressPROwnership ? null : (session.metadata["pr"] ?? null);
  const issue = session.issueId;

  // Get live branch from worktree if available
  if (session.workspacePath) {
    const liveBranch = await git(["branch", "--show-current"], session.workspacePath);
    if (liveBranch) branch = liveBranch;
  }

  // Get last activity time from tmux
  const tmuxTarget = session.runtimeHandle?.id ?? session.id;
  const activityTs = await getTmuxActivity(tmuxTarget);
  const lastActivity = activityTs ? formatAge(activityTs) : "-";

  // Get agent's auto-generated summary via introspection
  let claudeSummary: string | null = null;
  try {
    const introspection = await agent.getSessionInfo(session);
    claudeSummary = introspection?.summary ?? null;
  } catch {
    // Summary extraction failed — not critical
  }

  // Use activity from session (already enriched by sessionManager.list())
  const activity = session.activity;

  // Fetch PR, CI, and review data from SCM
  let prNumber: number | null = null;
  let ciStatus: CIStatus | null = null;
  let reviewDecision: ReviewDecision | null = null;
  let pendingThreads: number | null = null;

  // Extract PR number from metadata URL as fallback
  if (prUrl) {
    const prMatch = /\/pull\/(\d+)/.exec(prUrl);
    if (prMatch) {
      prNumber = parseInt(prMatch[1], 10);
    }
  }

  if (branch && !suppressPROwnership) {
    try {
      const project = projectConfig.projects[session.projectId];
      if (project) {
        const prInfo: PRInfo | null = await scm.detectPR(session, project);
        if (prInfo) {
          prNumber = prInfo.number;

          const [ci, review, threads] = await Promise.all([
            scm.getCISummary(prInfo).catch(() => null),
            scm.getReviewDecision(prInfo).catch(() => null),
            scm.getPendingComments(prInfo).catch(() => null),
          ]);

          ciStatus = ci;
          reviewDecision = review;
          pendingThreads = threads !== null ? threads.length : null;
        }
      }
    } catch {
      // SCM lookup failed — not critical
    }
  }

  // Fetch agent report audit trail when --reports is active
  let reports: AgentReportAuditEntry[] = [];
  if (reportsLimit > 0) {
    try {
      const project = projectConfig.projects[session.projectId];
      if (project) {
        const sessionsDir = getProjectSessionsDir(session.projectId);
        const trail = await readAgentReportAuditTrailAsync(sessionsDir, session.id);
        // trail is already reverse-chronological (newest first)
        reports = reportsLimit === Infinity ? trail : trail.slice(0, reportsLimit);
      }
    } catch {
      // Audit trail read failed — not critical
    }
  }

  return {
    name: session.id,
    role: isOrchestratorSession(session, sessionPrefix, allSessionPrefixes) ? "orchestrator" : "worker",
    branch,
    status,
    summary,
    claudeSummary,
    pr: prUrl,
    prNumber,
    issue,
    lastActivity,
    project: session.projectId,
    ciStatus,
    reviewDecision,
    pendingThreads,
    activity,
    reports,
  };
}

function formatReportTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "??:??";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function printReportRows(reports: AgentReportAuditEntry[], indent: string): void {
  if (reports.length === 0) return;
  // reports are newest-first from the audit trail; display oldest-first (chronological)
  const chronological = [...reports].reverse();
  console.log(`${indent}${chalk.dim("Reports:")}`);
  for (const entry of chronological) {
    const time = chalk.dim(formatReportTime(entry.timestamp));
    const src = chalk.dim(entry.source === "acknowledge" ? "ack" : "rpt");
    const state = entry.accepted ? chalk.cyan(entry.reportState) : chalk.red(entry.reportState);
    const transition =
      entry.before.sessionState === entry.after.sessionState
        ? chalk.dim(`(${entry.after.sessionState})`)
        : chalk.dim(`(${entry.before.sessionState} → ${entry.after.sessionState})`);
    const rejected = entry.accepted ? "" : chalk.red(" REJECTED");
    const note = entry.note ? chalk.dim(` "${entry.note}"`) : "";
    const pr = entry.prNumber ? chalk.blue(` #${entry.prNumber}`) : "";
    console.log(`${indent}  ${time} ${src} ${state} ${transition}${rejected}${pr}${note}`);
  }
}

// Column widths for the table
const COL = {
  session: 14,
  branch: 24,
  pr: 6,
  ci: 6,
  review: 6,
  threads: 4,
  activity: 9,
  age: 8,
};

function printTableHeader(): void {
  const hdr =
    padCol("Session", COL.session) +
    padCol("Branch", COL.branch) +
    padCol("PR", COL.pr) +
    padCol("CI", COL.ci) +
    padCol("Rev", COL.review) +
    padCol("Thr", COL.threads) +
    padCol("Activity", COL.activity) +
    "Age";
  console.log(chalk.dim(`  ${hdr}`));
  const totalWidth =
    COL.session + COL.branch + COL.pr + COL.ci + COL.review + COL.threads + COL.activity + 3;
  console.log(chalk.dim(`  ${"─".repeat(totalWidth)}`));
}

function printSessionRow(info: SessionInfo): void {
  const prStr = info.prNumber ? `#${info.prNumber}` : "-";

  const row =
    padCol(chalk.green(info.name), COL.session) +
    padCol(info.branch ? chalk.cyan(info.branch) : chalk.dim("-"), COL.branch) +
    padCol(info.prNumber ? chalk.blue(prStr) : chalk.dim(prStr), COL.pr) +
    padCol(ciStatusIcon(info.ciStatus), COL.ci) +
    padCol(reviewDecisionIcon(info.reviewDecision), COL.review) +
    padCol(
      info.pendingThreads !== null && info.pendingThreads > 0
        ? chalk.yellow(String(info.pendingThreads))
        : chalk.dim(info.pendingThreads !== null ? "0" : "-"),
      COL.threads,
    ) +
    padCol(activityIcon(info.activity), COL.activity) +
    chalk.dim(info.lastActivity);

  console.log(`  ${row}`);

  // Show summary on a second line if available
  const displaySummary = info.claudeSummary || info.summary;
  if (displaySummary) {
    console.log(`  ${" ".repeat(COL.session)}${chalk.dim(displaySummary.slice(0, 60))}`);
  }

  printReportRows(info.reports, `  ${" ".repeat(COL.session)}`);
}

function printOrchestratorRow(info: SessionInfo): void {
  const lastActivity =
    info.lastActivity === "-" ? chalk.dim("unknown") : chalk.dim(info.lastActivity);
  console.log(
    `  ${chalk.magenta("Orchestrator:")} ${chalk.green(info.name)} ${chalk.dim("(")}${lastActivity}${chalk.dim(")")}`,
  );
  const displaySummary = info.claudeSummary || info.summary;
  if (displaySummary) {
    console.log(`                ${chalk.dim(displaySummary.slice(0, 60))}`);
  }
  printReportRows(info.reports, "                ");
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show all sessions with branch, activity, PR, and CI status")
    .option("-p, --project <id>", "Filter by project ID")
    .option("--json", "Output as JSON")
    .option("-w, --watch", "Refresh the status view continuously")
    .option("--interval <seconds>", "Refresh interval in seconds (default: 5)")
    .option(
      "--include-terminated",
      "Include terminated sessions (killed/done/merged/terminated/errored/cleanup)",
    )
    .option(
      "--reports <value>",
      'Show agent report history per session. "full" for all entries, or a number for last N entries.',
    )
    .action(async (opts: StatusOptions) => {
      if (opts.watch && opts.json) {
        console.error(chalk.red("--watch cannot be used with --json."));
        process.exit(1);
      }

      let watchIntervalSeconds = DEFAULT_WATCH_INTERVAL_SECONDS;
      if (opts.watch) {
        try {
          watchIntervalSeconds = parseWatchIntervalSeconds(opts.interval);
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
      }

      let reportsLimit = 0;
      try {
        reportsLimit = parseReportsLimit(opts.reports);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const renderStatus = async (refreshing = false): Promise<void> => {
        if (refreshing) {
          maybeClearScreen();
        }

        let config: ReturnType<typeof loadConfig>;
        try {
          config = loadConfig();
        } catch {
          console.log(chalk.yellow("No config found. Run `ao start` to create one."));
          console.log(chalk.dim("Falling back to session discovery...\n"));
          await showFallbackStatus();
          return;
        }

        if (opts.project && !config.projects[opts.project]) {
          console.error(chalk.red(`Unknown project: ${opts.project}`));
          process.exit(1);
        }

        // Use session manager to list sessions (metadata-based, not tmux-based)
        const sm = await getSessionManager(config);
        const registry = await getPluginRegistry(config);
        const allSessions = await sm.list(opts.project);

        // Count terminal sessions that would be hidden by default, then drop
        // them unless --include-terminated is passed. Recomputed each render
        // so --watch reflects transitions to terminal state live.
        const hiddenTerminatedCount = opts.includeTerminated
          ? 0
          : allSessions.filter(isTerminalSession).length;
        const sessions = opts.includeTerminated
          ? allSessions
          : allSessions.filter((s) => !isTerminalSession(s));

        if (!opts.json) {
          console.log(banner("AGENT ORCHESTRATOR STATUS"));
          if (opts.watch) {
            console.log(
              chalk.dim(
                `Refreshing every ${watchIntervalSeconds}s. Press Ctrl+C to exit.`,
              ),
            );
            console.log();
          } else {
            console.log();
          }
        }

        // Group sessions by project
        const byProject = new Map<string, Session[]>();
        for (const s of sessions) {
          const list = byProject.get(s.projectId) ?? [];
          list.push(s);
          byProject.set(s.projectId, list);
        }

        // Show projects that have no sessions too (if not filtered)
        const projectIds = opts.project ? [opts.project] : Object.keys(config.projects);
        const jsonOutput: SessionInfo[] = [];
        let totalWorkers = 0;
        let totalOrchestrators = 0;

        for (const projectId of projectIds) {
          const projectConfig = config.projects[projectId];
          if (!projectConfig) continue;

          const projectSessions = (byProject.get(projectId) ?? []).sort((a, b) =>
            a.id.localeCompare(b.id),
          );

          // Resolve agent and SCM for this project via the shared registry
          const agentName = projectConfig.agent ?? config.defaults.agent;
          const agent = getAgentByNameFromRegistry(registry, agentName);
          const scm = getSCMFromRegistry(registry, config, projectId);

          if (!opts.json) {
            console.log(header(projectConfig.name || projectId));
          }

          if (projectSessions.length === 0) {
            if (!opts.json) {
              console.log(chalk.dim("  (no active sessions)"));
              console.log();
            }
            continue;
          }

          // Gather all session info in parallel
          const infoPromises = projectSessions.map((s) => gatherSessionInfo(s, agent, scm, config, reportsLimit));
          const sessionInfos = await Promise.all(infoPromises);

          const orchestrators = sessionInfos.filter((info) => info.role === "orchestrator");
          const workers = sessionInfos.filter((info) => info.role === "worker");

          totalWorkers += workers.length;
          totalOrchestrators += orchestrators.length;

          for (const info of sessionInfos) {
            if (opts.json) {
              jsonOutput.push(info);
            }
          }

          if (opts.json) {
            continue;
          }

          if (orchestrators.length > 0) {
            for (const info of orchestrators) {
              printOrchestratorRow(info);
            }
          }

          if (workers.length === 0) {
            console.log(chalk.dim("  (no active sessions)"));
            console.log();
            continue;
          }

          printTableHeader();
          for (const info of workers) {
            printSessionRow(info);
          }
          console.log();
        }

        if (opts.json) {
          console.log(
            JSON.stringify(
              { data: jsonOutput, meta: { hiddenTerminatedCount } },
              null,
              2,
            ),
          );
        } else {
          console.log(
            chalk.dim(
              `  ${totalWorkers} active session${totalWorkers !== 1 ? "s" : ""} across ${projectIds.length} project${projectIds.length !== 1 ? "s" : ""}` +
                (totalOrchestrators > 0
                  ? ` · ${totalOrchestrators} orchestrator${totalOrchestrators !== 1 ? "s" : ""}`
                  : ""),
            ),
          );

          if (hiddenTerminatedCount > 0) {
            console.log(
              chalk.dim(
                `  ${hiddenTerminatedCount} terminated session${hiddenTerminatedCount !== 1 ? "s" : ""} hidden. Use --include-terminated to show.`,
              ),
            );
          }

          // Check for issues awaiting verification across all projects
          try {
            let unverifiedTotal = 0;
            for (const projectId of projectIds) {
              const project: ProjectConfig | undefined = config.projects[projectId];
              if (!project?.tracker?.plugin) continue;
              const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
              if (!tracker?.listIssues) continue;
              try {
                const issues = await tracker.listIssues(
                  { state: "open", labels: ["merged-unverified"], limit: 20 },
                  project,
                );
                unverifiedTotal += issues.length;
              } catch {
                // Tracker query failed — not critical
              }
            }

            if (unverifiedTotal > 0) {
              console.log(
                chalk.yellow(
                  `  ⚠ ${unverifiedTotal} issue${unverifiedTotal !== 1 ? "s" : ""} awaiting verification (use \`ao verify --list\` to see them)`,
                ),
              );
            }
          } catch {
            // Plugin registry or tracker unavailable — skip silently
          }

          console.log();
        }
      };

      await renderStatus();

      if (!opts.watch) {
        return;
      }

      let rendering = false;
      const watchTimer = setInterval(() => {
        if (rendering) return;
        rendering = true;
        void renderStatus(true)
          .catch((err) => {
            console.error(
              chalk.red(
                `Watch refresh failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          })
          .finally(() => {
            rendering = false;
          });
      }, watchIntervalSeconds * 1000);

      const shutdown = (): void => {
        clearInterval(watchTimer);
        process.exit(0);
      };

      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
}

async function showFallbackStatus(): Promise<void> {
  const allTmux = await getTmuxSessions();
  if (allTmux.length === 0) {
    console.log(chalk.dim("No tmux sessions found."));
    return;
  }

  console.log(banner("AGENT ORCHESTRATOR STATUS"));
  console.log();
  console.log(
    chalk.dim(`  ${allTmux.length} tmux session${allTmux.length !== 1 ? "s" : ""} found\n`),
  );

  // Use claude-code as default agent for fallback introspection
  const agent = getAgentByName("claude-code");

  const sortedSessions = allTmux.sort();

  // Pre-fetch activity and introspection in parallel
  const details = await Promise.all(
    sortedSessions.map(async (session) => {
      const activityTsPromise = getTmuxActivity(session).catch(() => null);
      const lifecycle = createInitialCanonicalLifecycle("worker", new Date());
      lifecycle.session.state = "working";
      lifecycle.session.reason = "task_in_progress";
      lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
      lifecycle.runtime.state = "alive";
      lifecycle.runtime.reason = "process_running";
      lifecycle.runtime.handle = { id: session, runtimeName: "tmux", data: {} };

      const sessionObj: Session = {
        id: session,
        projectId: "",
        status: "working",
        activity: null,
        activitySignal: createActivitySignal("unavailable"),
        lifecycle,
        branch: null,
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: lifecycle.runtime.handle,
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {},
      };

      const introspectionPromise = agent.getSessionInfo(sessionObj).catch(() => null);

      const [activityTs, introspection] = await Promise.all([
        activityTsPromise,
        introspectionPromise,
      ]);

      return { activityTs, introspection };
    }),
  );

  for (let i = 0; i < sortedSessions.length; i++) {
    const session = sortedSessions[i];
    const { activityTs, introspection } = details[i];

    const lastActivity = activityTs ? formatAge(activityTs) : "-";
    console.log(`  ${chalk.green(session)} ${chalk.dim(`(${lastActivity})`)}`);

    if (introspection?.summary) {
      console.log(`     ${chalk.dim("Claude:")} ${introspection.summary.slice(0, 65)}`);
    }
  }
  console.log();
}
