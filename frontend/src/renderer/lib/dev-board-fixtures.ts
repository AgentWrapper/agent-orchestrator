import type { AgentProvider, PRState, PullRequestFacts, WorkspaceSession, WorkspaceSummary } from "../types/workspace";

/**
 * Static board filler for eyeballing lane density and card variants during
 * development. Off unless explicitly asked for, and dropped entirely from
 * production bundles because `import.meta.env.DEV` folds to `false` there.
 *
 * Turn on with `VITE_DEV_BOARD_FIXTURES=1 npm run dev`, or from the renderer
 * devtools with `localStorage.setItem("ao.dev.board-fixtures", "1")` and reload.
 *
 * When on, fixture sessions are randomized on every fetch. Dev Settings (the
 * "Dev Settings" section under Developer settings in the Settings dialog)
 * control the number of fixtures per zone and how far back they spread.
 */
export const usesDevBoardFixtures =
	import.meta.env.DEV &&
	(import.meta.env.VITE_DEV_BOARD_FIXTURES === "1" ||
		(typeof localStorage !== "undefined" && localStorage.getItem("ao.dev.board-fixtures") === "1"));

const FIXTURE_ID_MARKER = ":fx-";
const DEV_SETTINGS_KEY = "ao.devSettings";
const DEFAULT_FIXTURE_COUNT = 8;
const DEFAULT_SPREAD_MINUTES = 120;

/** Fixture sessions have no daemon record, so PR lookups for them would only 404. */
export function isDevBoardFixtureSession(sessionId?: string): boolean {
	return usesDevBoardFixtures && sessionId !== undefined && sessionId.includes(FIXTURE_ID_MARKER);
}

function readFixtureCount(): number {
	try {
		if (typeof localStorage === "undefined") return DEFAULT_FIXTURE_COUNT;
		const raw = localStorage.getItem(DEV_SETTINGS_KEY);
		if (!raw) return DEFAULT_FIXTURE_COUNT;
		const parsed = JSON.parse(raw) as { fixtureCount?: number };
		return typeof parsed.fixtureCount === "number" ? parsed.fixtureCount : DEFAULT_FIXTURE_COUNT;
	} catch {
		return DEFAULT_FIXTURE_COUNT;
	}
}

function readSpreadMinutes(): number {
	try {
		if (typeof localStorage === "undefined") return DEFAULT_SPREAD_MINUTES;
		const raw = localStorage.getItem(DEV_SETTINGS_KEY);
		if (!raw) return DEFAULT_SPREAD_MINUTES;
		const parsed = JSON.parse(raw) as { randomSpreadMinutes?: number };
		return typeof parsed.randomSpreadMinutes === "number" ? parsed.randomSpreadMinutes : DEFAULT_SPREAD_MINUTES;
	} catch {
		return DEFAULT_SPREAD_MINUTES;
	}
}

const minutesAgo = (minutes: number) => {
	const date = new Date(Date.now() - minutes * 60_000);
	return date.toISOString();
};

function randomInt(min: number, max: number) {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: readonly T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

const TASK_TITLES = [
	"Refactor session lifecycle state machine edge cases",
	"Add SSE retry with exponential backoff for terminal mux",
	"Migrate workspace file listing to paginated endpoint",
	"Draft onboarding runbook for new team members",
	"Fix race between cleanup and restore on SIGTERM",
	"Wire up the CI status badge on session cards",
	"Optimize the change-log trigger batch writes",
	"Add keyboard shortcut for toggling inspector panel",
	"Replace raw SQLite with sqlc-generated queries in session store",
	"Implement dark mode for the settings dialog",
	"Audit all toast timings and accessibility labels",
	"Add project-level agent fallback chain config",
	"Fix file watcher leaks on worktree removal",
	"Pin Go toolchain version in flake.nix for reproducible builds",
	"Reconcile session status derivations between daemon and UI",
	"Add a hover card with PR CI check summaries",
	"Ship the notification badge for unseen activity",
	"Backfill session display names from git branch names",
	"Experiment with streaming diffs over SSE instead of polling",
	"Lock the review comment textarea width during resize",
	"Add a workspace reopen button after daemon restart",
	"Draft the contribution guide with local setup steps",
	"Merge the three terminal color parsers into one",
];

const PROVIDERS: readonly AgentProvider[] = [
	"claude-code", "codex", "opencode", "cursor", "copilot",
	"droid", "amp", "agy", "crush", "qwen", "goose", "auggie",
	"continue", "devin", "cline", "kimi", "kiro", "kilocode",
	"vibe", "pi", "autohand", "fake",
];

const BRANCH_PREFIXES = [
	"feat/", "fix/", "chore/", "refactor/", "docs/", "test/",
	"perf/", "spike/", "release/",
];

const SCOPES = ["ui", "api", "storage", "runtime", "review", "auth", "onboard", "polish", "cleanup", "perf"];

function randomBranch(): string {
	const prefix = pick(BRANCH_PREFIXES);
	const slug = `task-${randomInt(100, 9999)}-${pick(SCOPES)}`;
	return `${prefix}${slug}`;
}

function randomPr(number: number, state?: PRState): PullRequestFacts {
	const prState = state ?? pick<PRState>(["open", "open", "open", "draft", "merged", "closed"]);
	const ci = pick(["passing", "passing", "passing", "passing", "failing", "pending", "unknown"]);
	const review = pick(["none", "none", "none", "approved", "changes_requested", "none"]);
	const mergeability = pick(["mergeable", "mergeable", "mergeable", "blocked", "unstable", "unknown"]);
	return {
		url: `https://github.com/acme-inc/fixtures/pull/${number}`,
		number,
		state: prState,
		ci,
		review,
		mergeability,
		reviewComments: review === "changes_requested",
		updatedAt: minutesAgo(randomInt(1, 480)),
	};
}

type FixtureSession = Omit<WorkspaceSession, "workspaceId" | "workspaceName">;

const ZONE_STATUSES: Record<string, {
	statuses: Array<FixtureSession["status"]>;
	activities: Array<NonNullable<FixtureSession["activity"]>>;
}> = {
	working: {
		statuses: ["working", "idle"],
		activities: [
			{ state: "active", lastActivityAt: "" },
			{ state: "idle", lastActivityAt: "" },
		],
	},
	action: {
		statuses: ["needs_input", "ci_failed", "changes_requested", "exited", "no_signal"],
		activities: [
			{ state: "waiting_input", lastActivityAt: "" },
			{ state: "blocked", lastActivityAt: "" },
			{ state: "exited", lastActivityAt: "" },
			{ state: "idle", lastActivityAt: "" },
		],
	},
	pending: {
		statuses: ["review_pending", "pr_open", "draft"],
		activities: [
			{ state: "idle", lastActivityAt: "" },
		],
	},
	merge: {
		statuses: ["mergeable", "approved", "merged"],
		activities: [
			{ state: "idle", lastActivityAt: "" },
		],
	},
};

function generateFixture(index: number, zone: string): FixtureSession {
	const zoneCfg = ZONE_STATUSES[zone];
	const spread = readSpreadMinutes();
	const status = pick(zoneCfg.statuses);
	const activityTemplate = pick(zoneCfg.activities);
	const activity = {
		state: activityTemplate.state,
		lastActivityAt: minutesAgo(randomInt(1, spread)),
	};

	const taskTitle = pick(TASK_TITLES);
	const hasPR =
		["pending", "merge"].includes(zone) ||
		(zone === "action" && ["ci_failed", "changes_requested"].includes(status));

	let prState: PRState | undefined;
	if (status === "merged") prState = "merged";
	else if (status === "draft") prState = "draft";
	else if (hasPR) prState = "open";

	return {
		id: `fx-${zone}-${index}`,
		title: taskTitle,
		provider: pick(PROVIDERS),
		branch: randomBranch(),
		status,
		createdAt: minutesAgo(randomInt(spread, spread * 2)),
		updatedAt: activity.lastActivityAt,
		activity,
		prs: hasPR ? [randomPr(randomInt(300, 499), prState)] : [],
	};
}

function generateAllFixtures(): FixtureSession[] {
	const count = readFixtureCount();
	if (count === 0) return [];
	const fixtures: FixtureSession[] = [];
	const zones = ["working", "action", "pending", "merge"];
	for (const zone of zones) {
		for (let i = 1; i <= count; i++) {
			fixtures.push(generateFixture(i, zone));
		}
	}
	return fixtures;
}

/** Appends fixture sessions to every project so any board shows them. Fixtures are regenerated on every call (randomized). */
export function withDevBoardFixtures(workspaces: WorkspaceSummary[]): WorkspaceSummary[] {
	if (!usesDevBoardFixtures) return workspaces;
	const fixtures = generateAllFixtures();
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
