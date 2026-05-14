import type { ObservabilityLevel } from "./observability.js";

/**
 * Agent Orchestrator — Core Type Definitions
 *
 * This file defines ALL interfaces and types that the system uses.
 * Every plugin, CLI command, and web API route builds against these.
 *
 * Architecture: 8 plugin slots + core services
 *   1. Runtime    — where sessions execute (tmux, docker, k8s, process)
 *   2. Agent      — AI coding tool (claude-code, codex, aider)
 *   3. Workspace  — code isolation (worktree, clone)
 *   4. Tracker    — issue tracking (github, linear, jira)
 *   5. SCM        — source platform + PR/CI/reviews (github, gitlab)
 *   6. Notifier   — push notifications (desktop, slack, webhook)
 *   7. Terminal   — human interaction UI (iterm2, web, none)
 *   8. Lifecycle Manager (core, not pluggable)
 */

// =============================================================================
// SESSION
// =============================================================================

/** Unique session identifier, e.g. "my-app-1", "backend-12" */
export type SessionId = string;

export type SessionKind = "worker" | "orchestrator";

export type CanonicalSessionState =
  | "not_started"
  | "working"
  | "idle"
  | "needs_input"
  | "stuck"
  | "detecting"
  | "done"
  | "terminated";

export type CanonicalSessionReason =
  | "spawn_requested"
  | "agent_acknowledged"
  | "task_in_progress"
  | "pr_created"
  | "pr_closed_waiting_decision"
  | "fixing_ci"
  | "resolving_review_comments"
  | "awaiting_user_input"
  | "awaiting_external_review"
  | "research_complete"
  | "merged_waiting_decision"
  | "manually_killed"
  | "pr_merged"
  | "auto_cleanup"
  | "runtime_lost"
  | "agent_process_exited"
  | "probe_failure"
  | "error_in_process";

export type CanonicalPRState = "none" | "open" | "merged" | "closed";

export type CanonicalPRReason =
  | "not_created"
  | "in_progress"
  | "ci_failing"
  | "review_pending"
  | "changes_requested"
  | "approved"
  | "merge_ready"
  | "merged"
  | "closed_unmerged"
  | "cleared_on_restore";

export type CanonicalRuntimeState = "unknown" | "alive" | "exited" | "missing" | "probe_failed";

export type CanonicalRuntimeReason =
  | "spawn_incomplete"
  | "process_running"
  | "process_missing"
  | "tmux_missing"
  | "manual_kill_requested"
  | "pr_merged_cleanup"
  | "auto_cleanup"
  | "probe_error";

export interface SessionStateRecord {
  kind: SessionKind;
  state: CanonicalSessionState;
  reason: CanonicalSessionReason;
  startedAt: string | null;
  completedAt: string | null;
  terminatedAt: string | null;
  lastTransitionAt: string;
}

export interface PRStateRecord {
  state: CanonicalPRState;
  reason: CanonicalPRReason;
  number: number | null;
  url: string | null;
  lastObservedAt: string | null;
}

export interface RuntimeStateRecord {
  state: CanonicalRuntimeState;
  reason: CanonicalRuntimeReason;
  lastObservedAt: string | null;
  handle: RuntimeHandle | null;
  tmuxName: string | null;
}

export interface CanonicalSessionLifecycle {
  version: 2;
  session: SessionStateRecord;
  pr: PRStateRecord;
  runtime: RuntimeStateRecord;
}

/** Session lifecycle states */
export type SessionStatus =
  | "spawning"
  | "working"
  | "detecting"
  | "pr_open"
  | "ci_failed"
  | "review_pending"
  | "changes_requested"
  | "approved"
  | "mergeable"
  | "merged"
  | "cleanup"
  | "needs_input"
  | "stuck"
  | "errored"
  | "killed"
  | "idle"
  | "done"
  | "terminated";

/** Activity state as detected by the agent plugin */
export type ActivityState =
  | "active" // agent is processing (thinking, writing code)
  | "ready" // agent finished its turn, alive and waiting for input
  | "idle" // agent has been inactive for a while (stale)
  | "waiting_input" // agent is asking a question / permission prompt
  | "blocked" // agent hit an error or is stuck
  | "exited"; // agent process is no longer running

/** Activity state constants */
export const ACTIVITY_STATE = {
  ACTIVE: "active" as const,
  READY: "ready" as const,
  IDLE: "idle" as const,
  WAITING_INPUT: "waiting_input" as const,
  BLOCKED: "blocked" as const,
  EXITED: "exited" as const,
} satisfies Record<string, ActivityState>;

export type ActivitySignalState = "valid" | "stale" | "null" | "unavailable" | "probe_failure";

export type ActivitySignalSource = "native" | "terminal" | "runtime" | "none";

export interface ActivitySignal {
  /** Confidence bucket for the activity probe result. */
  state: ActivitySignalState;
  /** The observed activity value, if one was surfaced. */
  activity: ActivityState | null;
  /** Timestamp that makes timing-based inferences safe, when available. */
  timestamp?: Date;
  /** Where the activity signal came from. */
  source: ActivitySignalSource;
  /** Optional extra detail for stale / failed probes. */
  detail?: string;
}

/** Result of activity detection, carrying both the state and an optional timestamp. */
export interface ActivityDetection {
  state: ActivityState;
  /** When activity was last observed (e.g., agent log file mtime) */
  timestamp?: Date;
}

/** A single entry in the AO activity JSONL log, written by agent plugins. */
export interface ActivityLogEntry {
  /** ISO 8601 timestamp */
  ts: string;
  /** Activity state derived from terminal output or agent-native data */
  state: ActivityState;
  /** What triggered this state classification */
  source: "terminal" | "native";
  /** Raw terminal snippet that caused waiting_input/blocked (for debugging) */
  trigger?: string;
}

/** Default threshold (ms) before a "ready" session becomes "idle". */
export const DEFAULT_READY_THRESHOLD_MS = 300_000; // 5 minutes

/** Default window (ms) for "active" state — activity newer than this is "active", older is "ready". */
export const DEFAULT_ACTIVE_WINDOW_MS = 30_000; // 30 seconds

/** Session status constants */
export const SESSION_STATUS = {
  SPAWNING: "spawning" as const,
  WORKING: "working" as const,
  DETECTING: "detecting" as const,
  PR_OPEN: "pr_open" as const,
  CI_FAILED: "ci_failed" as const,
  REVIEW_PENDING: "review_pending" as const,
  CHANGES_REQUESTED: "changes_requested" as const,
  APPROVED: "approved" as const,
  MERGEABLE: "mergeable" as const,
  MERGED: "merged" as const,
  CLEANUP: "cleanup" as const,
  NEEDS_INPUT: "needs_input" as const,
  STUCK: "stuck" as const,
  ERRORED: "errored" as const,
  IDLE: "idle" as const,
  KILLED: "killed" as const,
  DONE: "done" as const,
  TERMINATED: "terminated" as const,
} satisfies Record<string, SessionStatus>;

/** Statuses that indicate the session is in a terminal (dead) state. */
export const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "killed",
  "terminated",
  "done",
  "cleanup",
  "errored",
  "merged",
]);

/** Activity states that indicate the session is no longer running. */
export const TERMINAL_ACTIVITIES: ReadonlySet<ActivityState> = new Set(["exited"]);

/** Statuses that must never be restored. */
export const NON_RESTORABLE_STATUSES: ReadonlySet<SessionStatus> = new Set([]);

/** Check if a session is in a terminal (dead) state. */
export function isTerminalSession(session: {
  status: SessionStatus;
  activity: ActivityState | null;
  lifecycle?: CanonicalSessionLifecycle;
}): boolean {
  if (session.lifecycle) {
    return (
      session.lifecycle.session.state === "done" ||
      session.lifecycle.session.state === "terminated" ||
      session.lifecycle.pr.state === "merged" ||
      session.lifecycle.runtime.state === "missing" ||
      session.lifecycle.runtime.state === "exited"
    );
  }
  return (
    TERMINAL_STATUSES.has(session.status) ||
    (session.activity !== null && TERMINAL_ACTIVITIES.has(session.activity))
  );
}

/** Check if a session can be restored. */
export function isRestorable(session: {
  status: SessionStatus;
  activity: ActivityState | null;
  lifecycle?: CanonicalSessionLifecycle;
}): boolean {
  if (session.lifecycle) {
    return (
      isTerminalSession(session) &&
      !NON_RESTORABLE_STATUSES.has(session.status)
    );
  }
  return isTerminalSession(session) && !NON_RESTORABLE_STATUSES.has(session.status);
}

/** A running agent session */
export interface Session {
  /** Unique session ID, e.g. "my-app-3" */
  id: SessionId;

  /** Which project this session belongs to */
  projectId: string;

  /** Current lifecycle status */
  status: SessionStatus;

  /** Activity state from agent plugin (null = not yet determined) */
  activity: ActivityState | null;

  /** Explicit confidence/availability contract for the current activity signal. */
  activitySignal: ActivitySignal;

  /** Canonical lifecycle truth persisted in metadata. */
  lifecycle: CanonicalSessionLifecycle;

  /** Git branch name */
  branch: string | null;

  /** Issue identifier (if working on an issue) */
  issueId: string | null;

  /** PR info (once PR is created) */
  pr: PRInfo | null;

  /** Workspace path on disk */
  workspacePath: string | null;

  /** Runtime handle for communicating with the session */
  runtimeHandle: RuntimeHandle | null;

  /** Agent session info (summary, cost, etc.) */
  agentInfo: AgentSessionInfo | null;

  /** When the session was created */
  createdAt: Date;

  /** Last activity timestamp */
  lastActivityAt: Date;

  /** When this session was last restored (undefined if never restored) */
  restoredAt?: Date;

  /** Metadata key-value pairs */
  metadata: Record<string, string>;
}

export function isOrchestratorSession(
  session: { id: SessionId; metadata?: Record<string, string> },
  sessionPrefix?: string,
  allSessionPrefixes?: string[],
): boolean {
  if (session.metadata?.["role"] === "orchestrator") {
    return true;
  }
  if (!sessionPrefix) {
    return false;
  }
  const escaped = sessionPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (session.id === `${sessionPrefix}-orchestrator`) {
    return true;
  }
  if (!new RegExp(`^${escaped}-orchestrator-\\d+$`).test(session.id)) {
    return false;
  }
  // Guard against cross-project false positives: if the session ID is a plain
  // numbered worker for any other known prefix (e.g. prefix "app-orchestrator"
  // matches "app-orchestrator-1" as a worker), it is not an orchestrator.
  if (allSessionPrefixes) {
    for (const prefix of allSessionPrefixes) {
      if (prefix === sessionPrefix) continue;
      if (
        new RegExp(
          `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`,
        ).test(session.id)
      ) {
        return false;
      }
    }
  }
  return true;
}

/** Config for creating a new session */
export interface SessionSpawnConfig {
  projectId: string;
  issueId?: string;
  branch?: string;
  prompt?: string;
  /** Override the agent plugin for this session (e.g. "codex", "claude-code") */
  agent?: string;
  /** Override the OpenCode subagent for this session (e.g. "sisyphus", "oracle") */
  subagent?: string;
}

/** Config for creating an orchestrator session */
export interface OrchestratorSpawnConfig {
  projectId: string;
  systemPrompt?: string;
  /** Override the agent plugin for this orchestrator (e.g. "codex", "claude-code", "opencode") */
  agent?: string;
}

// =============================================================================
// RUNTIME — Plugin Slot 1
// =============================================================================

/**
 * Runtime determines WHERE and HOW agent sessions execute.
 * tmux, docker, kubernetes, child processes, SSH, cloud sandboxes, etc.
 */
export interface Runtime {
  readonly name: string;

  /** Create a new session environment and return a handle */
  create(config: RuntimeCreateConfig): Promise<RuntimeHandle>;

  /** Destroy a session environment */
  destroy(handle: RuntimeHandle): Promise<void>;

  /** Send a text message/prompt to the running agent */
  sendMessage(handle: RuntimeHandle, message: string): Promise<void>;

  /** Capture recent output from the session */
  getOutput(handle: RuntimeHandle, lines?: number): Promise<string>;

  /** Check if the session environment is still alive */
  isAlive(handle: RuntimeHandle): Promise<boolean>;

  /** Get resource metrics (uptime, memory, etc.) */
  getMetrics?(handle: RuntimeHandle): Promise<RuntimeMetrics>;

  /** Get info needed to attach a human to this session (for Terminal plugin) */
  getAttachInfo?(handle: RuntimeHandle): Promise<AttachInfo>;

  /**
   * Optional: validate that this runtime's prerequisites are present before
   * it is exercised by `ao spawn`. Throw with an actionable, human-readable
   * message; the CLI catches and formats the error.
   */
  preflight?(context: PreflightContext): Promise<void>;
}

export interface RuntimeCreateConfig {
  sessionId: SessionId;
  workspacePath: string;
  launchCommand: string;
  environment: Record<string, string>;
}

/** Opaque handle returned by runtime.create() */
export interface RuntimeHandle {
  /** Runtime-specific identifier (tmux session name, container ID, pod name, etc.) */
  id: string;
  /** Which runtime created this handle */
  runtimeName: string;
  /** Runtime-specific data */
  data: Record<string, unknown>;
}

export interface RuntimeMetrics {
  uptimeMs: number;
  memoryMb?: number;
  cpuPercent?: number;
}

export interface AttachInfo {
  /** How to connect: tmux attach, docker exec, SSH, web URL, etc. */
  type: "tmux" | "docker" | "ssh" | "web" | "process";
  /** For tmux: session name. For docker: container ID. For web: URL. */
  target: string;
  /** Optional: command to run to attach */
  command?: string;
}

// =============================================================================
// AGENT — Plugin Slot 2
// =============================================================================

/**
 * Agent adapter for a specific AI coding tool.
 * Knows how to launch, detect activity, and extract session info.
 */
export interface Agent {
  readonly name: string;

  /** Process name to look for (e.g. "claude", "codex", "aider") */
  readonly processName: string;

  /** Get the shell command to launch this agent */
  getLaunchCommand(config: AgentLaunchConfig): string;

  /** Get environment variables for the agent process */
  getEnvironment(config: AgentLaunchConfig): Record<string, string>;

  /**
   * Detect what the agent is currently doing from terminal output.
   * @deprecated Use getActivityState() instead - this uses hacky terminal parsing.
   */
  detectActivity(terminalOutput: string): ActivityState;

  /**
   * Get current activity state using agent-native mechanism (JSONL, SQLite, etc.).
   * This is the preferred method for activity detection.
   * @param readyThresholdMs - ms before "ready" becomes "idle" (default: DEFAULT_READY_THRESHOLD_MS)
   */
  getActivityState(session: Session, readyThresholdMs?: number): Promise<ActivityDetection | null>;

  /** Check if agent process is running (given runtime handle) */
  isProcessRunning(handle: RuntimeHandle): Promise<boolean>;

  /** Extract information from agent's internal data (summary, cost, session ID) */
  getSessionInfo(session: Session): Promise<AgentSessionInfo | null>;

  /**
   * Optional: get a launch command that resumes a previous session.
   * Returns null if no previous session is found (caller falls back to getLaunchCommand).
   */
  getRestoreCommand?(session: Session, project: ProjectConfig): Promise<string | null>;

  /**
   * Optional: run setup BEFORE the agent process is launched.
   *
   * Use this when a plugin needs to observe state that the agent itself will
   * mutate at startup. Captured *after* the workspace exists but *before*
   * `runtime.create()` spawns the agent — so the snapshot is taken cleanly,
   * with no race against the agent's own initialization writes.
   *
   * Receives only the workspace path because the full Session object (with
   * runtime handle, lifecycle, etc.) does not exist yet at this point.
   */
  preLaunchSetup?(workspacePath: string): Promise<void>;

  /** Optional: run setup after agent is launched (e.g. configure MCP servers) */
  postLaunchSetup?(session: Session): Promise<void>;

  /**
   * Optional: Set up agent-specific hooks/config in the workspace for automatic metadata updates.
   * Called once per workspace during ao start and when creating new worktrees.
   *
   * Each agent plugin implements this for their own config format:
   * - Claude Code: writes .claude/settings.json with PostToolUse hook
   * - Codex: whatever config mechanism Codex uses
   * - Aider: .aider.conf.yml or similar
   * - OpenCode: its own config
   *
   * CRITICAL: The dashboard depends on metadata being auto-updated when agents
   * run git/gh commands. Without this, PRs created by agents never show up.
   */
  setupWorkspaceHooks?(workspacePath: string, config: WorkspaceHooksConfig): Promise<void>;

  /**
   * Optional: Record an activity observation to the session's JSONL activity log.
   * Called by the lifecycle manager during each poll cycle with captured terminal output.
   *
   * Plugins classify the terminal output (via detectActivity) and append a JSONL entry
   * to `{session.workspacePath}/.ao/activity.jsonl`. The next `getActivityState()` call
   * reads from this file to detect states like `waiting_input` and `blocked`.
   *
   * Agents with native JSONL (Claude Code, Codex) should NOT implement this — their
   * `getActivityState` already reads richer data from the agent's own session files.
   */
  recordActivity?(session: Session, terminalOutput: string): Promise<void>;

  /**
   * Optional: validate that this agent's prerequisites are present before
   * it is exercised by `ao spawn`. Throw with an actionable error message.
   */
  preflight?(context: PreflightContext): Promise<void>;
}

export interface AgentLaunchConfig {
  sessionId: SessionId;
  projectConfig: ProjectConfig;
  /**
   * Per-session workspace path. Differs from `projectConfig.path` when the
   * workspace plugin (e.g. worktree mode) creates an isolated checkout per
   * session. Plugins that need the agent's actual cwd — for cwd-derived
   * lookups, --work-dir flags, file-based discovery — must use this when
   * present. Falls back to `projectConfig.path` when undefined (clone-mode
   * workspaces, or plugins not yet plumbing it through).
   */
  workspacePath?: string;
  issueId?: string;
  prompt?: string;
  permissions?: AgentPermissionInput;
  model?: string;
  /**
   * System prompt to pass to the agent for orchestrator context.
   * - Claude Code: --append-system-prompt
   * - Codex: --system-prompt or AGENTS.md
   * - Aider: --system-prompt flag
   * - OpenCode: equivalent mechanism
   *
   * For short prompts only. For long prompts, use systemPromptFile instead
   * to avoid shell/tmux truncation issues.
   */
  systemPrompt?: string;
  /**
   * Path to a file containing the system prompt.
   * Preferred over systemPrompt for long prompts (e.g. orchestrator prompts)
   * because inlining 2000+ char prompts in shell commands causes truncation.
   *
   * When set, takes precedence over systemPrompt.
   * - Claude Code: --append-system-prompt "$(cat /path/to/file)"
   * - Codex/Aider: similar shell substitution
   */
  systemPromptFile?: string;
  /**
   * Specialized OpenCode subagent to use (e.g., sisyphus, oracle, librarian).
   * Requires oh-my-opencode to be installed.
   * Use --subagent flag to select the subagent.
   */
  subagent?: string;
}

export interface WorkspaceHooksConfig {
  /** Data directory where session metadata files are stored */
  dataDir: string;
  /** Optional session ID (may not be known at workspace setup time) */
  sessionId?: string;
}

export interface AgentSessionInfo {
  /** Agent's auto-generated summary of what it's working on */
  summary: string | null;
  /** True when summary is a fallback (e.g. truncated first user message), not a real agent summary */
  summaryIsFallback?: boolean;
  /** Agent's internal session ID (for resume) */
  agentSessionId: string | null;
  /** Agent-owned metadata worth persisting for later restore. */
  metadata?: Record<string, string>;
  /** Estimated cost so far */
  cost?: CostEstimate;
}

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

// =============================================================================
// WORKSPACE — Plugin Slot 3
// =============================================================================

/**
 * Workspace manages code isolation — how each session gets its own copy of the repo.
 */
export interface Workspace {
  readonly name: string;

  /** Create an isolated workspace for a session */
  create(config: WorkspaceCreateConfig): Promise<WorkspaceInfo>;

  /** Destroy a workspace */
  destroy(workspacePath: string): Promise<void>;

  /** List existing workspaces for a project */
  list(projectId: string): Promise<WorkspaceInfo[]>;

  /**
   * Optional: find a pre-existing AO-managed workspace that already tracks the
   * requested branch and can be adopted instead of creating a fresh workspace.
   */
  findManagedWorkspace?(config: WorkspaceCreateConfig): Promise<WorkspaceInfo | null>;

  /** Optional: run hooks after workspace creation (symlinks, installs, etc.) */
  postCreate?(info: WorkspaceInfo, project: ProjectConfig): Promise<void>;

  /** Optional: check if a workspace exists and is a valid git repo */
  exists?(workspacePath: string): Promise<boolean>;

  /** Optional: restore a workspace (e.g. recreate a worktree for an existing branch) */
  restore?(config: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo>;

  /**
   * Optional: validate that this workspace's prerequisites (e.g. git in PATH,
   * write access to the worktree root) are present before `ao spawn`.
   */
  preflight?(context: PreflightContext): Promise<void>;
}

export interface WorkspaceCreateConfig {
  projectId: string;
  project: ProjectConfig;
  sessionId: SessionId;
  branch: string;
  /** Override the base directory for worktrees (e.g. V2 project-scoped dir). */
  worktreeDir?: string;
}

export interface WorkspaceInfo {
  path: string;
  branch: string;
  sessionId: SessionId;
  projectId: string;
}

// =============================================================================
// TRACKER — Plugin Slot 4
// =============================================================================

/**
 * Issue/task tracker integration — GitHub Issues, Linear, Jira, etc.
 */
export interface Tracker {
  readonly name: string;

  /** Fetch issue details */
  getIssue(identifier: string, project: ProjectConfig): Promise<Issue>;

  /** Check if issue is completed/closed */
  isCompleted(identifier: string, project: ProjectConfig): Promise<boolean>;

  /** Generate a URL for the issue */
  issueUrl(identifier: string, project: ProjectConfig): string;

  /** Extract a human-readable label from an issue URL (e.g., "INT-1327", "#42") */
  issueLabel?(url: string, project: ProjectConfig): string;

  /** Generate a git branch name for the issue */
  branchName(identifier: string, project: ProjectConfig): string;

  /** Generate a prompt for the agent to work on this issue */
  generatePrompt(identifier: string, project: ProjectConfig): Promise<string>;

  /** Optional: list issues with filters */
  listIssues?(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]>;

  /** Optional: update issue state */
  updateIssue?(identifier: string, update: IssueUpdate, project: ProjectConfig): Promise<void>;

  /** Optional: create a new issue */
  createIssue?(input: CreateIssueInput, project: ProjectConfig): Promise<Issue>;

  /**
   * Optional: validate that this tracker's prerequisites (auth tokens, CLI
   * tools) are present before `ao spawn` runs. Throw with an actionable
   * error message.
   */
  preflight?(context: PreflightContext): Promise<void>;
}

export interface Issue {
  id: string;
  title: string;
  description: string;
  url: string;
  state: "open" | "in_progress" | "closed" | "cancelled";
  labels: string[];
  assignee?: string;
  priority?: number;
  branchName?: string;
}

export interface IssueFilters {
  state?: "open" | "closed" | "all";
  labels?: string[];
  assignee?: string;
  limit?: number;
}

export interface IssueUpdate {
  state?: "open" | "in_progress" | "closed";
  labels?: string[];
  removeLabels?: string[];
  assignee?: string;
  comment?: string;
}

export interface CreateIssueInput {
  title: string;
  description: string;
  labels?: string[];
  assignee?: string;
  priority?: number;
}

// =============================================================================
// SCM — Plugin Slot 5
// =============================================================================

/**
 * Source code management platform — PR lifecycle, CI checks, code reviews.
 * This is the richest plugin interface, covering the full PR pipeline.
 */
export interface SCM {
  readonly name: string;

  verifyWebhook?(
    request: SCMWebhookRequest,
    project: ProjectConfig,
  ): Promise<SCMWebhookVerificationResult>;

  parseWebhook?(
    request: SCMWebhookRequest,
    project: ProjectConfig,
  ): Promise<SCMWebhookEvent | null>;

  // --- PR Lifecycle ---

  /** Detect if a session has an open PR (by branch name) */
  detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null>;

  /** Resolve a PR reference (number or URL) into canonical PR metadata. */
  resolvePR?(reference: string, project: ProjectConfig): Promise<PRInfo>;

  /** Assign a PR to the currently authenticated user, if supported. */
  assignPRToCurrentUser?(pr: PRInfo): Promise<void>;

  /** Check out the PR branch into a workspace. Returns true if branch changed. */
  checkoutPR?(pr: PRInfo, workspacePath: string): Promise<boolean>;

  /** Get current PR state */
  getPRState(pr: PRInfo): Promise<PRState>;

  /** Get PR summary with stats (state, title, additions, deletions). Optional. */
  getPRSummary?(pr: PRInfo): Promise<{
    state: PRState;
    title: string;
    additions: number;
    deletions: number;
  }>;

  /** Merge a PR */
  mergePR(pr: PRInfo, method?: MergeMethod): Promise<void>;

  /** Close a PR without merging */
  closePR(pr: PRInfo): Promise<void>;

  // --- CI Tracking ---

  /** Get individual CI check statuses */
  getCIChecks(pr: PRInfo): Promise<CICheck[]>;

  /** Get overall CI summary */
  getCISummary(pr: PRInfo): Promise<CIStatus>;

  // --- Review Tracking ---

  /** Get all reviews on a PR */
  getReviews(pr: PRInfo): Promise<Review[]>;

  /** Get the overall review decision */
  getReviewDecision(pr: PRInfo): Promise<ReviewDecision>;

  /** Get pending (unresolved) review comments */
  getPendingComments(pr: PRInfo): Promise<ReviewComment[]>;

  /**
   * Get all review threads (human + bot) with isBot flag.
   * Single GraphQL call for all review threads (human + bot) with review summaries.
   * Returns unresolved threads only.
   *
   * Optional — plugins that do not implement this method will fall back to
   * `getPendingComments()` (which lacks `isBot` classification and review
   * summaries). New SCM plugins should prefer implementing this method.
   *
   * @since 0.6.0 — replaces the removed `getAutomatedComments` method.
   */
  getReviewThreads?(pr: PRInfo): Promise<ReviewThreadsResult>;

  // --- Merge Readiness ---

  /** Check if PR is ready to merge */
  getMergeability(pr: PRInfo): Promise<MergeReadiness>;

  /**
   * Batch fetch PR data for multiple PRs in a single GraphQL query.
   * Used by the orchestrator to poll all active sessions efficiently.
   *
   * This is an optimization method that, when implemented, can dramatically
   * reduce API calls by fetching data for multiple PRs in one request
   * instead of calling getPRState/getCISummary/getReviewDecision separately
   * for each PR.
   *
   * @param prs - Array of PR information to fetch data for
   * @param observer - Optional observer for batch operation metrics
   * @returns Map keyed by "${owner}/${repo}#${number}" containing enrichment data
   */
  enrichSessionsPRBatch?(prs: PRInfo[], observer?: BatchObserver, repos?: string[]): Promise<Map<string, PREnrichmentData>>;

  /**
   * Optional: validate that this SCM's prerequisites (auth, CLI tools) are
   * present before `ao spawn` runs. Plugins should consult
   * `context.intent.willClaimExistingPR` and skip PR-write prereqs when the
   * spawn won't exercise them.
   */
  preflight?(context: PreflightContext): Promise<void>;
}

/**
 * Batch enrichment data returned by SCM plugins.
 * Contains all the information the orchestrator needs for status detection.
 */
export interface PREnrichmentData {
  /** Current PR state */
  state: PRState;
  /** Overall CI status */
  ciStatus: CIStatus;
  /** Review decision */
  reviewDecision: ReviewDecision;
  /** Whether the PR is mergeable based on CI, reviews, and merge state */
  mergeable: boolean;
  /** PR title */
  title?: string;
  /** Number of additions */
  additions?: number;
  /** Number of deletions */
  deletions?: number;
  /** Whether PR is a draft */
  isDraft?: boolean;
  /** Whether PR has merge conflicts */
  hasConflicts?: boolean;
  /** Whether PR is behind base branch */
  isBehind?: boolean;
  /** List of blockers preventing merge */
  blockers?: string[];
}

/**
 * Observer for GraphQL batch PR enrichment operations.
 * Used by SCM plugins to report batch success/failure to the observability system.
 */
export interface BatchObserver {
  /** Record a successful batch enrichment */
  recordSuccess(data: {
    batchIndex: number;
    totalBatches: number;
    prCount: number;
    durationMs: number;
  }): void;
  /** Record a failed batch enrichment */
  recordFailure(data: {
    batchIndex: number;
    totalBatches: number;
    prCount: number;
    error: string;
    durationMs: number;
  }): void;
  /** Log a message at a specific level */
  log(level: ObservabilityLevel, message: string): void;
  /** Called after ETag guards with repos where Guard 1 returned 304 (no PR list changes). */
  reportPRListUnchangedRepos?(repos: Set<string>): void;
}

// --- PR Types ---

export interface PRInfo {
  number: number;
  url: string;
  title: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  isDraft: boolean;
}

export type PRState = "open" | "merged" | "closed";

/** PR state constants */
export const PR_STATE = {
  OPEN: "open" as const,
  MERGED: "merged" as const,
  CLOSED: "closed" as const,
} satisfies Record<string, PRState>;

export type MergeMethod = "merge" | "squash" | "rebase";

export interface SCMWebhookRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  rawBody?: Uint8Array;
  path?: string;
  query?: Record<string, string | string[] | undefined>;
}

export interface SCMWebhookVerificationResult {
  ok: boolean;
  reason?: string;
  deliveryId?: string;
  eventType?: string;
}

export type SCMWebhookEventKind = "pull_request" | "ci" | "review" | "comment" | "push" | "unknown";

export interface SCMWebhookEvent {
  provider: string;
  kind: SCMWebhookEventKind;
  action: string;
  rawEventType: string;
  deliveryId?: string;
  projectId?: string;
  repository?: {
    owner: string;
    name: string;
  };
  prNumber?: number;
  branch?: string;
  sha?: string;
  timestamp?: Date;
  data: Record<string, unknown>;
}

// --- CI Types ---

export interface CICheck {
  name: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  url?: string;
  conclusion?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export type CIStatus = "pending" | "passing" | "failing" | "none";

/** CI status constants */
export const CI_STATUS = {
  PENDING: "pending" as const,
  PASSING: "passing" as const,
  FAILING: "failing" as const,
  NONE: "none" as const,
} satisfies Record<string, CIStatus>;

// --- Review Types ---

export interface Review {
  author: string;
  state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
  body?: string;
  submittedAt: Date;
}

export type ReviewDecision = "approved" | "changes_requested" | "pending" | "none";

export interface ReviewComment {
  id: string;
  /** GraphQL node ID of the review thread (for resolveReviewThread mutation). */
  threadId?: string;
  author: string;
  body: string;
  path?: string;
  line?: number;
  isResolved: boolean;
  createdAt: Date;
  url: string;
  /** Whether the comment was authored by a known bot */
  isBot?: boolean;
}

export interface ReviewSummary {
  author: string;
  state: string;
  body: string;
  submittedAt: Date;
}

export interface ReviewThreadsResult {
  threads: ReviewComment[];
  reviews: ReviewSummary[];
}

export interface AutomatedComment {
  id: string;
  botName: string;
  body: string;
  path?: string;
  line?: number;
  severity: "error" | "warning" | "info";
  createdAt: Date;
  url: string;
}

// --- Merge Readiness ---

export interface MergeReadiness {
  mergeable: boolean;
  ciPassing: boolean;
  approved: boolean;
  noConflicts: boolean;
  blockers: string[];
}

/**
 * Batch enrichment data returned by SCM plugins.
 * Contains all the information the orchestrator needs for status detection.
 */
export interface PREnrichmentData {
  /** Current PR state */
  state: PRState;
  /** Overall CI status */
  ciStatus: CIStatus;
  /** Review decision */
  reviewDecision: ReviewDecision;
  /** Whether the PR is mergeable based on CI, reviews, and merge state */
  mergeable: boolean;
  /** PR title */
  title?: string;
  /** Number of additions */
  additions?: number;
  /** Number of deletions */
  deletions?: number;
  /** Whether PR is a draft */
  isDraft?: boolean;
  /** Whether PR has merge conflicts */
  hasConflicts?: boolean;
  /** Whether PR is behind base branch */
  isBehind?: boolean;
  /** List of blockers preventing merge */
  blockers?: string[];
  /** Individual CI check results (populated from batch enrichment when available) */
  ciChecks?: CICheck[];
}

/**
 * Observer for GraphQL batch PR enrichment operations.
 * Used by SCM plugins to report batch success/failure to the observability system.
 */
export interface BatchObserver {
  /** Record a successful batch enrichment */
  recordSuccess(data: {
    batchIndex: number;
    totalBatches: number;
    prCount: number;
    durationMs: number;
  }): void;
  /** Record a failed batch enrichment */
  recordFailure(data: {
    batchIndex: number;
    totalBatches: number;
    prCount: number;
    error: string;
    durationMs: number;
  }): void;
  /** Log a message at a specific level */
  log(level: ObservabilityLevel, message: string): void;
}
// =============================================================================
// NOTIFIER — Plugin Slot 6 (PRIMARY INTERFACE)
// =============================================================================

/**
 * Notifier is the PRIMARY interface between the orchestrator and the human.
 * The human walks away after spawning agents. Notifications bring them back.
 *
 * Push, not pull. The human never polls.
 */
export interface Notifier {
  readonly name: string;

  /** Push a notification to the human */
  notify(event: OrchestratorEvent): Promise<void>;

  /** Push a notification with actionable buttons/links */
  notifyWithActions?(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void>;

  /** Post a message to a channel (for team-visible notifiers like Slack) */
  post?(message: string, context?: NotifyContext): Promise<string | null>;
}

export interface NotifyAction {
  label: string;
  url?: string;
  callbackEndpoint?: string;
}

export interface NotifyContext {
  sessionId?: SessionId;
  projectId?: string;
  prUrl?: string;
  channel?: string;
}

// =============================================================================
// TERMINAL — Plugin Slot 7
// =============================================================================

/**
 * Terminal manages how humans view/interact with running sessions.
 * Opens IDE tabs, browser windows, or terminal sessions.
 */
export interface Terminal {
  readonly name: string;

  /** Open a session for human interaction */
  openSession(session: Session): Promise<void>;

  /** Open all sessions for a project */
  openAll(sessions: Session[]): Promise<void>;

  /** Check if a session is already open in a tab/window */
  isSessionOpen?(session: Session): Promise<boolean>;
}

// =============================================================================
// EVENTS
// =============================================================================

/** Priority levels for events — determines notification routing */
export type EventPriority = "urgent" | "action" | "warning" | "info";

/** All orchestrator event types */
export type EventType =
  // Session lifecycle
  | "session.spawn_started"
  | "session.spawned"
  | "session.working"
  | "session.exited"
  | "session.killed"
  | "session.idle"
  | "session.stuck"
  | "session.needs_input"
  | "session.errored"
  // PR lifecycle
  | "pr.created"
  | "pr.updated"
  | "pr.merged"
  | "pr.closed"
  // CI
  | "ci.passing"
  | "ci.failing"
  | "ci.fix_sent"
  | "ci.fix_failed"
  // Reviews
  | "review.pending"
  | "review.approved"
  | "review.changes_requested"
  | "review.comments_sent"
  | "review.comments_unresolved"
  // Automated reviews
  | "automated_review.found"
  | "automated_review.fix_sent"
  // Merge
  | "merge.ready"
  | "merge.conflicts"
  | "merge.completed"
  // Reactions
  | "reaction.triggered"
  | "reaction.escalated"
  // Summary
  | "summary.all_complete";

/** An event emitted by the orchestrator */
export interface OrchestratorEvent {
  id: string;
  type: EventType;
  priority: EventPriority;
  sessionId: SessionId;
  projectId: string;
  timestamp: Date;
  message: string;
  data: Record<string, unknown>;
}

// =============================================================================
// REACTIONS
// =============================================================================

/** A configured automatic reaction to an event */
export interface ReactionConfig {
  /** Whether this reaction is enabled */
  auto: boolean;

  /** What to do: send message to agent, notify human, auto-merge */
  action: "send-to-agent" | "notify" | "auto-merge";

  /** Message to send (for send-to-agent) */
  message?: string;

  /** Priority for notifications */
  priority?: EventPriority;

  /** How many times to retry send-to-agent before escalating */
  retries?: number;

  /** Escalate to human notification after this many failures or this duration */
  escalateAfter?: number | string;

  /** Threshold duration for time-based triggers (e.g. "10m" for stuck detection) */
  threshold?: string;

  /** Whether to include a summary in the notification */
  includeSummary?: boolean;
}

export interface ReactionResult {
  reactionType: string;
  success: boolean;
  action: string;
  message?: string;
  escalated: boolean;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Power management configuration.
 * Controls system sleep behavior while AO is running.
 */
export interface PowerConfig {
  /**
   * Prevent macOS idle sleep while AO is running.
   * Uses `caffeinate -i -w <pid>` to hold an assertion.
   * Defaults to true on macOS, no-op on other platforms.
   */
  preventIdleSleep: boolean;
}

/** Lifecycle-level orchestration configuration. */
export interface LifecycleConfig {
  /**
   * When a session's PR is detected as merged, automatically tear down the
   * tmux runtime, remove the worktree, and archive the session metadata.
   * Defaults to true so `ao status` does not retain stale merged entries.
   */
  autoCleanupOnMerge: boolean;
  /**
   * Maximum time (ms) to wait after a session enters `merged` before forcing
   * cleanup regardless of agent activity. If the agent becomes idle sooner,
   * cleanup happens then. Defaults to 5 minutes.
   */
  mergeCleanupIdleGraceMs: number;
}

/** Top-level orchestrator configuration (from agent-orchestrator.yaml) */
export interface OrchestratorConfig {
  /** Optional JSON Schema hint for editor autocomplete/validation. */
  "$schema"?: string;

  /**
   * Path to the config file (set automatically during load).
   * Used for hash-based directory structure.
   * All paths are auto-derived from this location.
   */
  configPath: string;

  /** Web dashboard port (defaults to 3000) */
  port?: number;

  /** Terminal WebSocket server port (defaults to 3001) */
  terminalPort?: number;

  /** Direct terminal WebSocket server port (defaults to 3003) */
  directTerminalPort?: number;

  /** Milliseconds before a "ready" session becomes "idle" (default: 300000 = 5 min) */
  readyThresholdMs: number;

  /** Power management settings (idle sleep prevention, etc.). Populated with defaults post-validation. */
  power?: PowerConfig;

  /**
   * Lifecycle-level orchestration settings. Populated with defaults by Zod
   * when loaded from YAML, but typed as optional so hand-constructed test
   * configs remain valid. Consumers should destructure with defaults rather
   * than dereferencing directly. Mirrors the `power?` pattern above.
   */
  lifecycle?: LifecycleConfig;

  /** Default plugin selections */
  defaults: DefaultPlugins;

  /** Installer-managed external plugin descriptors */
  plugins?: InstalledPluginConfig[];

  /** Project configurations */
  projects: Record<string, ProjectConfig>;

  /** Dashboard UI configuration */
  dashboard?: DashboardConfig;

  /** Notification channel configs */
  notifiers: Record<string, NotifierConfig>;

  /** Notification routing by priority */
  notificationRouting: Record<EventPriority, string[]>;

  /** Default reaction configs */
  reactions: Record<string, ReactionConfig>;

  /**
   * Internal: External plugin entries collected from inline tracker/scm/notifier configs.
   * Used by plugin-registry for manifest validation. Set automatically during config validation.
   */
  _externalPluginEntries?: ExternalPluginEntryRef[];
}

export interface DegradedProjectEntry {
  projectId: string;
  path: string;
  resolveError: string;
}

export interface LoadedConfig extends OrchestratorConfig {
  degradedProjects: Record<string, DegradedProjectEntry>;
}

/**
 * Structured location of an external plugin config.
 * Used to update config with manifest.name after loading (avoids parsing dotted strings).
 */
export type ExternalPluginLocation =
  | { kind: "project"; projectId: string; configType: "tracker" | "scm" }
  | { kind: "notifier"; notifierId: string };

/**
 * Reference to an external plugin config (from inline tracker/scm/notifier configs).
 * Used for manifest.name validation during plugin loading.
 */
export interface ExternalPluginEntryRef {
  /** Where this config came from (for error messages) */
  source: string;
  /** Structured location for updating config (avoids parsing source string) */
  location: ExternalPluginLocation;
  /** The slot this plugin fills */
  slot: "tracker" | "scm" | "notifier";
  /** npm package name (if specified) */
  package?: string;
  /** Local path (if specified) */
  path?: string;
  /**
   * Expected plugin name (manifest.name).
   * Only set when user explicitly specified `plugin` field.
   * When undefined, any manifest.name is accepted and config is updated with it.
   */
  expectedPluginName?: string;
}

/**
 * Dashboard attention zone display mode.
 *
 * - "simple" (default): collapses the 5 detailed zones into 4 by merging
 *   REVIEW + RESPOND into a single ACTION column. The card-level badges
 *   still expose the underlying state (ci_failed, needs_input, changes_requested).
 * - "detailed": preserves the original 5-zone Kanban layout for power users
 *   who want REVIEW and RESPOND as distinct columns.
 */
export type DashboardAttentionZoneMode = "simple" | "detailed";

export interface DashboardConfig {
  /** Attention zone layout (defaults to "simple") */
  attentionZones?: DashboardAttentionZoneMode;
}

export interface DefaultPlugins {
  runtime: string;
  agent: string;
  workspace: string;
  notifiers: string[];
  orchestrator?: {
    agent?: string;
  };
  worker?: {
    agent?: string;
  };
}

export type InstalledPluginSource = "registry" | "npm" | "local";

export interface InstalledPluginConfig {
  /** Stable logical plugin name used in config and CLI UX */
  name: string;

  /** Where the plugin should be resolved from */
  source: InstalledPluginSource;

  /** Package name for registry/npm-managed plugins */
  package?: string;

  /** Requested version/range for installer-managed plugins */
  version?: string;

  /** Filesystem path for local plugins */
  path?: string;

  /** Installer-managed enable flag (defaults to true) */
  enabled?: boolean;
}

export interface RoleAgentConfig {
  agent?: string;
  agentConfig?: AgentSpecificConfig;
}

export interface ProjectConfig {
  /** Display name */
  name: string;

  /** Repository path for the configured SCM provider, e.g. "owner/repo" or "group/subgroup/repo" (optional — omitted when no remote detected) */
  repo?: string;

  /** Local path to the repo */
  path: string;

  resolveError?: string;

  /** Default branch (main, master, next, develop, etc.) */
  defaultBranch: string;

  /** Session name prefix (e.g. "app" → "app-1", "app-2") */
  sessionPrefix: string;

  /** Whether this project is active in portfolio and dashboard surfaces */
  enabled?: boolean;

  /** Override default runtime */
  runtime?: string;

  /** Override default agent */
  agent?: string;

  /** Override default workspace */
  workspace?: string;

  /** Environment variables forwarded into worker session runtimes (AO_* internals always win) */
  env?: Record<string, string>;

  /** Issue tracker configuration */
  tracker?: TrackerConfig;

  /** SCM configuration (usually inferred from repo) */
  scm?: SCMConfig;

  /** Files/dirs to symlink into workspaces */
  symlinks?: string[];

  /** Commands to run after workspace creation */
  postCreate?: string[];

  /** Agent-specific configuration */
  agentConfig?: AgentSpecificConfig;

  orchestrator?: RoleAgentConfig;

  worker?: RoleAgentConfig;

  /** Per-project reaction overrides */
  reactions?: Record<string, Partial<ReactionConfig>>;

  /** Inline rules/instructions passed to every agent prompt */
  agentRules?: string;

  /** Path to a file containing agent rules (relative to project path) */
  agentRulesFile?: string;

  /** Rules for the orchestrator agent (stored, reserved for future use) */
  orchestratorRules?: string;

  orchestratorSessionStrategy?:
    | "reuse"
    | "delete"
    | "ignore"
    | "delete-new"
    | "ignore-new"
    | "kill-previous";

  opencodeIssueSessionStrategy?: "reuse" | "delete" | "ignore";
}

export interface TrackerConfig {
  /**
   * Plugin name (manifest.name). Required when using built-in plugins.
   * Optional when `package` or `path` is specified (will be inferred from manifest).
   * When both plugin and package/path are specified, manifest.name must match plugin.
   *
   * POST-VALIDATION INVARIANT: After validateConfig(), this field is ALWAYS populated.
   * Either from user input, inferred from repo (github/gitlab), or auto-generated from
   * package/path via generateTempPluginName(). The optional typing exists for raw config
   * input before validation. Downstream code can safely assume non-null after validation.
   */
  plugin?: string;
  /** npm package name for external plugins (e.g. "@acme/ao-plugin-tracker-jira") */
  package?: string;
  /** Local filesystem path for external plugins (relative to config file or absolute) */
  path?: string;
  /** Plugin-specific config (e.g. teamId for Linear) */
  [key: string]: unknown;
}

export interface SCMConfig {
  /**
   * Plugin name (manifest.name). Required when using built-in plugins.
   * Optional when `package` or `path` is specified (will be inferred from manifest).
   * When both plugin and package/path are specified, manifest.name must match plugin.
   *
   * POST-VALIDATION INVARIANT: After validateConfig(), this field is ALWAYS populated.
   * Either from user input, inferred from repo (github/gitlab), or auto-generated from
   * package/path via generateTempPluginName(). The optional typing exists for raw config
   * input before validation. Downstream code can safely assume non-null after validation.
   */
  plugin?: string;
  /** npm package name for external plugins (e.g. "@acme/ao-plugin-scm-bitbucket") */
  package?: string;
  /** Local filesystem path for external plugins (relative to config file or absolute) */
  path?: string;
  webhook?: SCMWebhookConfig;
  [key: string]: unknown;
}

export interface SCMWebhookConfig {
  enabled?: boolean;
  path?: string;
  secretEnvVar?: string;
  signatureHeader?: string;
  eventHeader?: string;
  deliveryHeader?: string;
  maxBodyBytes?: number;
}

export interface NotifierConfig {
  /**
   * Plugin name (manifest.name). Required when using built-in plugins.
   * Optional when `package` or `path` is specified (will be inferred from manifest).
   * When both plugin and package/path are specified, manifest.name must match plugin.
   *
   * POST-VALIDATION INVARIANT: After validateConfig(), this field is ALWAYS populated.
   * Either from user input or auto-generated from package/path via generateTempPluginName().
   * The optional typing exists for raw config input before validation.
   * Downstream code can safely assume non-null after validation.
   */
  plugin?: string;
  /** npm package name for external plugins (e.g. "@acme/ao-plugin-notifier-teams") */
  package?: string;
  /** Local filesystem path for external plugins (relative to config file or absolute) */
  path?: string;
  [key: string]: unknown;
}

export interface AgentSpecificConfig {
  permissions?: AgentPermissionMode;
  model?: string;
  orchestratorModel?: string;
  [key: string]: unknown;
}

export interface OpenCodeAgentConfig extends AgentSpecificConfig {
  opencodeSessionId?: string;
}

/**
 * Canonical cross-agent permission policy mode.
 *
 * Semantics:
 * - permissionless: run without interactive permission prompts (most permissive mode).
 * - default: use the agent's normal/default permission model.
 * - auto-edit: automatically approve edit actions where the agent supports granular approval policies.
 * - suggest: conservative mode that asks for approval on higher-risk/untrusted actions where supported.
 *
 * Note: Not every agent exposes all granular policies; plugins map these modes to
 * their closest supported behavior.
 */
export type AgentPermissionMode = "permissionless" | "default" | "auto-edit" | "suggest";

/** Backward-compatible legacy alias accepted in config parsing. */
export type LegacyAgentPermissionMode = "skip";

/** Raw permission input (supports legacy aliases). */
export type AgentPermissionInput = AgentPermissionMode | LegacyAgentPermissionMode;

/** Normalize legacy aliases to canonical permission modes. */
export function normalizeAgentPermissionMode(
  mode: string | undefined,
): AgentPermissionMode | undefined {
  if (!mode) return undefined;
  if (
    mode !== "permissionless" &&
    mode !== "default" &&
    mode !== "auto-edit" &&
    mode !== "suggest"
  ) {
    if (mode === "skip") return "permissionless";
    return undefined;
  }
  return mode;
}

// =============================================================================
// PLUGIN SYSTEM
// =============================================================================

/** Plugin slot types */
export type PluginSlot =
  | "runtime"
  | "agent"
  | "workspace"
  | "tracker"
  | "scm"
  | "notifier"
  | "terminal";

/** Plugin manifest — what every plugin exports */
export interface PluginManifest {
  /** Plugin name (e.g. "tmux", "claude-code", "github") */
  name: string;

  /** Which slot this plugin fills */
  slot: PluginSlot;

  /** Human-readable description */
  description: string;

  /** Version */
  version: string;

  /** Human-readable display name (e.g. "Claude Code") */
  displayName?: string;
}

/** What a plugin module must export */
export interface PluginModule<T = unknown> {
  manifest: PluginManifest;
  create(config?: Record<string, unknown>): T;

  /** Optional: detect whether this plugin's runtime/binary is available on the system. */
  detect?(): boolean;
}

/**
 * Context passed to a plugin's `preflight()` method.
 *
 * Describes the **intent** of the operation (what it will do), not the CLI
 * flags that triggered it. Plugins should never know about specific flag
 * names — translate flags into intent at the CLI boundary so adding a new
 * flag doesn't ripple into every plugin that cares about a related operation.
 */
export interface PreflightContext {
  /** The project the operation runs against. */
  project: ProjectConfig;

  /** What the operation will do. Plugins decide whether their prereqs apply. */
  intent: {
    /** Whether the spawn is for a worker session or the orchestrator. */
    role: "worker" | "orchestrator";

    /**
     * Whether the operation will exercise SCM PR-write paths
     * (e.g. claiming an existing PR for the new session). When false, an SCM
     * plugin's preflight can skip PR-write prereqs.
     */
    willClaimExistingPR: boolean;
  };
}

// =============================================================================
// SESSION METADATA
// =============================================================================

/**
 * Session metadata stored as JSON files under projects/{projectId}/sessions/.
 *
 * Session files are named with user-facing session IDs (e.g., "ao-1.json").
 * The tmuxName field matches the session ID (e.g., "ao-1") — no hash prefix.
 */
export interface SessionMetadata {
  worktree: string;
  branch: string;
  status: string;
  lifecycle?: CanonicalSessionLifecycle;
  tmuxName?: string; // Tmux session name (matches session ID, e.g. "ao-1")
  issue?: string;
  issueTitle?: string; // Issue title for event enrichment
  pr?: string;
  prAutoDetect?: boolean;
  summary?: string;
  project?: string;
  agent?: string; // Agent plugin name (e.g. "codex", "claude-code") — persisted for lifecycle
  createdAt?: string;
  runtimeHandle?: RuntimeHandle;
  restoredAt?: string;
  role?: string; // "orchestrator" for orchestrator sessions
  dashboard?: {
    port?: number;
    terminalWsPort?: number;
    directTerminalWsPort?: number;
  };
  opencodeSessionId?: string;
  claudeSessionUuid?: string;
  codexThreadId?: string;
  codexModel?: string;
  restoreFallbackReason?: string;
  pinnedSummary?: string; // First quality summary, pinned for display stability
  userPrompt?: string; // Prompt used when spawning without a tracker issue
  /**
   * Human-readable display name for the session.
   *
   * Populated automatically at spawn time from the best available task context
   * (issue title, user prompt, or orchestrator system prompt). Can be
   * overwritten later via the dashboard rename UI — the session ID (`ao-N`)
   * remains the canonical identifier; only display surfaces are affected.
   *
   * Whether this value should beat PR/issue titles in the dashboard depends
   * on `displayNameUserSet` — auto-derived values stay below live tracker
   * signals, user-set values win over them.
   */
  displayName?: string;
  /**
   * Set to `true` when the user explicitly renamed the session via the
   * dashboard. The dashboard fallback chain promotes `displayName` above
   * PR/issue titles only when this flag is true, so an auto-derived spawn-time
   * `displayName` doesn't shadow a live PR title for sessions the user never
   * touched.
   */
  displayNameUserSet?: boolean;
}

// =============================================================================
// SERVICE INTERFACES (core, not pluggable)
// =============================================================================

/**
 * Why a session was killed. Recorded as the lifecycle reason so observability
 * can distinguish human action from automated teardown (e.g. PR merge cleanup).
 */
export type LifecycleKillReason = "manually_killed" | "pr_merged" | "auto_cleanup";

/**
 * Outcome of a kill() call. `cleaned` means resources were torn down this
 * invocation; `alreadyTerminated` means the session was already archived and
 * kill() was a no-op. Callers can use this to avoid double-notifying.
 */
export interface KillResult {
  cleaned: boolean;
  alreadyTerminated: boolean;
}

export interface KillOptions {
  purgeOpenCode?: boolean;
  reason?: LifecycleKillReason;
}

/** Session manager — CRUD for sessions */
export interface SessionManager {
  spawn(config: SessionSpawnConfig): Promise<Session>;
  spawnOrchestrator(config: OrchestratorSpawnConfig): Promise<Session>;
  ensureOrchestrator(config: OrchestratorSpawnConfig): Promise<Session>;
  restore(sessionId: SessionId): Promise<Session>;
  list(projectId?: string): Promise<Session[]>;
  get(sessionId: SessionId): Promise<Session | null>;
  kill(sessionId: SessionId, options?: KillOptions): Promise<KillResult>;
  cleanup(
    projectId?: string,
    options?: { dryRun?: boolean; purgeOpenCode?: boolean },
  ): Promise<CleanupResult>;
  send(sessionId: SessionId, message: string): Promise<void>;
  claimPR(sessionId: SessionId, prRef: string, options?: ClaimPROptions): Promise<ClaimPRResult>;
}

/** OpenCode-specific session manager with remap capability */
export interface OpenCodeSessionManager extends SessionManager {
  /** Remap session to OpenCode session ID, returns the mapped OpenCode session ID */
  remap(sessionId: SessionId, force?: boolean): Promise<string>;
  listCached(projectId?: string): Promise<Session[]>;
  invalidateCache(): void;
}

export interface ClaimPROptions {
  assignOnGithub?: boolean;
  takeover?: boolean;
}

export interface ClaimPRResult {
  sessionId: SessionId;
  projectId: string;
  pr: PRInfo;
  branchChanged: boolean;
  githubAssigned: boolean;
  githubAssignmentError?: string;
  takenOverFrom: SessionId[];
}

/** Type guard to check if a SessionManager supports OpenCode-specific remap operation */
export function isOpenCodeSessionManager(sm: SessionManager): sm is OpenCodeSessionManager {
  return typeof (sm as OpenCodeSessionManager).remap === "function";
}

export interface CleanupResult {
  killed: string[];
  skipped: string[];
  errors: Array<{ sessionId: string; error: string }>;
}

/** Lifecycle manager — state machine + reaction engine */
export interface LifecycleManager {
  /** Start the lifecycle polling loop */
  start(intervalMs?: number): void;

  /** Stop the lifecycle polling loop */
  stop(): void;

  /** Get current state for all sessions */
  getStates(): Map<SessionId, SessionStatus>;

  /** Force-check a specific session now */
  check(sessionId: SessionId): Promise<void>;
}

/** Plugin registry — discovery + loading */
export interface PluginRegistry {
  /** Register a plugin, optionally with config to pass to create() */
  register(plugin: PluginModule, config?: Record<string, unknown>): void;

  /** Get a plugin by slot and name */
  get<T>(slot: PluginSlot, name: string): T | null;

  /** List plugins for a slot */
  list(slot: PluginSlot): PluginManifest[];

  /** Load built-in plugins, optionally with orchestrator config for plugin settings */
  loadBuiltins(
    config?: OrchestratorConfig,
    importFn?: (pkg: string) => Promise<unknown>,
  ): Promise<void>;

  /** Load plugins from config (npm packages, local paths) */
  loadFromConfig(
    config: OrchestratorConfig,
    importFn?: (pkg: string) => Promise<unknown>,
  ): Promise<void>;
}

// =============================================================================
// ERROR DETECTION HELPERS
// =============================================================================

/**
 * Detect if an error indicates that an issue was not found in the tracker.
 * Used by spawn validation to distinguish "not found" from other errors (auth, network, etc).
 *
 * Uses specific patterns to avoid matching infrastructure errors like "API key not found",
 * "Team not found", "Configuration not found", etc.
 */
export function isIssueNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = (err as Error).message?.toLowerCase() || "";

  // Match issue-specific not-found patterns
  return (
    (message.includes("issue") &&
      (message.includes("not found") || message.includes("does not exist"))) ||
    message.includes("no issue found") ||
    message.includes("could not find issue") ||
    // GitHub: "no issue found" or "could not resolve to an Issue"
    message.includes("could not resolve to an issue") ||
    // Linear: "Issue <id> not found" or "No issue with identifier"
    message.includes("no issue with identifier") ||
    // GitHub: "invalid issue format" (ad-hoc free-text strings)
    message.includes("invalid issue format")
  );
}

/** Thrown when a session cannot be restored (e.g. merged, still working). */
export class SessionNotRestorableError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly reason: string,
  ) {
    super(`Session ${sessionId} cannot be restored: ${reason}`);
    this.name = "SessionNotRestorableError";
  }
}

/** Thrown when a workspace is missing and cannot be recreated. */
export class WorkspaceMissingError extends Error {
  constructor(
    public readonly path: string,
    public readonly detail?: string,
  ) {
    super(`Workspace missing at ${path}${detail ? `: ${detail}` : ""}`);
    this.name = "WorkspaceMissingError";
  }
}

/** Thrown when a session lookup fails (session does not exist). */
export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

/** Thrown when no agent-orchestrator.yaml config file can be found. */
export class ConfigNotFoundError extends Error {
  constructor(message?: string) {
    super(message ?? "No agent-orchestrator.yaml found. Run `ao start` to create one.");
    this.name = "ConfigNotFoundError";
  }
}

/** Thrown when a project cannot be resolved into an effective runtime config. */
export class ProjectResolveError extends Error {
  constructor(
    public readonly projectId: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectResolveError";
  }
}

// =============================================================================
// PORTFOLIO — Cross-project aggregation
// =============================================================================

/** A project entry in the portfolio index (merged from discovery + registration + preferences) */
export interface PortfolioProject {
  id: string;                          // Stable portfolio identity (configProjectKey, with collision suffix if needed)
  name: string;                        // Human-readable display name
  configPath: string;                  // Absolute path to agent-orchestrator.yaml
  configProjectKey: string;            // Key in config.projects map
  repoPath: string;                    // Absolute local filesystem path
  repo?: string;                       // "owner/repo" for SCM
  defaultBranch?: string;
  sessionPrefix: string;
  source: "discovered" | "registered" | "config"; // How this entry was found
  enabled: boolean;                    // User can disable without removing
  pinned: boolean;                     // User preference for ordering
  lastSeenAt: string;                  // ISO timestamp
  resolveError?: string;               // Present only when the project is degraded
}

/** User preferences overlay (canonical, small file) */
export interface PortfolioPreferences {
  version: 1;
  defaultProjectId?: string;
  projectOrder?: string[];             // Ordered project IDs for display
  projects?: Record<string, {          // Per-project preferences
    pinned?: boolean;
    enabled?: boolean;
    displayName?: string;
  }>;
}

/** Registered projects (explicit `ao project add`) */
export interface PortfolioRegistered {
  version: 1;
  projects: Array<{
    path: string;                      // Repo path
    configProjectKey?: string;         // Key in config if multi-project YAML
    addedAt: string;                   // ISO timestamp
  }>;
}

/** Aggregated portfolio session with project context */
export interface PortfolioSession {
  session: Session;
  project: PortfolioProject;
}
