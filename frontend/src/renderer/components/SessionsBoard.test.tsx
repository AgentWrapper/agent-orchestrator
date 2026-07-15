import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigateMock, workspaceQueryMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
	workspaceQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
}));

vi.mock("../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: workspaceQueryMock,
}));

import { SessionsBoard } from "./SessionsBoard";

function renderBoard(projectId?: string) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={queryClient}>
			<SessionsBoard projectId={projectId} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	navigateMock.mockReset();
	workspaceQueryMock.mockReset().mockReturnValue({ data: [], isError: false });
});

describe("SessionsBoard", () => {
	it("does not show an agent setup warning on the board", () => {
		renderBoard();

		expect(screen.queryByText(/reload agents/i)).not.toBeInTheDocument();
	});

	it("labels an idle session as Idle, not Working", () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "p1",
					name: "radic",
					path: "/tmp/radic",
					sessions: [
						{
							id: "s1",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "brand-font-pipeline",
							provider: "claude-code",
							branch: "ao/radic-5",
							status: "idle",
							activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
					],
				},
			],
			isError: false,
		});

		renderBoard("p1");

		expect(screen.getByText("Idle")).toBeInTheDocument();
	});

	it("renders idle activity in the working column with passive styling", () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "p1",
					name: "radic",
					path: "/tmp/radic",
					sessions: [
						{
							id: "s1",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "brand-font-pipeline",
							provider: "claude-code",
							branch: "ao/radic-5",
							status: "working",
							activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
					],
				},
			],
			isError: false,
		});

		renderBoard("p1");

		expect(screen.getAllByText("Working").length).toBeGreaterThan(0);
		const badge = screen.getByText("Idle").closest("span");
		expect(badge).toHaveClass("text-passive");
		expect(badge).not.toHaveClass("text-working");
	});

	it("shows session ids on duplicate-titled board cards and terminated chips", () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "p1",
					name: "radic",
					path: "/tmp/radic",
					sessions: [
						{
							id: "radic-3",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "Verify the nav fix",
							provider: "claude-code",
							branch: "ao/verify-nav",
							status: "terminated",
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
						{
							id: "radic-4",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "Verify the nav fix",
							provider: "claude-code",
							branch: "ao/verify-nav",
							status: "needs_input",
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
					],
				},
			],
			isError: false,
		});

		renderBoard("p1");

		expect(screen.getByText("radic-4")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /done \/ terminated/i }));
		expect(screen.getByText("radic-3")).toBeInTheDocument();
		expect(screen.getAllByText("Verify the nav fix")).toHaveLength(2);
	});
});
