import { attentionZone as presentationAttentionZone } from "../lib/session-presentation";

export type SessionStatus =
	| "working"
	| "pr_open"
	| "draft"
	| "ci_failed"
	| "review_pending"
	| "changes_requested"
	| "approved"
	| "mergeable"
	| "merged"
	| "needs_input"
	| "no_signal"
	| "idle"
	| "terminated"
	| "unknown";

const sessionStatuses = new Set<SessionStatus>([
	"working",
	"pr_open",
	"draft",
	"ci_failed",
	"review_pending",
	"changes_requested",
	"approved",
	"mergeable",
	"merged",
	"needs_input",
	"no_signal",
	"idle",
	"terminated",
]);

export function toSessionStatus(status?: string, isTerminated = false): SessionStatus {
	if (status && sessionStatuses.has(status as SessionStatus)) return status as SessionStatus;
	return isTerminated ? "terminated" : "unknown";
}

export type SessionActivityState = "active" | "idle" | "waiting_input" | "blocked" | "exited" | "unknown";

const sessionActivityStates = new Set<SessionActivityState>(["active", "idle", "waiting_input", "blocked", "exited"]);

export type SessionActivity = {
	state: SessionActivityState;
	lastActivityAt: string;
};

export function toSessionActivity(
	activity?: { state?: string; lastActivityAt?: string } | null,
): SessionActivity | undefined {
	if (!activity) return undefined;
	const state = sessionActivityStates.has(activity.state as SessionActivityState)
		? (activity.state as SessionActivityState)
		: "unknown";
	return {
		state,
		lastActivityAt: activity.lastActivityAt ?? "",
	};
}

export type AgentProvider =
	| "codex"
	| "claude-code"
	| "opencode"
	| "aider"
	| "grok"
	| "droid"
	| "amp"
	| "agy"
	| "crush"
	| "cursor"
	| "qwen"
	| "copilot"
	| "goose"
	| "auggie"
	| "continue"
	| "devin"
	| "cline"
	| "kimi"
	| "kiro"
	| "kilocode"
	| "vibe"
	| "pi"
	| "autohand";

/** A file in a worker's worktree diff (drives the Git review rail). */
export type ChangedFile = {
	path: string;
	additions: number;
	deletions: number;
	staged?: boolean;
};

export type SessionKind = "worker" | "orchestrator";

/** Lifecycle state of a single pull request, mirrors the daemon's enum. */
export type PRState = "open" | "draft" | "merged" | "closed";

/**
 * One attributed pull request, mirroring the daemon's SessionPRFacts wire shape.
 * A session can own many (e.g. a stack), so {@link WorkspaceSession.prs} is a
 * list. The wire carries no source/target branch or parent pointer, so the UI
 * renders a flat list of PRs, not a stack tree.
 */
export type PullRequestFacts = {
	url: string;
	number: number;
	state: PRState;
	ci: string;
	review: string;
	mergeability: string;
	reviewComments: boolean;
	updatedAt: string;
};

export type WorkspaceSession = {
	id: string;
	terminalHandleId?: string;
	workspaceId: string;
	workspaceName: string;
	title: string;
	/** Raw issue/task identifier from the daemon. Intake ids are provider-prefixed. */
	issueId?: string;
	provider: AgentProvider;
	kind?: SessionKind;
	branch: string;
	status: SessionStatus;
	/** ISO timestamp from the daemon — used for relative time in the inspector. */
	createdAt?: string;
	/** ISO timestamp from the daemon. */
	updatedAt: string;
	/** Raw agent lifecycle activity from the daemon. */
	activity?: SessionActivity;
	/**
	 * Live preview target set by the daemon (via `ao preview`) and streamed over
	 * CDC. When non-empty, the browser panel opens and navigates here.
	 */
	previewUrl?: string;
	/**
	 * Monotonic counter the daemon bumps on every `ao preview` call (even when
	 * previewUrl is unchanged), so the browser panel can re-navigate / refresh on
	 * a repeated preview of the same target.
	 */
	previewRevision?: number;
	/** The session's git diff against its base, when known. */
	changedFiles?: ChangedFile[];
	/** Pre-filled commit subject for the Git rail, when known. */
	commitMessage?: string;
	/**
	 * The session's attributed pull requests. One session can own many (a stack
	 * or independent PRs); empty when none are open yet. Status aggregation is
	 * done server-side, so {@link status} already reflects all of these.
	 */
	prs: PullRequestFacts[];
	/**
	 * Display status as derived by the daemon at read time. Optional override; when
	 * absent it is derived from {@link SessionStatus} via {@link workerDisplayStatus}.
	 */
	displayStatus?: WorkerDisplayStatus;
};

// Tracker providers whose ids the intake daemon stamps sessions with, in
// "<provider>:<native>" form. Adding a provider (Linear, Jira, ...) later is
// just another prefix in this list — no caller of canonicalTrackerIssueId
// needs to change.
const TRACKER_PROVIDER_PREFIXES = ["github:"] as const;

/**
 * The provider-prefixed issue id if `issueId` came from tracker intake, or
 * undefined for manually created sessions (whose issueId, if any, is a plain
 * task title with no provider prefix).
 */
export function canonicalTrackerIssueId(issueId?: string): string | undefined {
	if (!issueId) return undefined;
	return TRACKER_PROVIDER_PREFIXES.some((prefix) => issueId.startsWith(prefix)) ? issueId : undefined;
}

export type ProjectKind = "single_repo" | "workspace";

export type WorkspaceRepoSummary = {
	name: string;
	relativePath: string;
	repo: string;
};

/** Glanceable worker status. Maps 1:1 to the accent colors in DESIGN.md. */
export type WorkerDisplayStatus =
	"working" | "needs_you" | "mergeable" | "ci_failed" | "no_signal" | "done" | "unknown";

export function workerDisplayStatus(session: WorkspaceSession): WorkerDisplayStatus {
	if (session.displayStatus) return session.displayStatus;
	switch (session.status) {
		case "needs_input":
		case "changes_requested":
		case "review_pending":
			return "needs_you";
		case "ci_failed":
			return "ci_failed";
		case "no_signal":
			return "no_signal";
		case "approved":
		case "mergeable":
			return "mergeable";
		case "merged":
		case "terminated":
			return "done";
		case "unknown":
			return "unknown";
		default:
			return "working";
	}
}

// Open PRs (actionable) sort above merged/closed; ties break by number.
const prStateRank: Record<PRState, number> = { open: 0, draft: 1, merged: 2, closed: 3 };

/** A session's PRs ordered actionable-first (open, draft, merged, closed). */
export function sortedPRs(session: WorkspaceSession): PullRequestFacts[] {
	return [...session.prs].sort((a, b) => prStateRank[a.state] - prStateRank[b.state] || a.number - b.number);
}

/** PRs still in flight (open or draft). */
export function openPRs(session: WorkspaceSession): PullRequestFacts[] {
	return session.prs.filter((pr) => pr.state === "open" || pr.state === "draft");
}

export function mergedPRCount(session: WorkspaceSession): number {
	return session.prs.filter((pr) => pr.state === "merged").length;
}

/** The highest-priority PR for compact one-line surfaces (board card, sidebar). */
export function primaryPR(session: WorkspaceSession): PullRequestFacts | undefined {
	return sortedPRs(session)[0];
}

export function isOrchestratorSession(session: WorkspaceSession): boolean {
	return session.kind === "orchestrator" || session.id.endsWith("-orchestrator");
}

/**
 * The project's LIVE orchestrator, if any. Terminated orchestrator rows stay in
 * the session list (the daemon returns all sessions, ordered by spawn number),
 * so an earlier dead orchestrator must not shadow a live one — its zellij
 * session is deleted and attaching to it dead-ends in an instant
 * "[process exited]". No live orchestrator → undefined, so the topbar offers
 * Spawn instead of navigating to a dead session.
 */
export function findProjectOrchestrator(
	workspaces: WorkspaceSummary[],
	projectId: string,
): WorkspaceSession | undefined {
	const workspace = workspaces.find((w) => w.id === projectId);
	return newestActiveOrchestrator(workspace?.sessions ?? []);
}

export function newestActiveOrchestrator(sessions: WorkspaceSession[]): WorkspaceSession | undefined {
	const active = sessions.filter((session) => isOrchestratorSession(session) && sessionIsActive(session));
	return active.reduce<WorkspaceSession | undefined>(
		(newest, session) => (!newest || sessionNewer(session, newest) ? session : newest),
		undefined,
	);
}

function sessionNewer(a: WorkspaceSession, b: WorkspaceSession): boolean {
	const aCreated = timestamp(a.createdAt);
	const bCreated = timestamp(b.createdAt);
	if (aCreated !== bCreated) return aCreated > bCreated;
	const aUpdated = timestamp(a.updatedAt);
	const bUpdated = timestamp(b.updatedAt);
	if (aUpdated !== bUpdated) return aUpdated > bUpdated;
	return a.id > b.id;
}

function timestamp(value?: string): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
}

export function workerSessions(sessions: WorkspaceSession[]): WorkspaceSession[] {
	return sessions.filter((s) => !isOrchestratorSession(s));
}

export function sessionIsActive(session: WorkspaceSession): boolean {
	return session.status !== "merged" && session.status !== "terminated";
}

export function sessionNeedsAttention(session: WorkspaceSession): boolean {
	return presentationAttentionZone(session) === "action";
}

export const workerStatusLabel: Record<WorkerDisplayStatus, string> = {
	working: "working",
	needs_you: "needs you",
	mergeable: "mergeable",
	ci_failed: "ci failed",
	no_signal: "no signal",
	done: "done",
	unknown: "unknown",
};

/** Whether a status should breathe (alive/working). */
export function workerStatusPulses(status: WorkerDisplayStatus): boolean {
	return status === "working" || status === "needs_you";
}

export { attentionZone, attentionZoneLabel, attentionZoneOrder } from "../lib/session-presentation";
export type { AttentionZone } from "../lib/session-presentation";

export type WorkspaceSummary = {
	id: string;
	name: string;
	kind?: ProjectKind;
	path: string;
	workspaceRepos?: WorkspaceRepoSummary[];
	type?: "main" | "worktree";
	orchestratorAgent?: AgentProvider;
	accentColor?: string;
	diff?: {
		additions: number;
		deletions: number;
	};
	sessions: WorkspaceSession[];
};

export function orchestratorNeedsRestart(workspace: WorkspaceSummary, orchestrator?: WorkspaceSession): boolean {
	if (!orchestrator || !workspace.orchestratorAgent) return false;
	return orchestrator.provider !== workspace.orchestratorAgent;
}

export type OrchestratorHealth =
	| { state: "ok" }
	| { state: "restarting"; message: string }
	| { state: "restart_needed"; message: string }
	| { state: "missing"; message: string }
	| { state: "duplicates"; message: string };

export function orchestratorHealth(workspace: WorkspaceSummary, restarting = false): OrchestratorHealth {
	if (restarting) {
		return { state: "restarting", message: "Restarting orchestrator. New tasks wait until the replacement is ready." };
	}
	const active = workspace.sessions.filter((session) => isOrchestratorSession(session) && sessionIsActive(session));
	if (active.length > 1) {
		return {
			state: "duplicates",
			message:
				"Multiple orchestrators are active. The newest one is used; stale ones will be cleaned up on daemon reconcile.",
		};
	}
	const orchestrator = newestActiveOrchestrator(workspace.sessions);
	if (!orchestrator) {
		return { state: "missing", message: "No orchestrator is running for this project." };
	}
	if (orchestratorNeedsRestart(workspace, orchestrator)) {
		return {
			state: "restart_needed",
			message: `Configured orchestrator agent is ${workspace.orchestratorAgent}; running agent is ${orchestrator.provider}.`,
		};
	}
	return { state: "ok" };
}

export function toAgentProvider(provider?: string): AgentProvider {
	switch (provider) {
		case "claude-code":
		case "opencode":
		case "aider":
		case "grok":
		case "droid":
		case "amp":
		case "agy":
		case "crush":
		case "cursor":
		case "qwen":
		case "copilot":
		case "goose":
		case "auggie":
		case "continue":
		case "devin":
		case "cline":
		case "kimi":
		case "kiro":
		case "kilocode":
		case "vibe":
		case "pi":
		case "autohand":
			return provider;
		default:
			return "codex";
	}
}
