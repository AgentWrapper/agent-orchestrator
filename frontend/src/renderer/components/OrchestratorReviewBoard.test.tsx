import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "../types/workspace";
import {
	OrchestratorReviewBoard,
	ReviewTaskCard,
	isSpecificReviewQuestion,
	parseReviewTranslations,
	REVIEW_TRANSLATOR_ISSUE_PREFIX,
	reviewAgentPrompt,
	reviewBatchId,
	reviewCandidates,
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

function renderBoard(sessions: WorkspaceSession[], daemonReady = false) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<OrchestratorReviewBoard
				daemonReady={daemonReady}
				orchestrator={orchestrator}
				sessions={[orchestrator, ...sessions]}
				theme="dark"
			/>
		</QueryClientProvider>,
	);
}

function renderCard(card: ReviewCard) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<ReviewTaskCard card={card} index={0} onOpenTask={vi.fn()} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	navigateMock.mockReset();
	getMock.mockReset().mockResolvedValue({ data: { prs: [detailedPr] }, error: undefined });
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
			worker({ id: "stale-draft", status: "draft", prs: [] }),
			worker({ id: "helper", issueId: `${REVIEW_TRANSLATOR_ISSUE_PREFIX}abc` }),
		]);

		expect(candidates.map((candidate) => candidate.id)).toEqual(["worker-1", "ci", "draft", "open"]);
	});

	it("parses the latest valid bounded response from the small review agent", () => {
		const lines = [
			"AO_REVIEW_BOARD_deadbeef_START",
			"not json",
			"AO_REVIEW_BOARD_deadbeef_END",
			"AO_REVIEW_BOARD_deadbeef_START",
			'{"items":[{"sessionId":"worker-1","summary":"The agent needs a cache choice.","question":"Which cache should it use?"}]}',
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
		expect(prompt).toContain("Do not edit files, run tests, send messages, or spawn agents");
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
	});

	it("keeps the eight-card helper prompt within the daemon message limit", () => {
		const candidates = Array.from({ length: 8 }, (_, index) =>
			worker({ id: `worker-${index}`, title: `Cache policy ${"界".repeat(60)}` }),
		);
		const contexts = candidates.map((candidate, index) => ({
			sessionId: candidate.id,
			artifactPath: `docs/${"界".repeat(80)}-${index}.md`,
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

		expect(new TextEncoder().encode(reviewAgentPrompt(candidates, "deadbeef", contexts)).byteLength).toBeLessThanOrEqual(
			4096,
		);
	});

	it("keeps a review batch stable across database-only timestamp refreshes", () => {
		const original = worker({ prs: [openPr] });
		const refreshed = worker({ prs: [openPr], updatedAt: "2026-07-15T11:30:00Z" });

		expect(reviewBatchId([original], 0)).toBe(reviewBatchId([refreshed], 0));
		expect(reviewBatchId([original], 0)).not.toBe(reviewBatchId([worker({ status: "ci_failed", prs: [openPr] })], 0));
		expect(reviewBatchId([original], 0, [{ sessionId: original.id, pullRequests: [], artifactPath: "a.md" }])).not.toBe(
			reviewBatchId([original], 0, [{ sessionId: original.id, pullRequests: [], artifactPath: "b.md" }]),
		);
	});
});

describe("review board", () => {
	it("does not turn missing context into a generic answerable question", async () => {
		const user = userEvent.setup();
		renderBoard([worker()]);

		expect(screen.getByText('AO couldn\'t retrieve the exact review question for “Choose cache policy.”')).toBeInTheDocument();
		expect(screen.getByText("Exact question unavailable")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Flip Choose cache policy to answer" })).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Your answer")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Send answer/i })).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Open task" }));
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "proj-1", sessionId: "worker-1" },
		});
	});

	it("flips a concrete decision card and sends the answer to its worker", async () => {
		const user = userEvent.setup();
		renderCard({
			sessionId: "worker-1",
			summary: "The cache policy must choose one ownership model.",
			question: "Should cache entries be shared across workers or isolated per worker?",
			reason: "Concrete acceptance decision",
			session: worker(),
		});

		await user.click(screen.getByRole("button", { name: "Flip Choose cache policy to answer" }));
		await user.type(screen.getByLabelText("Your answer"), "Use the shared cache and document the tradeoff.");
		await user.click(screen.getByRole("button", { name: /Send answer/i }));

		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/send", {
				params: { path: { sessionId: "worker-1" } },
				body: { message: "Use the shared cache and document the tradeoff." },
			}),
		);
		expect(await screen.findByText("Answer sent")).toBeInTheDocument();
	});

	it("starts one low-effort helper with the project's worker agent without changing the orchestrator conversation", async () => {
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
				displayName: "Review helper",
				agentConfig: { reasoningEffort: "low" },
			},
		});
		expect(postMock.mock.calls[0]?.[1]?.body).not.toHaveProperty("harness");
		expect(postMock.mock.calls[0]?.[1]?.body.prompt).toContain("Choose shared-cache eviction semantics");
		expect(postMock.mock.calls[0]?.[1]?.body.prompt).toContain("docs/cache-policy.md");
	});

	it("never offers review-now or leave-waiting choices for a draft", () => {
		renderBoard([worker({ status: "draft", prs: [{ ...openPr, state: "draft" }] })]);

		expect(screen.getByText('AO couldn\'t retrieve the exact review question for “Choose cache policy.”')).toBeInTheDocument();
		expect(screen.queryByText(/review.*now|leave.*draft|keep waiting/i)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Flip Choose cache policy to answer" })).not.toBeInTheDocument();
	});
});
