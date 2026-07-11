import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OperatorAttentionPage } from "./OperatorAttentionPage";

const { navigateMock, openMock, useOperatorAttentionQueryMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
	openMock: vi.fn(),
	useOperatorAttentionQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));
vi.mock("../hooks/useOperatorAttentionQuery", () => ({
	useOperatorAttentionQuery: () => useOperatorAttentionQueryMock(),
}));

beforeEach(() => {
	navigateMock.mockReset();
	openMock.mockReset();
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
});
