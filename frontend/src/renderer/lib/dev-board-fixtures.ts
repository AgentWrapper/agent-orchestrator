import type { PRState, PullRequestFacts, WorkspaceSession, WorkspaceSummary } from "../types/workspace";

/**
 * Static board filler for eyeballing lane density and card variants during
 * development. Off unless explicitly asked for, and dropped entirely from
 * production bundles because `import.meta.env.DEV` folds to `false` there.
 *
 * Turn on with `VITE_DEV_BOARD_FIXTURES=1 npm run dev`, or from the renderer
 * devtools with `localStorage.setItem("ao.dev.board-fixtures", "1")` and reload.
 */
export const usesDevBoardFixtures =
	import.meta.env.DEV &&
	(import.meta.env.VITE_DEV_BOARD_FIXTURES === "1" ||
		(typeof localStorage !== "undefined" && localStorage.getItem("ao.dev.board-fixtures") === "1"));

const FIXTURE_ID_MARKER = ":fx-";

/** Fixture sessions have no daemon record, so PR lookups for them would only 404. */
export function isDevBoardFixtureSession(sessionId?: string): boolean {
	return usesDevBoardFixtures && sessionId !== undefined && sessionId.includes(FIXTURE_ID_MARKER);
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const hoursAgo = (hours: number) => minutesAgo(hours * 60);

const pr = (
	number: number,
	state: PRState = "open",
	ci: string = "passing",
	review: string = "none",
	mergeability: string = "mergeable",
): PullRequestFacts => ({
	url: `https://github.com/acme-inc/fixtures/pull/${number}`,
	number,
	state,
	ci,
	review,
	mergeability,
	reviewComments: review === "changes_requested",
	updatedAt: minutesAgo(number % 90),
});

type FixtureSession = Omit<WorkspaceSession, "workspaceId" | "workspaceName">;

// Working lane — active agents on top, idle ones in the lower section.
const workingFixtures: FixtureSession[] = [
	{
		id: "fx-working-1",
		title: "Rework the session inspector rail into a resizable split",
		provider: "claude-code",
		branch: "feat/inspector-resizable-split",
		status: "working",
		createdAt: hoursAgo(3),
		updatedAt: minutesAgo(1),
		activity: { state: "active", lastActivityAt: minutesAgo(1) },
		prs: [],
	},
	{
		id: "fx-working-2",
		title: "Backfill tracker intake ids for sessions created before the migration",
		issueId: "github:AO-2184",
		provider: "codex",
		branch: "chore/backfill-intake-ids",
		status: "working",
		createdAt: hoursAgo(5),
		updatedAt: minutesAgo(4),
		activity: { state: "active", lastActivityAt: minutesAgo(4) },
		prs: [pr(401, "draft", "pending", "none", "unknown")],
	},
	{
		id: "fx-working-3",
		title: "Cache PR check runs",
		provider: "cursor",
		branch: "perf/cache-check-runs",
		status: "working",
		createdAt: hoursAgo(2),
		updatedAt: minutesAgo(9),
		activity: { state: "active", lastActivityAt: minutesAgo(9) },
		prs: [],
	},
	{
		id: "fx-working-4",
		title: "Teach the reaper to skip worktrees with uncommitted changes",
		provider: "opencode",
		branch: "fix/reaper-dirty-worktrees",
		status: "working",
		createdAt: hoursAgo(8),
		updatedAt: minutesAgo(12),
		activity: { state: "active", lastActivityAt: minutesAgo(12) },
		prs: [],
	},
	{
		id: "fx-idle-1",
		title: "Draft the LAN listener runbook",
		provider: "aider",
		branch: "docs/lan-listener-runbook",
		status: "idle",
		createdAt: hoursAgo(11),
		updatedAt: minutesAgo(38),
		activity: { state: "idle", lastActivityAt: minutesAgo(38) },
		prs: [],
	},
	{
		id: "fx-idle-2",
		title: "Split the tmux adapter tests by capability probe",
		provider: "grok",
		branch: "test/tmux-capability-probes",
		status: "idle",
		createdAt: hoursAgo(14),
		updatedAt: hoursAgo(2),
		activity: { state: "idle", lastActivityAt: hoursAgo(2) },
		prs: [],
	},
];

// Needs you — everything that stalls without a human.
const actionFixtures: FixtureSession[] = [
	{
		id: "fx-action-1",
		title: "Pick a conflict resolution for the settings migration",
		provider: "claude-code",
		branch: "feat/settings-modal-migration",
		status: "needs_input",
		createdAt: hoursAgo(4),
		updatedAt: minutesAgo(6),
		activity: { state: "waiting_input", lastActivityAt: minutesAgo(6) },
		prs: [],
	},
	{
		id: "fx-action-2",
		title: "CI is red on the change-log trigger rewrite",
		issueId: "github:AO-2190",
		provider: "codex",
		branch: "fix/change-log-triggers",
		status: "ci_failed",
		createdAt: hoursAgo(7),
		updatedAt: minutesAgo(21),
		activity: { state: "idle", lastActivityAt: minutesAgo(21) },
		prs: [pr(388, "open", "failing", "none", "blocked")],
	},
	{
		id: "fx-action-3",
		title: "Reviewer wants the daemon shutdown path covered",
		provider: "copilot",
		branch: "feat/graceful-shutdown",
		status: "changes_requested",
		createdAt: hoursAgo(9),
		updatedAt: minutesAgo(33),
		activity: { state: "blocked", lastActivityAt: minutesAgo(33) },
		prs: [pr(390, "open", "passing", "changes_requested", "blocked")],
	},
	{
		id: "fx-action-4",
		title: "Agent exited before committing the worktree",
		provider: "droid",
		branch: "spike/worktree-gc",
		status: "exited",
		createdAt: hoursAgo(12),
		updatedAt: hoursAgo(1),
		activity: { state: "exited", lastActivityAt: hoursAgo(1) },
		prs: [],
	},
	{
		id: "fx-action-5",
		title: "No signal from the runtime probe",
		provider: "amp",
		branch: "chore/runtime-probe-timeouts",
		status: "no_signal",
		createdAt: hoursAgo(20),
		updatedAt: hoursAgo(4),
		activity: { state: "unknown", lastActivityAt: hoursAgo(4) },
		prs: [],
	},
];

// In review — open PRs waiting on someone else, including a stack.
const pendingFixtures: FixtureSession[] = [
	{
		id: "fx-review-1",
		title: "Stack the board column header refactor on the token rename",
		provider: "cursor",
		branch: "refactor/board-column-header",
		status: "review_pending",
		createdAt: hoursAgo(6),
		updatedAt: minutesAgo(14),
		activity: { state: "idle", lastActivityAt: minutesAgo(14) },
		prs: [pr(370), pr(371, "open", "pending", "none", "unknown"), pr(372, "draft", "pending", "none", "unknown")],
	},
	{
		id: "fx-review-2",
		title: "Publish the desktop release verification script",
		provider: "claude-code",
		branch: "release/verify-mac-artifact",
		status: "pr_open",
		createdAt: hoursAgo(10),
		updatedAt: minutesAgo(27),
		activity: { state: "idle", lastActivityAt: minutesAgo(27) },
		prs: [pr(374)],
	},
	{
		id: "fx-review-3",
		title: "Draft: sqlc regeneration for the session activity view",
		provider: "codex",
		branch: "chore/sqlc-session-activity",
		status: "draft",
		createdAt: hoursAgo(13),
		updatedAt: hoursAgo(3),
		activity: { state: "idle", lastActivityAt: hoursAgo(3) },
		prs: [pr(376, "draft", "pending", "none", "unknown")],
	},
	{
		id: "fx-review-4",
		title: "Trim the onboarding flow to a single screen",
		issueId: "github:AO-2201",
		provider: "goose",
		branch: "feat/onboarding-single-screen",
		status: "review_pending",
		createdAt: hoursAgo(16),
		updatedAt: hoursAgo(5),
		activity: { state: "idle", lastActivityAt: hoursAgo(5) },
		prs: [pr(378, "open", "passing", "none", "unstable")],
	},
];

// Ready to merge — approved/mergeable on top, already-merged underneath.
const mergeFixtures: FixtureSession[] = [
	{
		id: "fx-merge-1",
		title: "Pin Electron userData under the app data dir",
		provider: "claude-code",
		branch: "fix/electron-userdata-path",
		status: "mergeable",
		createdAt: hoursAgo(9),
		updatedAt: minutesAgo(8),
		activity: { state: "idle", lastActivityAt: minutesAgo(8) },
		prs: [pr(360, "open", "passing", "approved")],
	},
	{
		id: "fx-merge-2",
		title: "Approve the notification center keyboard map",
		provider: "opencode",
		branch: "feat/notification-keymap",
		status: "approved",
		createdAt: hoursAgo(15),
		updatedAt: minutesAgo(44),
		activity: { state: "idle", lastActivityAt: minutesAgo(44) },
		prs: [pr(362, "open", "passing", "approved")],
	},
	{
		id: "fx-merge-3",
		title: "Land the archive row layout toggle",
		provider: "qwen",
		branch: "feat/archive-row-toggle",
		status: "merged",
		createdAt: hoursAgo(28),
		updatedAt: hoursAgo(6),
		activity: { state: "idle", lastActivityAt: hoursAgo(6) },
		prs: [pr(351, "merged")],
	},
	{
		id: "fx-merge-4",
		title: "Ship the tmux colour probe fix",
		issueId: "github:AO-2166",
		provider: "kimi",
		branch: "fix/tmux-colour-probe",
		status: "merged",
		createdAt: hoursAgo(34),
		updatedAt: hoursAgo(9),
		activity: { state: "idle", lastActivityAt: hoursAgo(9) },
		prs: [pr(344, "merged")],
	},
];

const fixtures = [...workingFixtures, ...actionFixtures, ...pendingFixtures, ...mergeFixtures];

/** Appends the fixture sessions to every project so any board shows them. */
export function withDevBoardFixtures(workspaces: WorkspaceSummary[]): WorkspaceSummary[] {
	if (!usesDevBoardFixtures) return workspaces;
	return workspaces.map((workspace) => ({
		...workspace,
		sessions: [
			...workspace.sessions,
			...fixtures.map((fixture) => ({
				...fixture,
				id: `${workspace.id}:${fixture.id}`,
				kind: "worker" as const,
				workspaceId: workspace.id,
				workspaceName: workspace.name,
			})),
		],
	}));
}
