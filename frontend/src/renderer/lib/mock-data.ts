import type { PRState, PullRequestFacts, WorkspaceSummary } from "../types/workspace";
import type { SessionPRSummary } from "../hooks/useSessionScmSummary";

const now = new Date().toISOString();
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

// Single-PR preview helper. Sessions that own a stack (stacked-auth) inline
// their facts instead; the daemon aggregates per-PR CI/review server-side.
const pr = (number: number, state: PRState, ci = "passing"): PullRequestFacts => ({
	url: `https://github.com/me/pull/${number}`,
	number,
	state,
	ci,
	review: state === "merged" ? "approved" : "none",
	mergeability: "mergeable",
	reviewComments: false,
	updatedAt: now,
});

export const mockWorkspaces: WorkspaceSummary[] = [
	{
		id: "api-gateway",
		name: "api-gateway",
		path: "/Users/me/api-gateway",
		sessions: [
			{
				id: "refactor-mux",
				terminalHandleId: "refactor-mux/terminal_0",
				workspaceId: "api-gateway",
				workspaceName: "api-gateway",
				title: "Split terminal mux responsibilities",
				provider: "claude-code",
				branch: "feat/refactor-mux",
				status: "working",
				updatedAt: now,
				createdAt: hoursAgo(4),
				changedFiles: [
					{
						path: "internal/mux/terminal_mux.go",
						additions: 42,
						deletions: 8,
					},
				],
				commitMessage: "refactor terminal mux",
				prs: [],
			},
			{
				id: "stacked-auth",
				terminalHandleId: "stacked-auth/terminal_0",
				workspaceId: "api-gateway",
				workspaceName: "api-gateway",
				title: "auth stack",
				provider: "claude-code",
				branch: "feat/ns",
				status: "review_pending",
				updatedAt: now,
				createdAt: hoursAgo(2),
				// One session owning a stack: open root, draft child, merged base.
				prs: [
					{
						url: "https://github.com/me/api-gateway/pull/41",
						number: 41,
						state: "open",
						ci: "passing",
						review: "approved",
						mergeability: "mergeable",
						reviewComments: false,
						updatedAt: now,
					},
					{
						url: "https://github.com/me/api-gateway/pull/42",
						number: 42,
						state: "draft",
						ci: "pending",
						review: "none",
						mergeability: "unknown",
						reviewComments: false,
						updatedAt: now,
					},
					{
						url: "https://github.com/me/api-gateway/pull/40",
						number: 40,
						state: "merged",
						ci: "passing",
						review: "approved",
						mergeability: "mergeable",
						reviewComments: false,
						updatedAt: hoursAgo(1),
					},
				],
			},
			{
				id: "fix-auth-timeouts",
				workspaceId: "api-gateway",
				workspaceName: "api-gateway",
				title: "fix auth timeout retry loop",
				provider: "codex",
				branch: "fix/auth-timeouts",
				status: "ci_failed",
				updatedAt: hoursAgo(1),
				createdAt: hoursAgo(6),
				prs: [pr(184, "open", "failing")],
			},
			{
				id: "rate-limit-headers",
				workspaceId: "api-gateway",
				workspaceName: "api-gateway",
				title: "add rate limit headers",
				provider: "opencode",
				branch: "feat/rate-limit-headers",
				status: "review_pending",
				updatedAt: hoursAgo(2),
				createdAt: hoursAgo(9),
				prs: [pr(185, "open")],
			},
		],
	},
	{
		id: "webgl-preview",
		name: "webgl-preview",
		path: "/Users/me/webgl-preview",
		sessions: [
			{
				id: "fix-webgl-fallback",
				workspaceId: "webgl-preview",
				workspaceName: "webgl-preview",
				title: "Restore fallback renderer after WebGL init fails",
				provider: "codex",
				branch: "fix/webgl-fallback",
				status: "needs_input",
				updatedAt: now,
				createdAt: hoursAgo(4),
				prs: [],
			},
			{
				id: "shader-cache",
				workspaceId: "webgl-preview",
				workspaceName: "webgl-preview",
				title: "cache compiled shader programs",
				provider: "claude-code",
				branch: "feat/shader-cache",
				status: "working",
				updatedAt: hoursAgo(0.5),
				createdAt: hoursAgo(2),
				changedFiles: [
					{ path: "src/render/shader-cache.ts", additions: 86, deletions: 12 },
					{ path: "src/render/webgl-context.ts", additions: 24, deletions: 5 },
				],
				prs: [],
			},
			{
				id: "texture-leak",
				workspaceId: "webgl-preview",
				workspaceName: "webgl-preview",
				title: "stop texture leak on scene reload",
				provider: "codex",
				branch: "fix/texture-leak",
				status: "ci_failed",
				updatedAt: hoursAgo(1.5),
				createdAt: hoursAgo(7),
				prs: [pr(51, "open", "failing")],
			},
			{
				id: "review-camera-pan",
				workspaceId: "webgl-preview",
				workspaceName: "webgl-preview",
				title: "smooth camera pan controls",
				provider: "aider",
				branch: "feat/camera-pan",
				status: "review_pending",
				updatedAt: hoursAgo(3),
				createdAt: hoursAgo(10),
				prs: [pr(52, "open")],
			},
			{
				id: "draft-webgpu-probe",
				workspaceId: "webgl-preview",
				workspaceName: "webgl-preview",
				title: "probe WebGPU support before init",
				provider: "opencode",
				branch: "feat/webgpu-probe",
				status: "draft",
				updatedAt: hoursAgo(5),
				createdAt: hoursAgo(12),
				prs: [pr(53, "draft")],
			},
			{
				id: "merge-frame-stats",
				workspaceId: "webgl-preview",
				workspaceName: "webgl-preview",
				title: "ship frame statistics overlay",
				provider: "codex",
				branch: "feat/frame-stats",
				status: "mergeable",
				updatedAt: hoursAgo(0.25),
				createdAt: hoursAgo(14),
				prs: [pr(54, "open")],
			},
			{
				id: "approved-pixel-ratio",
				workspaceId: "webgl-preview",
				workspaceName: "webgl-preview",
				title: "respect device pixel ratio",
				provider: "claude-code",
				branch: "fix/device-pixel-ratio",
				status: "approved",
				updatedAt: hoursAgo(2.5),
				createdAt: hoursAgo(16),
				prs: [pr(55, "open")],
			},
			{
				id: "input-pointer-lock",
				workspaceId: "webgl-preview",
				workspaceName: "webgl-preview",
				title: "pointer lock escape handling",
				provider: "codex",
				branch: "fix/pointer-lock",
				status: "changes_requested",
				updatedAt: hoursAgo(4),
				createdAt: hoursAgo(18),
				prs: [pr(56, "open")],
			},
		],
	},
	{
		id: "mobile-shell",
		name: "mobile-shell",
		path: "/Users/me/mobile-shell",
		sessions: [
			{
				id: "nav-gesture",
				workspaceId: "mobile-shell",
				workspaceName: "mobile-shell",
				title: "repair back swipe gesture",
				provider: "codex",
				branch: "fix/back-swipe",
				status: "working",
				updatedAt: hoursAgo(0.75),
				createdAt: hoursAgo(3),
				prs: [],
			},
			{
				id: "profile-sheet",
				workspaceId: "mobile-shell",
				workspaceName: "mobile-shell",
				title: "profile sheet accessibility pass",
				provider: "claude-code",
				branch: "fix/profile-sheet-a11y",
				status: "mergeable",
				updatedAt: hoursAgo(1.25),
				createdAt: hoursAgo(8),
				prs: [pr(92, "open")],
			},
		],
	},
	{
		id: "billing-portal",
		name: "billing-portal",
		path: "/Users/me/billing-portal",
		sessions: [
			{
				id: "invoice-export",
				workspaceId: "billing-portal",
				workspaceName: "billing-portal",
				title: "invoice CSV export",
				provider: "opencode",
				branch: "feat/invoice-export",
				status: "review_pending",
				updatedAt: hoursAgo(2.25),
				createdAt: hoursAgo(11),
				prs: [pr(117, "open")],
			},
			{
				id: "tax-id-validation",
				workspaceId: "billing-portal",
				workspaceName: "billing-portal",
				title: "tax id validation errors",
				provider: "codex",
				branch: "fix/tax-id-validation",
				status: "needs_input",
				updatedAt: hoursAgo(1.75),
				createdAt: hoursAgo(5),
				prs: [],
			},
		],
	},
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
		updatedAt: facts?.updatedAt ?? now,
		observedAt: facts?.updatedAt ?? now,
		ciObservedAt: facts?.updatedAt ?? now,
		reviewObservedAt: facts?.updatedAt ?? now,
		...overrides,
	};
};

export const mockSessionScmSummaries: Record<string, SessionPRSummary[]> = {
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
				decision: "review_required",
				hasUnresolvedHumanComments: false,
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
