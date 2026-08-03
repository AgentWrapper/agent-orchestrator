import type {
	AgentProvider,
	PRState,
	PullRequestFacts,
	SessionStatus,
	WorkspaceSession,
	WorkspaceSummary,
} from "../types/workspace";
import type { SessionPRSummary } from "../hooks/useSessionScmSummary";
import type { ShellTerminal } from "../hooks/useShellTerminals";

const now = new Date().toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

const demoPr = (
	number: number,
	state: PRState,
	ci: PullRequestFacts["ci"] = "passing",
	review: PullRequestFacts["review"] = "none",
	mergeability: PullRequestFacts["mergeability"] = "mergeable",
): PullRequestFacts => ({
	url: `https://github.com/acme-inc/ao-demo/pull/${number}`,
	number,
	state,
	ci,
	review,
	mergeability,
	reviewComments: review === "changes_requested",
	updatedAt: now,
});

// Standalone shell terminals for the browser-preview build. The real ones need
// a daemon to spawn a PTY, so the preview shows representative tabs instead —
// enough to exercise the tab strip's layout, selection, and close control.
export const mockShellTerminals: ShellTerminal[] = [
	{
		handleId: "shellterm-demo-1",
		projectId: "ao-demo",
		workingDir: "/Users/demo/Projects/ao-demo",
		title: "ao-demo",
		createdAt: now,
	},
];

/**
 * One session per harness AO hasn't already placed in `ao-demo` / `docs-site`,
 * spread across every status so the browser preview shows the whole board at
 * once: both halves of each split column, and the archive.
 *
 * `agy`, `auggie` and `autohand` ship no brand mark, so they also stand in for
 * the lettered fallback. The `fake` harness is deliberately absent — it is a
 * test double, not something a user picks.
 */
const galleryRow = (
	provider: AgentProvider,
	title: string,
	branch: string,
	status: SessionStatus,
	minutes: number,
	prs: PullRequestFacts[] = [],
	terminated = false,
): WorkspaceSession => ({
	id: `gallery-${provider}`,
	terminalHandleId: `gallery-${provider}/terminal_0`,
	workspaceId: "agent-gallery",
	workspaceName: "agent-gallery",
	title,
	provider,
	branch,
	status,
	...(terminated ? { isTerminated: true } : {}),
	createdAt: hoursAgo(Math.max(1, Math.round(minutes / 60) + 2)),
	updatedAt: minutesAgo(minutes),
	activity: {
		state: status === "working" ? "active" : status === "needs_input" ? "waiting_input" : "idle",
		lastActivityAt: minutesAgo(minutes),
	},
	prs,
});

const agentGalleryWorkspace: WorkspaceSummary = {
	id: "agent-gallery",
	name: "agent-gallery",
	path: "/demo/agent-gallery",
	type: "main",
	orchestratorAgent: "claude-code",
	accentColor: "var(--color-project-accent-violet)",
	sessions: [
		// Working column — the idle half, then the active half.
		galleryRow("kimi", "Profile the board render path", "gallery/board-render-profile", "idle", 64),
		galleryRow("droid", "Extract the diff gutter component", "gallery/diff-gutter", "idle", 88),
		galleryRow("devin", "Backfill session lifecycle tests", "gallery/lifecycle-tests", "working", 3),
		galleryRow("crush", "Tune the worktree prune schedule", "gallery/worktree-prune", "working", 9),
		// Needs you — every reason the lane collapses together.
		galleryRow("pi", "Confirm the destructive reset copy", "gallery/reset-copy", "needs_input", 12),
		galleryRow("cline", "Port the settings form to shadcn", "gallery/settings-shadcn", "exited", 41),
		galleryRow("kilocode", "Trace the dropped CDC frames", "gallery/cdc-frames", "no_signal", 73),
		galleryRow("qwen", "Fix the flaky preview poller test", "gallery/preview-poller", "ci_failed", 27, [
			demoPr(501, "open", "failing", "none"),
		]),
		galleryRow("goose", "Rework the archive empty state", "gallery/archive-empty", "changes_requested", 35, [
			demoPr(502, "open", "passing", "changes_requested"),
		]),
		// In review.
		galleryRow("vibe", "Add keyboard nav to the board", "gallery/board-keyboard-nav", "review_pending", 18, [
			demoPr(503, "open", "passing", "none"),
		]),
		galleryRow("continue", "Split the telemetry reservoir", "gallery/telemetry-reservoir", "draft", 55, [
			demoPr(504, "draft", "pending", "none", "unknown"),
		]),
		galleryRow("kiro", "Cache the agent mark lookups", "gallery/mark-lookup-cache", "pr_open", 8, [
			demoPr(505, "open", "pending", "none", "unknown"),
		]),
		// Ready to merge, then merged.
		galleryRow("agy", "Document the harness registry", "gallery/harness-registry-docs", "mergeable", 6, [
			demoPr(506, "open", "passing", "approved"),
		]),
		galleryRow("auggie", "Align the sidebar project rows", "gallery/sidebar-rows", "approved", 21, [
			demoPr(507, "open", "passing", "approved"),
		]),
		galleryRow("autohand", "Retire the legacy status pill", "gallery/legacy-status-pill", "merged", 96, [
			demoPr(508, "merged", "passing", "approved"),
		]),
		// Archive.
		galleryRow(
			"amp",
			"Spike: virtualise the board columns",
			"gallery/virtualise-columns",
			"terminated",
			150,
			[],
			true,
		),
	],
};

export const mockWorkspaces: WorkspaceSummary[] = [
	{
		id: "ao-demo",
		name: "ao-demo",
		path: "/demo/ao-demo",
		type: "main",
		orchestratorAgent: "codex",
		accentColor: "var(--color-project-accent-mint)",
		sessions: [
			{
				id: "ao-demo-orchestrator",
				terminalHandleId: "ao-demo-orchestrator/terminal_0",
				workspaceId: "ao-demo",
				workspaceName: "ao-demo",
				title: "Project orchestrator",
				provider: "codex",
				kind: "orchestrator",
				branch: "main",
				status: "working",
				createdAt: hoursAgo(6),
				updatedAt: minutesAgo(3),
				activity: { state: "active", lastActivityAt: minutesAgo(3) },
				prs: [],
			},
			{
				id: "demo-working",
				terminalHandleId: "demo-working/terminal_0",
				workspaceId: "ao-demo",
				workspaceName: "ao-demo",
				title: "Build screenshot-ready dashboard data",
				provider: "cursor",
				branch: "demo/dashboard-screenshot",
				status: "working",
				createdAt: hoursAgo(3),
				updatedAt: minutesAgo(2),
				activity: { state: "active", lastActivityAt: minutesAgo(2) },
				changedFiles: [
					{ path: "frontend/src/renderer/lib/mock-data.ts", additions: 156, deletions: 22 },
					{ path: "docs/readme.md", additions: 18, deletions: 4 },
				],
				commitMessage: "prepare readme screenshot data",
				prs: [],
			},
			{
				id: "demo-needs-input",
				terminalHandleId: "demo-needs-input/terminal_0",
				workspaceId: "ao-demo",
				workspaceName: "ao-demo",
				title: "Resolve reviewer feedback on terminal polish",
				provider: "claude-code",
				branch: "demo/terminal-polish",
				status: "changes_requested",
				createdAt: hoursAgo(5),
				updatedAt: minutesAgo(18),
				activity: { state: "waiting_input", lastActivityAt: minutesAgo(18) },
				changedFiles: [
					{ path: "frontend/src/renderer/components/TerminalPane.tsx", additions: 41, deletions: 9 },
					{ path: "frontend/src/renderer/styles.css", additions: 27, deletions: 3 },
				],
				commitMessage: "polish terminal screenshots",
				prs: [demoPr(318, "open", "passing", "changes_requested")],
			},
			{
				id: "demo-review-stack",
				terminalHandleId: "demo-review-stack/terminal_0",
				workspaceId: "ao-demo",
				workspaceName: "ao-demo",
				title: "Review stacked browser preview flow",
				provider: "copilot",
				branch: "demo/browser-preview-stack",
				status: "review_pending",
				createdAt: hoursAgo(7),
				updatedAt: minutesAgo(7),
				activity: { state: "idle", lastActivityAt: minutesAgo(7) },
				previewUrl: "http://localhost:5173",
				previewRevision: 4,
				changedFiles: [
					{ path: "frontend/src/renderer/components/BrowserPanel.tsx", additions: 52, deletions: 11 },
					{ path: "frontend/src/renderer/hooks/useBrowserView.ts", additions: 33, deletions: 6 },
					{ path: "docs/assets/readme/browser-preview.png", additions: 1, deletions: 0 },
				],
				commitMessage: "wire readme browser preview",
				prs: [
					demoPr(319, "open", "passing", "none"),
					demoPr(320, "open", "pending", "none", "unknown"),
					demoPr(321, "draft", "pending", "none", "unknown"),
				],
			},
			{
				id: "demo-in-review",
				terminalHandleId: "demo-in-review/terminal_0",
				workspaceId: "ao-demo",
				workspaceName: "ao-demo",
				title: "Wait for CI on project settings copy",
				provider: "opencode",
				branch: "demo/project-settings-copy",
				status: "review_pending",
				createdAt: hoursAgo(4),
				updatedAt: minutesAgo(31),
				activity: { state: "idle", lastActivityAt: minutesAgo(31) },
				prs: [demoPr(322, "open", "pending", "none", "unknown")],
			},
			{
				id: "demo-ready",
				terminalHandleId: "demo-ready/terminal_0",
				workspaceId: "ao-demo",
				workspaceName: "ao-demo",
				title: "Merge README screenshot asset update",
				provider: "aider",
				branch: "demo/readme-assets",
				status: "mergeable",
				createdAt: hoursAgo(9),
				updatedAt: minutesAgo(5),
				activity: { state: "idle", lastActivityAt: minutesAgo(5) },
				changedFiles: [
					{ path: "docs/assets/readme/dashboard.png", additions: 1, deletions: 0 },
					{ path: "docs/assets/readme/session-terminal.png", additions: 1, deletions: 0 },
				],
				prs: [demoPr(323, "open", "passing", "approved")],
			},
			{
				id: "demo-ci-failed",
				terminalHandleId: "demo-ci-failed/terminal_0",
				workspaceId: "ao-demo",
				workspaceName: "ao-demo",
				title: "Fix flaky NewTaskDialog smoke test",
				provider: "grok",
				branch: "demo/new-task-flake",
				status: "ci_failed",
				createdAt: hoursAgo(8),
				updatedAt: minutesAgo(46),
				activity: { state: "idle", lastActivityAt: minutesAgo(46) },
				prs: [demoPr(324, "open", "failing", "none")],
			},
			{
				id: "demo-idle",
				terminalHandleId: "demo-idle/terminal_0",
				workspaceId: "ao-demo",
				workspaceName: "ao-demo",
				title: "Audit board empty states",
				provider: "amp",
				branch: "demo/board-empty-states",
				status: "idle",
				createdAt: hoursAgo(4),
				updatedAt: minutesAgo(52),
				activity: { state: "idle", lastActivityAt: minutesAgo(52) },
				prs: [],
			},
			{
				id: "demo-unknown",
				terminalHandleId: "demo-unknown/terminal_0",
				workspaceId: "ao-demo",
				workspaceName: "ao-demo",
				title: "Reconcile a session the daemon lost track of",
				provider: "copilot",
				branch: "demo/orphaned-session",
				status: "unknown",
				createdAt: hoursAgo(11),
				updatedAt: hoursAgo(2),
				activity: { state: "unknown", lastActivityAt: hoursAgo(2) },
				prs: [],
			},
			{
				id: "demo-merged",
				terminalHandleId: "demo-merged/terminal_0",
				workspaceId: "ao-demo",
				workspaceName: "ao-demo",
				title: "Ship the agent mark registry",
				provider: "codex",
				branch: "demo/agent-mark-registry",
				status: "merged",
				createdAt: hoursAgo(14),
				updatedAt: hoursAgo(1),
				activity: { state: "exited", lastActivityAt: hoursAgo(1) },
				prs: [demoPr(325, "merged", "passing", "approved")],
			},
			{
				id: "demo-archived-merged",
				terminalHandleId: "demo-archived-merged/terminal_0",
				workspaceId: "ao-demo",
				workspaceName: "ao-demo",
				title: "Drop the per-card status pill",
				provider: "cursor",
				branch: "demo/card-status-pill",
				status: "merged",
				isTerminated: true,
				createdAt: hoursAgo(20),
				updatedAt: hoursAgo(3),
				activity: { state: "exited", lastActivityAt: hoursAgo(3) },
				prs: [demoPr(326, "merged", "passing", "approved")],
			},
			{
				id: "demo-archived-abandoned",
				terminalHandleId: "demo-archived-abandoned/terminal_0",
				workspaceId: "ao-demo",
				workspaceName: "ao-demo",
				title: "Spike: inline diff in the board card",
				provider: "opencode",
				branch: "demo/inline-diff-spike",
				status: "terminated",
				isTerminated: true,
				createdAt: hoursAgo(30),
				updatedAt: hoursAgo(6),
				activity: { state: "exited", lastActivityAt: hoursAgo(6) },
				prs: [],
			},
		],
	},
	{
		id: "docs-site",
		name: "docs-site",
		path: "/demo/docs-site",
		type: "main",
		orchestratorAgent: "claude-code",
		accentColor: "var(--color-project-accent-sky)",
		sessions: [
			{
				id: "docs-installation",
				terminalHandleId: "docs-installation/terminal_0",
				workspaceId: "docs-site",
				workspaceName: "docs-site",
				title: "Tighten installation guide",
				provider: "claude-code",
				branch: "demo/install-docs",
				status: "working",
				createdAt: hoursAgo(2),
				updatedAt: minutesAgo(13),
				activity: { state: "active", lastActivityAt: minutesAgo(13) },
				prs: [],
			},
			{
				id: "docs-ready",
				terminalHandleId: "docs-ready/terminal_0",
				workspaceId: "docs-site",
				workspaceName: "docs-site",
				title: "Publish troubleshooting section",
				provider: "codex",
				branch: "demo/troubleshooting",
				status: "approved",
				createdAt: hoursAgo(12),
				updatedAt: minutesAgo(22),
				activity: { state: "idle", lastActivityAt: minutesAgo(22) },
				prs: [demoPr(411, "open", "passing", "approved")],
			},
			{
				id: "docs-archived",
				terminalHandleId: "docs-archived/terminal_0",
				workspaceId: "docs-site",
				workspaceName: "docs-site",
				title: "Rewrite the CLI reference intro",
				provider: "claude-code",
				branch: "demo/cli-reference-intro",
				status: "terminated",
				isTerminated: true,
				createdAt: hoursAgo(26),
				updatedAt: hoursAgo(9),
				activity: { state: "exited", lastActivityAt: hoursAgo(9) },
				prs: [demoPr(412, "closed", "passing", "none")],
			},
		],
	},
	agentGalleryWorkspace,
];

const prSummary = (sessionId: string, number: number, overrides: Partial<SessionPRSummary> = {}): SessionPRSummary => {
	const session = mockWorkspaces.flatMap((workspace) => workspace.sessions).find((item) => item.id === sessionId);
	const facts = session?.prs.find((item) => item.number === number);
	const url = facts?.url ?? `https://github.com/me/${session?.workspaceName ?? "preview"}/pull/${number}`;
	return {
		url,
		htmlUrl: url,
		number,
		title: session?.title ?? `PR #${number}`,
		state: facts?.state ?? "open",
		provider: "github",
		repo: `me/${session?.workspaceName ?? "preview"}`,
		author: "preview-agent",
		sourceBranch: session?.branch ?? "",
		targetBranch: "main",
		headSha: `preview-${number}`,
		additions: 42,
		deletions: 8,
		changedFiles: 3,
		ci: {
			state: facts?.ci === "failing" ? "failing" : facts?.ci === "pending" ? "pending" : "passing",
			failingChecks: [],
		},
		review: {
			decision:
				facts?.review === "changes_requested"
					? "changes_requested"
					: facts?.review === "approved"
						? "approved"
						: "none",
			hasUnresolvedHumanComments: facts?.reviewComments ?? false,
			unresolvedBy: [],
		},
		mergeability: {
			state:
				facts?.mergeability === "conflicting"
					? "conflicting"
					: facts?.mergeability === "blocked"
						? "blocked"
						: facts?.mergeability === "unstable"
							? "unstable"
							: facts?.mergeability === "unknown"
								? "unknown"
								: "mergeable",
			reasons: [],
			prUrl: url,
			conflictFiles: [],
		},
		createdAt: facts?.updatedAt ?? now,
		stateChangedAt: facts?.updatedAt ?? now,
		updatedAt: facts?.updatedAt ?? now,
		observedAt: facts?.updatedAt ?? now,
		ciObservedAt: facts?.updatedAt ?? now,
		reviewObservedAt: facts?.updatedAt ?? now,
		...overrides,
	};
};

export const mockSessionScmSummaries: Record<string, SessionPRSummary[]> = {
	"demo-review-stack": [
		prSummary("demo-review-stack", 321, {
			createdAt: hoursAgo(2),
			stateChangedAt: hoursAgo(2),
		}),
		prSummary("demo-review-stack", 319, {
			createdAt: hoursAgo(6),
			stateChangedAt: hoursAgo(5),
		}),
		prSummary("demo-review-stack", 320, {
			createdAt: hoursAgo(4),
			stateChangedAt: hoursAgo(3),
		}),
		prSummary("demo-review-stack", 317, {
			url: "https://github.com/acme-inc/ao-demo/pull/317",
			htmlUrl: "https://github.com/acme-inc/ao-demo/pull/317",
			state: "merged",
			createdAt: hoursAgo(7),
			stateChangedAt: hoursAgo(1),
			mergeability: {
				state: "mergeable",
				reasons: [],
				prUrl: "https://github.com/acme-inc/ao-demo/pull/317",
				conflictFiles: [],
			},
		}),
	],
	"fix-auth-timeouts": [
		prSummary("fix-auth-timeouts", 184, {
			changedFiles: 5,
			additions: 91,
			deletions: 17,
			ci: {
				state: "failing",
				failingChecks: [
					{
						name: "backend / go test ./...",
						status: "failed",
						conclusion: "failure",
						url: "https://github.com/me/api-gateway/actions/runs/184001/job/1",
					},
					{
						name: "lint / golangci",
						status: "failed",
						conclusion: "failure",
						url: "https://github.com/me/api-gateway/actions/runs/184001/job/2",
					},
					{
						name: "api contract drift",
						status: "failed",
						conclusion: "failure",
						url: "https://github.com/me/api-gateway/actions/runs/184001/job/3",
					},
					{
						name: "frontend typecheck",
						status: "failed",
						conclusion: "",
						url: "https://github.com/me/api-gateway/actions/runs/184001/job/4",
					},
				],
			},
		}),
	],
	"texture-leak": [
		prSummary("texture-leak", 51, {
			changedFiles: 4,
			additions: 74,
			deletions: 22,
			ci: {
				state: "failing",
				failingChecks: [
					{
						name: "render tests",
						status: "failed",
						conclusion: "failure",
						url: "https://github.com/me/webgl-preview/actions/runs/51001/job/1",
					},
					{
						name: "visual regression",
						status: "failed",
						conclusion: "failure",
						url: "https://github.com/me/webgl-preview/actions/runs/51001/job/2",
					},
				],
			},
			mergeability: {
				state: "conflicting",
				reasons: ["conflicts"],
				prUrl: "https://github.com/me/webgl-preview/pull/51",
				conflictFiles: [
					{
						path: "src/render/texture-cache.ts",
						url: "https://github.com/me/webgl-preview/pull/51/conflicts#src-render-texture-cache-ts",
					},
					{
						path: "src/render/webgl-context.ts",
						url: "https://github.com/me/webgl-preview/pull/51/conflicts#src-render-webgl-context-ts",
					},
				],
			},
		}),
	],
	"review-camera-pan": [
		prSummary("review-camera-pan", 52, {
			changedFiles: 6,
			additions: 128,
			deletions: 31,
			review: {
				decision: "approved",
				hasUnresolvedHumanComments: false,
				reviews: [
					{
						reviewerId: "prateek",
						verdict: "approved",
						submittedAt: minutesAgo(41),
						reviewUrl: "https://github.com/me/webgl-preview/pull/52#pullrequestreview-2001",
						body: "Pan clamping reads cleanly now and the easing feels right. Good to go.",
					},
					{
						reviewerId: "codex",
						isBot: true,
						verdict: "approved",
						submittedAt: minutesAgo(38),
						reviewUrl: "https://github.com/me/webgl-preview/pull/52#pullrequestreview-2002",
						body: "No issues found across the changed camera math.",
					},
				],
				unresolvedBy: [],
			},
		}),
	],
	"input-pointer-lock": [
		prSummary("input-pointer-lock", 56, {
			changedFiles: 3,
			additions: 48,
			deletions: 14,
			review: {
				decision: "changes_requested",
				hasUnresolvedHumanComments: true,
				reviews: [
					{
						reviewerId: "maya",
						verdict: "changes_requested",
						submittedAt: minutesAgo(24),
						reviewUrl: "https://github.com/me/webgl-preview/pull/56#pullrequestreview-1001",
						body: "Pointer lock leaks its pointermove listener when the canvas unmounts — tear it down in the effect cleanup.",
					},
					{
						reviewerId: "copilot",
						isBot: true,
						verdict: "none",
						submittedAt: minutesAgo(19),
						reviewUrl: "https://github.com/me/webgl-preview/pull/56#pullrequestreview-1002",
						body: "Consider guarding requestPointerLock behind a user-gesture check to avoid the console warning.",
					},
				],
				unresolvedBy: [
					{
						reviewerId: "maya",
						count: 3,
						reviewUrl: "https://github.com/me/webgl-preview/pull/56#pullrequestreview-1001",
						links: [
							{
								url: "https://github.com/me/webgl-preview/pull/56#discussion_r1001",
								file: "src/input/pointer-lock.ts",
								line: 88,
							},
							{
								url: "https://github.com/me/webgl-preview/pull/56#discussion_r1002",
								file: "src/input/keyboard.ts",
								line: 41,
							},
						],
					},
					{
						reviewerId: "copilot",
						count: 1,
						isBot: true,
						reviewUrl: "https://github.com/me/webgl-preview/pull/56#pullrequestreview-1002",
						links: [],
					},
				],
			},
		}),
	],
	"invoice-export": [
		prSummary("invoice-export", 117, {
			changedFiles: 8,
			additions: 212,
			deletions: 36,
			mergeability: {
				state: "blocked",
				reasons: ["behind_base", "review_required", "blocked_by_provider", "ci_failing"],
				prUrl: "https://github.com/me/billing-portal/pull/117",
				conflictFiles: [],
			},
		}),
	],
};
