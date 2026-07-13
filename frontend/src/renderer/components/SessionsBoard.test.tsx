import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
});
