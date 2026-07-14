import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OperatorAttentionPage } from "./OperatorAttentionPage";

const { navigateMock, openMock, useOperatorAttentionQueryMock, getMock, postMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
	openMock: vi.fn(),
	useOperatorAttentionQueryMock: vi.fn(),
	getMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));
vi.mock("../hooks/useOperatorAttentionQuery", () => ({
	useOperatorAttentionQuery: () => useOperatorAttentionQueryMock(),
	operatorAttentionQueryKey: ["operator-attention"],
}));
vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock, POST: postMock },
	apiErrorMessage: (error: unknown, fallback = "Request failed") => {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error) {
			return String((error as { message: unknown }).message);
		}
		return fallback;
	},
}));

function renderWithQuery(children: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

const questionItem = {
	id: "session:ao-1:decision",
	kind: "decision" as const,
	projectId: "ao",
	sessionId: "ao-1",
	sessionTitle: "Deploy question",
	reason: "Session is waiting on an operator decision.",
	action: "Answer the session question.",
	deepLink: "/projects/ao/sessions/ao-1",
	decisionKind: "question" as const,
	question: "Deploy now?",
	updatedAt: "2026-07-11T03:20:00Z",
};

beforeEach(() => {
	navigateMock.mockReset();
	openMock.mockReset();
	getMock.mockReset();
	postMock.mockReset();
	Object.defineProperty(window, "open", { configurable: true, value: openMock });
});

describe("OperatorAttentionPage", () => {
	it("renders waiting items and opens the correct clearing surface", async () => {
		useOperatorAttentionQueryMock.mockReturnValue({
			data: [
				{
					id: "session:ao-1:decision",
					kind: "decision",
					projectId: "ao",
					sessionId: "ao-1",
					sessionTitle: "Deploy question",
					reason: "Session is waiting on an operator decision.",
					action: "Answer the session question.",
					deepLink: "/projects/ao/sessions/ao-1",
					decisionKind: "question",
					question: "Deploy now?",
					updatedAt: "2026-07-11T03:20:00Z",
				},
				{
					id: "pr:224:merge",
					kind: "pr",
					projectId: "ao",
					sessionId: "ao-2",
					prNumber: 224,
					prTitle: "Waiting view",
					prUrl: "https://github.com/aoagents/agent-orchestrator/pull/224",
					reason: "PR is locally mergeable and waiting for operator merge authority.",
					action: "Merge the pull request.",
					deepLink: "https://github.com/aoagents/agent-orchestrator/pull/224",
					updatedAt: "2026-07-11T03:21:00Z",
				},
			],
			isError: false,
		});
		const user = userEvent.setup();
		render(<OperatorAttentionPage />);

		expect(screen.getByText("Waiting on you")).toBeInTheDocument();
		expect(screen.getAllByText("Deploy question").length).toBeGreaterThan(0);
		expect(screen.getAllByText("#224 Waiting view").length).toBeGreaterThan(0);

		await user.click(screen.getAllByText("Deploy question")[0].closest("button")!);
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "ao", sessionId: "ao-1" },
		});

		await user.click(screen.getAllByText("#224 Waiting view")[0].closest("button")!);
		expect(openMock).toHaveBeenCalledWith(
			"https://github.com/aoagents/agent-orchestrator/pull/224",
			"_blank",
			"noopener,noreferrer",
		);
	});

	it("renders the explicit empty state", () => {
		useOperatorAttentionQueryMock.mockReturnValue({ data: [], isError: false });
		render(<OperatorAttentionPage />);
		expect(screen.getByText("Nothing is waiting on you.")).toBeInTheDocument();
	});

	it("keeps stale waiting items visible during a refetch error", () => {
		useOperatorAttentionQueryMock.mockReturnValue({
			data: [
				{
					id: "session:ao-1:decision",
					kind: "decision",
					projectId: "ao",
					sessionId: "ao-1",
					sessionTitle: "Deploy question",
					reason: "Session is waiting on an operator decision.",
					action: "Answer the session question.",
					deepLink: "/projects/ao/sessions/ao-1",
					decisionKind: "question",
					question: "Deploy now?",
					updatedAt: "2026-07-11T03:20:00Z",
				},
			],
			isError: true,
		});
		render(<OperatorAttentionPage />);
		expect(screen.getAllByText("Deploy question").length).toBeGreaterThan(0);
		expect(screen.queryByText("Could not load waiting items.")).not.toBeInTheDocument();
	});

	it("does not expose click actions for sessionless items without a safe link", async () => {
		useOperatorAttentionQueryMock.mockReturnValue({
			data: [
				{
					id: "notification:n-mainci:operator",
					kind: "main_ci_red",
					projectId: "ao",
					sessionTitle: "Main CI red",
					reason: "Main-branch CI is failing.",
					action: "Fix main-branch CI.",
					updatedAt: "2026-07-12T03:20:00Z",
				},
			],
			isError: false,
		});
		const user = userEvent.setup();
		render(<OperatorAttentionPage />);

		const card = screen.getByRole("button", { name: /Main CI red/i });
		expect(card).toBeDisabled();
		await user.click(card);
		expect(navigateMock).not.toHaveBeenCalled();
		expect(openMock).not.toHaveBeenCalled();
		for (const action of screen.getAllByRole("button", { name: /Fix main-branch CI/i })) {
			expect(action).toBeDisabled();
		}
	});
});

describe("OperatorAttentionPage decision answering", () => {
	it("answers a question decision by selecting an option and posts to the decision endpoint", async () => {
		useOperatorAttentionQueryMock.mockReturnValue({ data: [questionItem], isError: false });
		getMock.mockResolvedValue({
			data: { kind: "question", question: "Deploy now?", options: ["Yes", "No"], sessionId: "ao-1", revision: "rev-a" },
		});
		postMock.mockResolvedValue({ data: { ok: true, sessionId: "ao-1" } });
		const user = userEvent.setup();
		renderWithQuery(<OperatorAttentionPage />);

		// Answer control is offered for question decisions.
		await user.click(screen.getAllByRole("button", { name: /^Answer$/i })[0]);

		await waitFor(() => expect(screen.getAllByRole("button", { name: /1\. Yes/ }).length).toBeGreaterThan(0));
		await user.click(screen.getAllByRole("button", { name: /1\. Yes/ })[0]);

		await waitFor(() => expect(postMock).toHaveBeenCalled());
		const call = postMock.mock.calls[0];
		expect(call[0]).toBe("/api/v1/sessions/{sessionId}/decision");
		expect(call[1]).toMatchObject({ params: { path: { sessionId: "ao-1" } }, body: { option: 1, revision: "rev-a" } });
	});

	it("surfaces a not-answerable (409) error instead of swallowing it", async () => {
		useOperatorAttentionQueryMock.mockReturnValue({ data: [questionItem], isError: false });
		getMock.mockResolvedValue({
			data: { kind: "question", question: "Deploy now?", options: ["Yes"], sessionId: "ao-1", revision: "rev-a" },
		});
		postMock.mockResolvedValue({
			error: {
				code: "SESSION_DECISION_NOT_ANSWERABLE",
				message: "Pending permission decisions cannot be answered programmatically",
			},
		});
		const user = userEvent.setup();
		renderWithQuery(<OperatorAttentionPage />);

		await user.click(screen.getAllByRole("button", { name: /^Answer$/i })[0]);
		await waitFor(() => expect(screen.getAllByRole("button", { name: /1\. Yes/ }).length).toBeGreaterThan(0));
		await user.click(screen.getAllByRole("button", { name: /1\. Yes/ })[0]);

		await waitFor(() => expect(screen.getAllByText(/cannot be answered programmatically/i).length).toBeGreaterThan(0));
	});

	it("does not offer an answer control for permission decisions", () => {
		useOperatorAttentionQueryMock.mockReturnValue({
			data: [{ ...questionItem, decisionKind: "permission", question: "Claude needs your permission" }],
			isError: false,
		});
		renderWithQuery(<OperatorAttentionPage />);

		expect(screen.queryByRole("button", { name: /^Answer$/i })).not.toBeInTheDocument();
	});

	it("keeps a stale question item display-only when the live decision is now a permission prompt", async () => {
		// The attention item still says question, but the session has since moved
		// on to a permission dialog: the LIVE fetched decision wins, and no answer
		// controls may render (permission prompts are display-only by contract).
		useOperatorAttentionQueryMock.mockReturnValue({ data: [questionItem], isError: false });
		getMock.mockResolvedValue({
			data: { kind: "permission", question: "Claude needs your permission", sessionId: "ao-1" },
		});
		const user = userEvent.setup();
		renderWithQuery(<OperatorAttentionPage />);

		await user.click(screen.getAllByRole("button", { name: /^Answer$/i })[0]);

		await waitFor(() => expect(screen.getAllByText(/attend in the/i).length).toBeGreaterThan(0));
		expect(screen.queryByRole("button", { name: /^1\./ })).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Free-text answer")).not.toBeInTheDocument();
		expect(postMock).not.toHaveBeenCalled();
	});

	it("drops the fetched decision after answering so a follow-up question is fetched fresh", async () => {
		useOperatorAttentionQueryMock.mockReturnValue({ data: [questionItem], isError: false });
		getMock.mockResolvedValue({
			data: { kind: "question", question: "Deploy now?", options: ["Yes", "No"], sessionId: "ao-1", revision: "rev-a" },
		});
		postMock.mockResolvedValue({ data: { ok: true, sessionId: "ao-1" } });
		const user = userEvent.setup();
		renderWithQuery(<OperatorAttentionPage />);

		await user.click(screen.getAllByRole("button", { name: /^Answer$/i })[0]);
		await waitFor(() => expect(screen.getAllByRole("button", { name: /1\. Yes/ }).length).toBeGreaterThan(0));
		const decisionFetches = () =>
			getMock.mock.calls.filter((call) => call[0] === "/api/v1/sessions/{sessionId}/decision").length;
		const fetchesBeforeAnswer = decisionFetches();
		await user.click(screen.getAllByRole("button", { name: /1\. Yes/ })[0]);
		await waitFor(() => expect(postMock).toHaveBeenCalled());

		// Panel closed on success; re-opening the (still-listed) item must fetch
		// the decision AGAIN — the consumed one was removed from the cache.
		await user.click(screen.getAllByRole("button", { name: /^Answer$/i })[0]);
		await waitFor(() => expect(decisionFetches()).toBeGreaterThan(fetchesBeforeAnswer));
	});
});
