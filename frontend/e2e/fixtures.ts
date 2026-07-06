import type { Page, Route } from "@playwright/test";

const now = new Date().toISOString();
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

type PRFacts = {
	url: string;
	number: number;
	state: "draft" | "open" | "merged" | "closed";
	ci: "unknown" | "pending" | "passing" | "failing";
	review: "none" | "approved" | "changes_requested" | "review_required";
	mergeability: "unknown" | "mergeable" | "conflicting" | "blocked" | "unstable";
	reviewComments: boolean;
	updatedAt: string;
};

type Session = {
	id: string;
	projectId: string;
	terminalHandleId?: string;
	displayName: string;
	harness: string;
	kind: "worker" | "orchestrator";
	branch: string;
	status:
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
		| "idle"
		| "terminated"
		| "no_signal";
	isTerminated: boolean;
	activity: { state: string; lastActivityAt: string };
	createdAt: string;
	updatedAt: string;
	prs: PRFacts[];
};

const pr = (projectId: string, number: number, state: PRFacts["state"], ci: PRFacts["ci"] = "passing"): PRFacts => ({
	url: `https://github.com/me/${projectId}/pull/${number}`,
	number,
	state,
	ci,
	review: state === "merged" ? "approved" : "none",
	mergeability: state === "draft" ? "unknown" : "mergeable",
	reviewComments: false,
	updatedAt: state === "merged" ? hoursAgo(1) : now,
});

const projects = [
	{ id: "api-gateway", kind: "git", name: "api-gateway", path: "/Users/me/api-gateway", sessionPrefix: "api" },
	{ id: "webgl-preview", kind: "git", name: "webgl-preview", path: "/Users/me/webgl-preview", sessionPrefix: "webgl" },
	{ id: "mobile-shell", kind: "git", name: "mobile-shell", path: "/Users/me/mobile-shell", sessionPrefix: "mobile" },
	{
		id: "billing-portal",
		kind: "git",
		name: "billing-portal",
		path: "/Users/me/billing-portal",
		sessionPrefix: "billing",
	},
];

const session = (
	input: Omit<Session, "activity" | "createdAt" | "isTerminated" | "updatedAt"> & { ageHours: number },
): Session => ({
	...input,
	activity: { state: input.status === "needs_input" ? "waiting_input" : "idle", lastActivityAt: hoursAgo(0.5) },
	createdAt: hoursAgo(input.ageHours),
	isTerminated: input.status === "terminated" || input.status === "merged",
	updatedAt: hoursAgo(Math.min(input.ageHours, 1)),
});

const sessions: Session[] = [
	session({
		id: "refactor-mux",
		projectId: "api-gateway",
		terminalHandleId: "refactor-mux/terminal_0",
		displayName: "Split terminal mux responsibilities",
		harness: "claude-code",
		kind: "worker",
		branch: "feat/refactor-mux",
		status: "working",
		prs: [],
		ageHours: 4,
	}),
	session({
		id: "stacked-auth",
		projectId: "api-gateway",
		terminalHandleId: "stacked-auth/terminal_0",
		displayName: "auth stack",
		harness: "claude-code",
		kind: "worker",
		branch: "feat/ns",
		status: "review_pending",
		prs: [pr("api-gateway", 41, "open"), pr("api-gateway", 42, "draft", "pending"), pr("api-gateway", 40, "merged")],
		ageHours: 2,
	}),
	session({
		id: "fix-auth-timeouts",
		projectId: "api-gateway",
		displayName: "fix auth timeout retry loop",
		harness: "codex",
		kind: "worker",
		branch: "fix/auth-timeouts",
		status: "ci_failed",
		prs: [pr("api-gateway", 184, "open", "failing")],
		ageHours: 6,
	}),
	session({
		id: "fix-webgl-fallback",
		projectId: "webgl-preview",
		displayName: "fix-webgl-fallback",
		harness: "codex",
		kind: "worker",
		branch: "fix/webgl-fallback",
		status: "needs_input",
		prs: [],
		ageHours: 4,
	}),
	session({
		id: "texture-leak",
		projectId: "webgl-preview",
		displayName: "stop texture leak on scene reload",
		harness: "codex",
		kind: "worker",
		branch: "fix/texture-leak",
		status: "ci_failed",
		prs: [pr("webgl-preview", 51, "open", "failing")],
		ageHours: 7,
	}),
	session({
		id: "profile-sheet",
		projectId: "mobile-shell",
		displayName: "profile sheet accessibility pass",
		harness: "claude-code",
		kind: "worker",
		branch: "fix/profile-sheet-a11y",
		status: "mergeable",
		prs: [pr("mobile-shell", 92, "open")],
		ageHours: 8,
	}),
	session({
		id: "invoice-export",
		projectId: "billing-portal",
		displayName: "invoice CSV export",
		harness: "opencode",
		kind: "worker",
		branch: "feat/invoice-export",
		status: "review_pending",
		prs: [pr("billing-portal", 117, "open")],
		ageHours: 11,
	}),
];

function prSummary(sessionId: string, facts: PRFacts) {
	const owner = sessions.find((item) => item.id === sessionId);
	return {
		...facts,
		htmlUrl: facts.url,
		title: owner?.displayName ?? `PR #${facts.number}`,
		provider: "github",
		repo: `me/${owner?.projectId ?? "project"}`,
		author: "fixture-agent",
		sourceBranch: owner?.branch ?? "",
		targetBranch: "main",
		headSha: `fixture-${facts.number}`,
		additions: facts.number === 41 ? 42 : 0,
		deletions: facts.number === 41 ? 8 : 0,
		changedFiles: facts.number === 41 ? 3 : 0,
		ci: { state: facts.ci, failingChecks: [] },
		review: {
			decision: facts.review,
			hasUnresolvedHumanComments: facts.reviewComments,
			unresolvedBy: [],
		},
		mergeability: {
			state: facts.mergeability,
			reasons: [],
			prUrl: facts.url,
			conflictFiles: [],
		},
		observedAt: facts.updatedAt,
		ciObservedAt: facts.updatedAt,
		reviewObservedAt: facts.updatedAt,
	};
}

async function fulfill(route: Route, json: unknown) {
	await route.fulfill({
		contentType: "application/json",
		json,
	});
}

async function fulfillSse(route: Route) {
	await route.fulfill({
		contentType: "text/event-stream",
		body: ": ok\n\n",
	});
}

export async function mockAoApi(page: Page) {
	await page.route("**/healthz", async (route) => {
		await fulfill(route, { status: "ok", service: "agent-orchestrator-daemon", pid: 4242 });
	});
	await page.route("**/readyz", async (route) => {
		await fulfill(route, { status: "ready", service: "agent-orchestrator-daemon", pid: 4242 });
	});
	await page.route("**/api/v1/**", async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		if (path === "/api/v1/events" || path === "/api/v1/notifications/stream") {
			return fulfillSse(route);
		}
		if (path === "/api/v1/projects") {
			return fulfill(route, { projects });
		}
		if (path === "/api/v1/sessions") {
			return fulfill(route, { sessions });
		}
		const projectMatch = path.match(/^\/api\/v1\/projects\/([^/]+)$/);
		if (projectMatch) {
			const project = projects.find((item) => item.id === projectMatch[1]);
			return fulfill(route, {
				status: "ok",
				project: {
					...project,
					repo: project?.name ?? "",
					defaultBranch: "main",
					config: { reviewers: [{ harness: "codex" }] },
				},
			});
		}
		const prMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/pr$/);
		if (prMatch) {
			const owner = sessions.find((item) => item.id === prMatch[1]);
			return fulfill(route, {
				sessionId: prMatch[1],
				prs: owner?.prs.map((facts) => prSummary(owner.id, facts)) ?? [],
			});
		}
		const reviewsMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/reviews$/);
		if (reviewsMatch) {
			const owner = sessions.find((item) => item.id === reviewsMatch[1]);
			return fulfill(route, {
				reviewerHandleId: "reviewer-pane",
				reviews:
					owner?.prs.map((facts) => ({
						prNumber: facts.number,
						prUrl: facts.url,
						status: facts.state === "draft" ? "ineligible" : "up_to_date",
						targetSha: `fixture-${facts.number}`,
						title: owner.displayName,
						latestRun:
							facts.state === "draft"
								? undefined
								: {
										batchId: "batch-1",
										body: "Looks good.",
										createdAt: now,
										githubReviewId: `review-${facts.number}`,
										harness: "codex",
										id: `run-${facts.number}`,
										prUrl: facts.url,
										reviewId: `review-${facts.number}`,
										sessionId: owner.id,
										status: "complete",
										targetSha: `fixture-${facts.number}`,
										verdict: "approved",
									},
					})) ?? [],
			});
		}
		return fulfill(route, {});
	});
}
