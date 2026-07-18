import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "../types/workspace";
import {
	OrchestratorReviewBoard,
	ReviewTaskCard,
	hasReviewTranslationResponse,
	isSpecificReviewQuestion,
	parseReviewTranslations,
	REVIEW_TRANSLATOR_ISSUE_PREFIX,
	reviewAgentPrompt,
	reviewBatchId,
	reviewCandidates,
	reviewConversationEvidence,
	stoppedPullRequestTranslation,
	type ReviewCard,
	type ReviewSourceContext,
} from "./OrchestratorReviewBoard";

const { getMock, navigateMock, postMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	navigateMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: (...args: unknown[]) => getMock(...args),
		POST: (...args: unknown[]) => postMock(...args),
	},
	apiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

vi.mock("../hooks/useTerminalSession", () => ({
	useTerminalSession: () => ({
		attach: () => () => undefined,
		error: undefined,
		state: "attached",
	}),
}));

vi.mock("./XtermTerminal", () => ({
	XtermTerminal: () => null,
}));

const orchestrator = {
	id: "proj-1-orchestrator",
	workspaceId: "proj-1",
	workspaceName: "My project",
	title: "Orbit",
	provider: "claude-code",
	kind: "orchestrator",
	branch: "main",
	status: "working",
	createdAt: "2026-07-15T10:00:00Z",
	updatedAt: "2026-07-15T10:00:00Z",
	prs: [],
} satisfies WorkspaceSession;
const reviewAgentIssueId = `${REVIEW_TRANSLATOR_ISSUE_PREFIX}${orchestrator.workspaceId}`;

function worker(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
	return {
		id: "worker-1",
		workspaceId: "proj-1",
		workspaceName: "My project",
		title: "Choose cache policy",
		provider: "codex",
		kind: "worker",
		branch: "ao/cache-policy",
		status: "needs_input",
		createdAt: "2026-07-15T10:01:00Z",
		updatedAt: "2026-07-15T10:02:00Z",
		prs: [],
		...overrides,
	};
}

const openPr = {
	url: "https://example.com/pull/7",
	number: 7,
	state: "open",
	ci: "pending",
	review: "pending",
	mergeability: "unknown",
	reviewComments: false,
	updatedAt: "2026-07-15T10:02:00Z",
} as const;

const detailedPr = {
	url: openPr.url,
	htmlUrl: openPr.url,
	number: openPr.number,
	title: "Choose shared-cache eviction semantics",
	state: "open",
	provider: "github",
	repo: "ao/example",
	author: "worker",
	sourceBranch: "ao/cache-policy",
	targetBranch: "main",
	headSha: "abc123def456",
	additions: 24,
	deletions: 3,
	changedFiles: 2,
	ci: { state: "passing", failingChecks: [] },
	review: { decision: "review_required", hasUnresolvedHumanComments: false, unresolvedBy: [] },
	mergeability: { state: "mergeable", reasons: [], prUrl: openPr.url, conflictFiles: [] },
	updatedAt: "2026-07-15T10:02:00Z",
} as const;

function detailedReviewContext(sessionId = "worker-1"): ReviewSourceContext {
	return {
		sessionId,
		artifactPath: "docs/cache-policy.md",
		pullRequests: [
			{
				number: detailedPr.number,
				title: detailedPr.title,
				headSha: detailedPr.headSha,
				sourceBranch: detailedPr.sourceBranch,
				targetBranch: detailedPr.targetBranch,
				state: detailedPr.state,
				ci: detailedPr.ci.state,
				review: detailedPr.review.decision,
				changedFiles: detailedPr.changedFiles,
				failingChecks: [],
				unresolvedComments: 0,
				conflictFiles: [],
			},
		],
	};
}

function renderBoard(sessions: WorkspaceSession[], daemonReady = false, manageAgent = true) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<OrchestratorReviewBoard
				daemonReady={daemonReady}
				orchestrator={orchestrator}
				sessions={[orchestrator, ...sessions]}
				theme="dark"
				manageAgent={manageAgent}
			/>
		</QueryClientProvider>,
	);
}

function renderCard(card: ReviewCard) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<ReviewTaskCard card={card} index={0} orchestratorId={orchestrator.id} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	navigateMock.mockReset();
	getMock.mockReset().mockImplementation((path: string) =>
		path === "/api/v1/sessions/{sessionId}/conversation"
			? Promise.resolve({
					data: { sessionId: "review-helper-1", source: "unavailable", entries: [] },
					error: undefined,
				})
			: Promise.resolve({ data: { prs: [detailedPr] }, error: undefined }),
	);
	postMock.mockReset().mockResolvedValue({ data: { session: { id: "review-helper-1" } }, error: undefined });
});

describe("review selection and translation", () => {
	it("keeps only worker sessions that need a human review", () => {
		const candidates = reviewCandidates([
			orchestrator,
			worker(),
			worker({ id: "working", status: "working" }),
			worker({ id: "ci", status: "ci_failed" }),
			worker({ id: "draft", status: "draft", prs: [{ ...openPr, state: "draft" }] }),
			worker({ id: "open", status: "pr_open", prs: [openPr] }),
			worker({
				id: "stopped-draft",
				status: "terminated",
				updatedAt: "2026-07-15T10:04:00Z",
				prs: [{ ...openPr, state: "draft" }],
			}),
			worker({
				id: "stopped-open",
				status: "terminated",
				updatedAt: "2026-07-15T10:03:00Z",
				prs: [openPr],
			}),
			worker({ id: "stale-draft", status: "draft", prs: [] }),
			worker({ id: "helper", issueId: `${REVIEW_TRANSLATOR_ISSUE_PREFIX}abc` }),
		]);

		expect(candidates.map((candidate) => candidate.id)).toEqual([
			"worker-1",
			"ci",
			"stopped-draft",
			"stopped-open",
			"draft",
			"open",
		]);
	});

	it("parses a dedicated reviewer response with clickable choices", () => {
		const lines = [
			"AO_REVIEW_BOARD_deadbeef_START",
			"not json",
			"AO_REVIEW_BOARD_deadbeef_END",
			"AO_REVIEW_BOARD_deadbeef_START",
			'{"items":[{"sessionId":"worker-1","summary":"The agent needs a cache choice.","question":"Which cache should it use?","choices":[{"label":"Shared","message":"Use the shared cache."},{"label":"Isolated","message":"Use isolated caches."}]}]}',
			"AO_REVIEW_BOARD_deadbeef_END",
		];

		expect(parseReviewTranslations(lines, "deadbeef")).toEqual([
			{
				sessionId: "worker-1",
				summary: "The agent needs a cache choice.",
				question: "Which cache should it use?",
				choices: [
					{ label: "Shared", message: "Use the shared cache." },
					{ label: "Isolated", message: "Use isolated caches." },
				],
			},
		]);
	});

	it("reflows visual terminal wrapping inside the helper's JSON", () => {
		const lines = [
			"AO_REVIEW_BOARD_deadbeef_START",
			'{"items":[{"sessionId":"worker-',
			'  1","summary":"The agent needs',
			'  a cache choice.","question":"Which cache',
			'  should it use?"}]}',
			"AO_REVIEW_BOARD_deadbeef_END",
		];

		expect(parseReviewTranslations(lines, "deadbeef")).toEqual([
			{
				sessionId: "worker-1",
				summary: "The agent needs a cache choice.",
				question: "Which cache should it use?",
			},
		]);
	});

	it("keeps the submitted prompt out of durable response parsing", () => {
		const evidence = reviewConversationEvidence(
			[
				{
					role: "user",
					kind: "message",
					text: "Return AO_REVIEW_BOARD_deadbeef_START then AO_REVIEW_BOARD_deadbeef_END",
					timestamp: "2026-07-16T10:00:00Z",
				},
				{
					role: "assistant",
					kind: "message",
					text: "AO_REVIEW_BOARD_deadbeef_START\n{\"items\":[]}\nAO_REVIEW_BOARD_deadbeef_END",
					timestamp: "2026-07-16T10:00:01Z",
				},
			],
			"deadbeef",
		);

		expect(evidence.requestedAt).toBe("2026-07-16T10:00:00Z");
		expect(evidence.responseLines.join("\n")).not.toContain("Return AO_REVIEW_BOARD");
		expect(hasReviewTranslationResponse(evidence.responseLines, "deadbeef")).toBe(true);
	});

	it("gives the helper a translation-only, no-edit brief", () => {
		const contexts: ReviewSourceContext[] = [
			{
				sessionId: "worker-1",
				artifactPath: "docs/cache-policy.md",
				pullRequests: [
					{
						number: 7,
						title: "Choose shared-cache eviction semantics",
						headSha: "abc123def456",
						state: "open",
						ci: "passing",
						review: "review_required",
					},
				],
			},
		];
		const prompt = reviewAgentPrompt([worker()], "deadbeef", contexts);
		expect(prompt).toContain("Do not edit, test, message, or spawn agents");
		expect(prompt).toContain("one concrete acceptance question");
		expect(prompt).toContain("Never ask whether to review, open, inspect, revise, continue, wait, or leave");
		expect(prompt).toContain("abc123def456");
		expect(prompt).toContain("docs/cache-policy.md");
		expect(prompt).toContain('"sessionId":"worker-1"');
	});

	it.each([
		"Should this draft be reviewed now, revised, or left waiting?",
		"Would you like to inspect the work now, or keep waiting?",
		"What should this agent do next?",
		"Do you want to review this pull request now?",
	])("rejects a generic workflow question: %s", (question) => {
		expect(isSpecificReviewQuestion(question)).toBe(false);
		const lines = [
			"AO_REVIEW_BOARD_deadbeef_START",
			JSON.stringify({ items: [{ sessionId: "worker-1", summary: "Generic status.", question }] }),
			"AO_REVIEW_BOARD_deadbeef_END",
		];
		expect(parseReviewTranslations(lines, "deadbeef")).toEqual([]);
	});

	it("accepts a concrete task decision", () => {
		const question = "Should cache entries be shared across workers or isolated per worker?";
		expect(isSpecificReviewQuestion(question)).toBe(true);
		expect(isSpecificReviewQuestion("Should the app open the report after export?")).toBe(true);
	});

	it("keeps the eight-card helper prompt within the daemon message limit", () => {
		const candidates = Array.from({ length: 8 }, (_, index) =>
			worker({ id: `worker-${index}`, title: `Cache policy ${"界".repeat(60)}` }),
		);
		const contexts = candidates.map((candidate, index) => ({
			sessionId: candidate.id,
			artifactPath: `docs/${"界".repeat(80)}-${index}.md`,
			latestAgentMessage: `Detailed implementation evidence ${"界".repeat(700)}`,
			pullRequests: [
				{
					number: index + 1,
					title: `Choose ${"界".repeat(100)}`,
					headSha: "a".repeat(40),
					sourceBranch: `ao/${"界".repeat(40)}`,
					targetBranch: "main",
					state: "open",
					ci: "passing",
					review: "review_required",
				},
			],
		}));

		const prompt = reviewAgentPrompt(candidates, "deadbeef", contexts);
		expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(4096);
		for (const candidate of candidates) expect(prompt).toContain(candidate.id);
	});

	it("keeps a review batch stable across database-only timestamp refreshes", () => {
		const original = worker({ prs: [openPr] });
		const refreshed = worker({
			prs: [openPr],
			updatedAt: "2026-07-15T11:30:00Z",
			activity: { state: "active", lastActivityAt: "2026-07-15T11:30:00Z" },
		});

		expect(reviewBatchId([original], 0)).toBe(reviewBatchId([refreshed], 0));
		expect(reviewBatchId([original], 0)).not.toBe(reviewBatchId([original], 1));
		expect(reviewBatchId([original], 0)).not.toBe(reviewBatchId([worker({ status: "ci_failed", prs: [openPr] })], 0));
		expect(reviewBatchId([original], 0, [{ sessionId: original.id, pullRequests: [], artifactPath: "a.md" }])).not.toBe(
			reviewBatchId([original], 0, [{ sessionId: original.id, pullRequests: [], artifactPath: "b.md" }]),
		);
	});
});

describe("review board", () => {
	it("shows the background manager error and sends dialog refreshes back to it", async () => {
		const candidate = worker({ prs: [openPr] });
		const onRefresh = vi.fn();
		const batchId = reviewBatchId([candidate], 0);
		render(
			<QueryClientProvider client={new QueryClient()}>
				<OrchestratorReviewBoard
					daemonReady={false}
					manageAgent={false}
					managerState={{ batchId, working: false, error: "prompt is too long (PROMPT_TOO_LONG)" }}
					onRefresh={onRefresh}
					orchestrator={orchestrator}
					refreshNonce={0}
					sessions={[orchestrator, candidate]}
					theme="dark"
				/>
			</QueryClientProvider>,
		);

		expect(screen.getByText(/prompt is too long \(PROMPT_TOO_LONG\)/i)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
	});

	it("keeps missing context queued for the dedicated reviewer", () => {
		renderBoard([worker()]);

		expect(screen.getByRole("region", { name: "Tasks without a decision" })).toBeInTheDocument();
		expect(screen.getByText("No decision needed right now")).toBeInTheDocument();
		expect(screen.getByText("Choose cache policy")).toBeInTheDocument();
		expect(screen.queryByText(/couldn't retrieve the exact review question/i)).not.toBeInTheDocument();
		expect(screen.queryByText("Question for you")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Flip Choose cache policy to answer" })).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Your answer")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Send answer/i })).not.toBeInTheDocument();

		expect(screen.getByText("Reviewer queued")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Open task/i })).not.toBeInTheDocument();
	});

	it("starts a clean reviewer for the next batch instead of reusing an idle agent", async () => {
		const candidate = worker({
			prs: [openPr],
			previewUrl: "http://127.0.0.1/api/v1/sessions/worker-1/preview/files/docs/cache-policy.md",
		});
		const batchId = reviewBatchId([candidate], 0, [detailedReviewContext()]);
		const helper = worker({
			id: "review-helper-1",
			title: "Review helper",
			issueId: reviewAgentIssueId,
			terminalHandleId: "review-terminal-1",
			status: "idle",
			createdAt: "2020-01-01T00:00:00Z",
			updatedAt: "2020-01-01T00:00:00Z",
			activity: { state: "idle", lastActivityAt: "2020-01-01T00:00:01Z" },
		});

		renderBoard([candidate, helper], true);

		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith(
				"/api/v1/sessions",
				expect.objectContaining({
					body: expect.objectContaining({ prompt: expect.stringContaining(`AO_REVIEW_BOARD_${batchId}_START`) }),
				}),
			),
		);
		expect(postMock.mock.calls.some(([path]) => path === "/api/v1/sessions/{sessionId}/send")).toBe(false);
	});

	it("waits for an active helper instead of sending a second prompt into it", async () => {
		const candidate = worker({
			prs: [openPr],
			previewUrl: "http://127.0.0.1/api/v1/sessions/worker-1/preview/files/docs/cache-policy.md",
		});
		const now = new Date().toISOString();
		const helper = worker({
			id: "review-helper-1",
			title: "Review helper",
			issueId: reviewAgentIssueId,
			terminalHandleId: "review-terminal-1",
			status: "working",
			createdAt: now,
			updatedAt: now,
			activity: { state: "active", lastActivityAt: now },
		});

		renderBoard([candidate, helper], true);

		await waitFor(
			() => {
				const conversationReads = getMock.mock.calls.filter(
					([path]) => path === "/api/v1/sessions/{sessionId}/conversation",
				);
				expect(conversationReads.length).toBeGreaterThanOrEqual(2);
			},
			{ timeout: 2_500 },
		);
		expect(screen.getByText("Preparing review questions")).toBeInTheDocument();
		expect(screen.getByText("Review agent thinking")).toBeInTheDocument();
		expect(postMock).not.toHaveBeenCalled();
	});

	it("builds a concrete local decision for a stopped worker's pull request", () => {
		const session = worker({ status: "terminated", prs: [{ ...openPr, state: "draft" }] });

		expect(stoppedPullRequestTranslation(session, detailedReviewContext())).toEqual({
			sessionId: "worker-1",
			summary: "Draft PR #7 from Choose cache policy is ready: Choose shared-cache eviction semantics.",
			question: 'Approve Draft PR #7, "Choose shared-cache eviction semantics"?',
			choices: [
				{ label: "Approve", message: "Approve Draft PR #7 for Choose cache policy." },
				{ label: "Request changes", message: "Request changes for Draft PR #7 from Choose cache policy." },
			],
		});
	});

	it("replaces an orphaned no-signal helper instead of sending another prompt into it", async () => {
		const candidate = worker({
			prs: [openPr],
			previewUrl: "http://127.0.0.1/api/v1/sessions/worker-1/preview/files/docs/cache-policy.md",
		});
		const helper = worker({
			id: "review-helper-1",
			title: "Review helper",
			issueId: reviewAgentIssueId,
			terminalHandleId: "review-terminal-1",
			status: "no_signal",
			activity: { state: "idle", lastActivityAt: "2020-01-01T00:00:01Z" },
		});

		renderBoard([candidate, helper], true);

		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith(
				"/api/v1/sessions",
				expect.objectContaining({
					body: expect.objectContaining({ displayName: "Review agent", issueId: reviewAgentIssueId }),
				}),
			),
		);
		expect(
			postMock.mock.calls.some(([path]) => path === "/api/v1/sessions/{sessionId}/send"),
		).toBe(false);
	});

	it("starts a fresh reviewer instead of reusing an idle helper from an older batch", async () => {
		const candidate = worker({
			prs: [openPr],
			previewUrl: "http://127.0.0.1/api/v1/sessions/worker-1/preview/files/docs/cache-policy.md",
		});
		const helper = worker({
			id: "review-helper-1",
			title: "Review helper",
			issueId: reviewAgentIssueId,
			terminalHandleId: "review-terminal-1",
			status: "idle",
			activity: { state: "idle", lastActivityAt: "2026-07-16T10:00:01Z" },
		});

		renderBoard([candidate, helper], true);

		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith(
				"/api/v1/sessions",
				expect.objectContaining({
					body: expect.objectContaining({ displayName: "Review agent", issueId: reviewAgentIssueId }),
				}),
			),
		);
		expect(postMock.mock.calls.some(([path]) => path === "/api/v1/sessions/{sessionId}/send")).toBe(false);
	});

	it("does not resend a durable review request after remounting", async () => {
		const candidate = worker({
			prs: [openPr],
			previewUrl: "http://127.0.0.1/api/v1/sessions/worker-1/preview/files/docs/cache-policy.md",
		});
		const batchId = reviewBatchId([candidate], 0, [detailedReviewContext()]);
		getMock.mockImplementation((path: string, options?: { params?: { path?: { sessionId?: string } } }) =>
			path === "/api/v1/sessions/{sessionId}/conversation" &&
			options?.params?.path?.sessionId === "review-helper-1"
				? Promise.resolve({
						data: {
							sessionId: "review-helper-1",
							source: "codex",
							entries: [
								{
									id: "request-1",
									role: "user",
									kind: "message",
									text: `AO_REVIEW_BOARD_${batchId}_START request`,
									timestamp: "2020-01-01T00:00:00Z",
								},
							],
						},
						error: undefined,
					})
				: path === "/api/v1/sessions/{sessionId}/conversation"
					? Promise.resolve({ data: { sessionId: "worker-1", source: "codex", entries: [] }, error: undefined })
					: Promise.resolve({ data: { prs: [detailedPr] }, error: undefined }),
		);
		const helper = worker({
			id: "review-helper-1",
			title: "Review helper",
			issueId: reviewAgentIssueId,
			terminalHandleId: "review-terminal-1",
			status: "idle",
			activity: { state: "idle", lastActivityAt: "2020-01-01T00:00:01Z" },
		});

		renderBoard([candidate, helper], true);

		expect(await screen.findByText("One-click review isn’t available yet")).toBeInTheDocument();
		expect(screen.getByRole("region", { name: "Review recovery" })).toBeInTheDocument();
		expect(postMock).not.toHaveBeenCalled();
	});

	it("uses the durable helper answer without scraping or resending the terminal", async () => {
		const candidate = worker({
			prs: [openPr],
			previewUrl: "http://127.0.0.1/api/v1/sessions/worker-1/preview/files/docs/cache-policy.md",
		});
		const batchId = reviewBatchId([candidate], 0, [detailedReviewContext()]);
		const response = [
			`AO_REVIEW_BOARD_${batchId}_START`,
			JSON.stringify({
				items: [
					{
						sessionId: "worker-1",
						summary: "The cache policy needs an ownership choice.",
						question: "Should cache entries be shared across workers or isolated per worker?",
					},
				],
			}),
			`AO_REVIEW_BOARD_${batchId}_END`,
		].join("\n");
		getMock.mockImplementation((path: string, options?: { params?: { path?: { sessionId?: string } } }) =>
			path === "/api/v1/sessions/{sessionId}/conversation" &&
			options?.params?.path?.sessionId === "review-helper-1"
				? Promise.resolve({
						data: {
							sessionId: "review-helper-1",
							source: "codex",
							entries: [
								{
									id: "answer-1",
									role: "assistant",
									kind: "message",
									text: response,
									timestamp: "2026-07-16T10:00:01Z",
								},
							],
						},
						error: undefined,
					})
				: path === "/api/v1/sessions/{sessionId}/conversation"
					? Promise.resolve({ data: { sessionId: "worker-1", source: "codex", entries: [] }, error: undefined })
					: Promise.resolve({ data: { prs: [detailedPr] }, error: undefined }),
		);
		const helper = worker({
			id: "review-helper-1",
			title: "Review helper",
			issueId: reviewAgentIssueId,
			terminalHandleId: "review-terminal-1",
			status: "idle",
			activity: { state: "idle", lastActivityAt: "2026-07-16T10:00:01Z" },
		});

		renderBoard([candidate, helper], true);

		expect(await screen.findByText("The cache policy needs an ownership choice.")).toBeInTheDocument();
		expect(screen.getAllByText("Should cache entries be shared across workers or isolated per worker?")).toHaveLength(1);
		expect(postMock).not.toHaveBeenCalled();
	});

	it("starts a fresh review batch when Refresh is pressed", async () => {
		const user = userEvent.setup();
		const candidate = worker({
			prs: [openPr],
			previewUrl: "http://127.0.0.1/api/v1/sessions/worker-1/preview/files/docs/cache-policy.md",
		});
		const context = detailedReviewContext();
		const initialBatchId = reviewBatchId([candidate], 0, [context]);
		const refreshedBatchId = reviewBatchId([candidate], 1, [context]);
		const initialResponse = [
			`AO_REVIEW_BOARD_${initialBatchId}_START`,
			JSON.stringify({
				items: [
					{
						sessionId: "worker-1",
						summary: "The cache policy needs an ownership choice.",
						question: "Should cache entries be shared across workers or isolated per worker?",
					},
				],
			}),
			`AO_REVIEW_BOARD_${initialBatchId}_END`,
		].join("\n");
		getMock.mockImplementation((path: string, options?: { params?: { path?: { sessionId?: string } } }) => {
			if (path === "/api/v1/sessions/{sessionId}/conversation") {
				return Promise.resolve({
					data:
						options?.params?.path?.sessionId === "review-helper-1"
							? {
									sessionId: "review-helper-1",
									source: "codex",
									entries: [{ id: "answer-1", role: "assistant", kind: "message", text: initialResponse }],
								}
							: { sessionId: "worker-1", source: "codex", entries: [] },
					error: undefined,
				});
			}
			return Promise.resolve({ data: { prs: [detailedPr] }, error: undefined });
		});
		const helper = worker({
			id: "review-helper-1",
			title: "Review helper",
			issueId: reviewAgentIssueId,
			terminalHandleId: "review-terminal-1",
			status: "idle",
			activity: { state: "idle", lastActivityAt: "2026-07-16T10:00:01Z" },
		});

		renderBoard([candidate, helper], true);
		expect(await screen.findByText("The cache policy needs an ownership choice.")).toBeInTheDocument();
		expect(postMock).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Refresh" }));

		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith(
				"/api/v1/sessions",
				expect.objectContaining({
					body: expect.objectContaining({
						prompt: expect.stringContaining(`AO_REVIEW_BOARD_${refreshedBatchId}_START`),
					}),
				}),
			),
		);
		expect(postMock.mock.calls.at(-1)?.[1]?.body.prompt).not.toContain(
			`AO_REVIEW_BOARD_${initialBatchId}_START`,
		);
	});

	it("recovers the durable answer after the matching helper has terminated", async () => {
		const candidate = worker({
			prs: [openPr],
			previewUrl: "http://127.0.0.1/api/v1/sessions/worker-1/preview/files/docs/cache-policy.md",
		});
		const batchId = reviewBatchId([candidate], 0, [detailedReviewContext()]);
		const response = [
			`AO_REVIEW_BOARD_${batchId}_START`,
			JSON.stringify({
				items: [
					{
						sessionId: "worker-1",
						summary: "The cache behavior needs one acceptance decision.",
						question: "Should the app open the report after export?",
					},
				],
			}),
			`AO_REVIEW_BOARD_${batchId}_END`,
		].join("\n");
		getMock.mockImplementation((path: string, options?: { params?: { path?: { sessionId?: string } } }) =>
			path === "/api/v1/sessions/{sessionId}/conversation" &&
			options?.params?.path?.sessionId === "review-helper-1"
				? Promise.resolve({
						data: {
							sessionId: "review-helper-1",
							source: "codex",
							entries: [{ id: "answer-1", role: "assistant", kind: "message", text: response }],
						},
						error: undefined,
					})
				: path === "/api/v1/sessions/{sessionId}/conversation"
					? Promise.resolve({ data: { sessionId: "worker-1", source: "codex", entries: [] }, error: undefined })
					: Promise.resolve({ data: { prs: [detailedPr] }, error: undefined }),
		);
		const helper = worker({
			id: "review-helper-1",
			title: "Review helper",
			issueId: reviewAgentIssueId,
			terminalHandleId: "review-terminal-1",
			status: "terminated",
			activity: { state: "exited", lastActivityAt: "2026-07-16T10:00:01Z" },
		});

		renderBoard([candidate, helper], true);

		expect(await screen.findByText("The cache behavior needs one acceptance decision.")).toBeInTheDocument();
		expect(screen.getAllByText("Should the app open the report after export?")).toHaveLength(1);
		expect(screen.queryByText("One-click review isn’t available yet")).not.toBeInTheDocument();
		expect(postMock).not.toHaveBeenCalled();
	});

	it("sends a one-click review decision to the orchestrator", async () => {
		const user = userEvent.setup();
		renderCard({
			sessionId: "worker-1",
			summary: "The cache policy must choose one ownership model.",
			question: "Should cache entries be shared across workers or isolated per worker?",
			reason: "Concrete acceptance decision",
			session: worker(),
		});

		await user.click(screen.getByRole("button", { name: "Approve for Choose cache policy" }));

		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/send", {
				params: { path: { sessionId: "proj-1-orchestrator" } },
				body: {
					message:
						"Review answer for Choose cache policy (worker-1): Approve the review item for Choose cache policy.\nQuestion: Should cache entries be shared across workers or isolated per worker?",
				},
			}),
		);
		expect(await screen.findByText("Approve sent to Orbit")).toBeInTheDocument();
	});

	it("shows which review choice is being sent", async () => {
		let resolveSend: ((value: unknown) => void) | undefined;
		postMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveSend = resolve;
				}),
		);
		const user = userEvent.setup();
		renderCard({
			sessionId: "worker-1",
			summary: "The cache policy must choose one ownership model.",
			question: "Should cache entries be shared across workers or isolated per worker?",
			reason: "Concrete acceptance decision",
			session: worker(),
		});
		const requestChanges = screen.getByRole("button", { name: "Request changes for Choose cache policy" });

		await user.click(requestChanges);

		expect(requestChanges).toHaveAttribute("aria-busy", "true");
		expect(requestChanges).toHaveTextContent("Sending...");
		expect(screen.getByRole("button", { name: "Approve for Choose cache policy" })).not.toHaveTextContent("Sending...");
		resolveSend?.({ data: {}, error: undefined });
		await waitFor(() => expect(screen.getByText("Request changes sent to Orbit")).toBeInTheDocument());
	});

	it("shows stopped pull requests immediately without starting a review helper", async () => {
		renderBoard([worker({ status: "terminated", prs: [{ ...openPr, state: "draft" }] })], true, false);

		expect(await screen.findByText('Approve Draft PR #7, "Choose shared-cache eviction semantics"?')).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Approve for Choose cache policy" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Request changes for Choose cache policy" })).toBeInTheDocument();
		expect(postMock).not.toHaveBeenCalled();
	});

	it("starts one low-effort dedicated reviewer with the project's worker agent", async () => {
		renderBoard([worker({ prs: [openPr], previewUrl: "http://127.0.0.1/api/v1/sessions/worker-1/preview/files/docs/cache-policy.md" })], true);

		await waitFor(() => expect(postMock).toHaveBeenCalled());
		expect(getMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/pr", {
			params: { path: { sessionId: "worker-1" } },
		});
		expect(postMock.mock.calls[0]?.[0]).toBe("/api/v1/sessions");
		expect(postMock.mock.calls[0]?.[1]).toMatchObject({
			body: {
				projectId: "proj-1",
				kind: "worker",
				displayName: "Review agent",
				issueId: reviewAgentIssueId,
				agentConfig: { model: "gpt-5.6-sol", reasoningEffort: "low" },
			},
		});
		expect(postMock.mock.calls[0]?.[1]?.body).not.toHaveProperty("harness");
		expect(postMock.mock.calls[0]?.[1]?.body.prompt).toContain("Choose shared-cache eviction semantics");
		expect(postMock.mock.calls[0]?.[1]?.body.prompt).toContain("docs/cache-policy.md");
	});

	it("deduplicates concurrent reviewer launches during a shell remount", async () => {
		let resolveLaunch: ((value: unknown) => void) | undefined;
		postMock.mockImplementation((path: string) =>
			path === "/api/v1/sessions"
				? new Promise((resolve) => {
						resolveLaunch = resolve;
					})
				: Promise.resolve({ data: {}, error: undefined }),
		);
		const candidate = worker({
			prs: [openPr],
			previewUrl: "http://127.0.0.1/api/v1/sessions/worker-1/preview/files/docs/cache-policy.md",
		});

		renderBoard([candidate], true);
		renderBoard([candidate], true);

		await waitFor(() => {
			const launches = postMock.mock.calls.filter(([path]) => path === "/api/v1/sessions");
			expect(launches).toHaveLength(1);
		});
		resolveLaunch?.({ data: { session: { id: "review-helper-1" } }, error: undefined });
		await waitFor(() => expect(resolveLaunch).toBeDefined());
	});

	it("keeps a draft without a concrete decision out of the review-card deck", () => {
		renderBoard([worker({ status: "draft", prs: [{ ...openPr, state: "draft" }] })]);

		expect(screen.getByText("No decision needed right now")).toBeInTheDocument();
		expect(screen.queryByText(/couldn't retrieve the exact review question/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/review.*now|leave.*draft|keep waiting/i)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Flip Choose cache policy to answer" })).not.toBeInTheDocument();
	});
});
