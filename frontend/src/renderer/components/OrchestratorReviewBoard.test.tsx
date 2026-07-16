import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "../types/workspace";
import {
	OrchestratorReviewBoard,
	parseReviewTranslations,
	REVIEW_TRANSLATOR_ISSUE_PREFIX,
	reviewAgentPrompt,
	reviewCandidates,
} from "./OrchestratorReviewBoard";

const { navigateMock, postMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { POST: (...args: unknown[]) => postMock(...args) },
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

beforeEach(() => {
	navigateMock.mockReset();
	postMock.mockReset().mockResolvedValue({ data: { session: { id: "review-helper-1" } }, error: undefined });
});

describe("review selection and translation", () => {
	it("keeps only worker sessions that need a human review", () => {
		const candidates = reviewCandidates([
			orchestrator,
			worker(),
			worker({ id: "working", status: "working" }),
			worker({ id: "ci", status: "ci_failed" }),
			worker({ id: "helper", issueId: `${REVIEW_TRANSLATOR_ISSUE_PREFIX}abc` }),
		]);

		expect(candidates.map((candidate) => candidate.id)).toEqual(["worker-1", "ci"]);
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

	it("gives the helper a translation-only, no-edit brief", () => {
		const prompt = reviewAgentPrompt([worker()], "deadbeef");
		expect(prompt).toContain("do not implement work, edit files, run commands, or spawn agents");
		expect(prompt).toContain("one direct question");
		expect(prompt).toContain('"sessionId":"worker-1"');
	});
});

describe("review board", () => {
	it("shows a centered decision card that flips and sends the answer to its worker", async () => {
		const user = userEvent.setup();
		renderBoard([worker()]);

		expect(screen.getByText("This agent has paused because it needs a decision or more direction.")).toBeInTheDocument();
		expect(screen.getAllByText("What should this agent do next?").length).toBeGreaterThan(0);

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

	it("starts one low-effort review helper without changing the orchestrator conversation", async () => {
		renderBoard([worker()], true);

		await waitFor(() => expect(postMock).toHaveBeenCalled());
		expect(postMock.mock.calls[0]?.[0]).toBe("/api/v1/sessions");
		expect(postMock.mock.calls[0]?.[1]).toMatchObject({
			body: {
				projectId: "proj-1",
				kind: "worker",
				harness: "claude-code",
				displayName: "Review helper",
				agentConfig: { reasoningEffort: "low" },
			},
		});
	});
});
