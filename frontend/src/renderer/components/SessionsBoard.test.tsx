import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigateMock, workspaceQueryMock, agentsQueryMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
	workspaceQueryMock: vi.fn(),
	agentsQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
}));

vi.mock("../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: workspaceQueryMock,
}));

vi.mock("../hooks/useAgentsQuery", () => ({
	agentsQueryKey: ["agents"],
	useAgentsQuery: agentsQueryMock,
}));

import { SessionsBoard } from "./SessionsBoard";

function renderBoard() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
	render(<QueryClientProvider client={queryClient}><SessionsBoard /></QueryClientProvider>);
	return { invalidateSpy };
}

beforeEach(() => {
	navigateMock.mockReset();
	workspaceQueryMock.mockReset().mockReturnValue({ data: [], isError: false });
	agentsQueryMock.mockReset().mockReturnValue({
		data: { supported: [], installed: [], authorized: [] },
		isFetching: false,
		isLoading: false,
	});
});

describe("SessionsBoard", () => {
	it("shows an agent setup warning when no agents are authorized", async () => {
		const { invalidateSpy } = renderBoard();

		expect(screen.getByText("Install and log in to a supported agent, then reload agents.")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Reload agents" }));

		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["agents"] });
	});

	it("names installed agents that need login", () => {
		agentsQueryMock.mockReturnValue({
			data: {
				supported: [
					{ id: "cursor", label: "Cursor" },
					{ id: "opencode", label: "opencode" },
					{ id: "copilot", label: "GitHub Copilot" },
				],
				installed: [
					{ id: "cursor", label: "Cursor", authStatus: "unknown" },
					{ id: "opencode", label: "opencode", authStatus: "unauthorized" },
					{ id: "copilot", label: "GitHub Copilot", authStatus: "unknown" },
				],
				authorized: [],
			},
			isFetching: false,
			isLoading: false,
		});

		renderBoard();

		expect(screen.getByText("Log in to Cursor, GitHub Copilot, and opencode, then reload agents.")).toBeInTheDocument();
	});

	it("hides the agent setup warning when an agent is authorized", () => {
		agentsQueryMock.mockReturnValue({
			data: {
				supported: [{ id: "codex", label: "Codex" }],
				installed: [{ id: "codex", label: "Codex", authStatus: "authorized" }],
				authorized: [{ id: "codex", label: "Codex", authStatus: "authorized" }],
			},
			isFetching: false,
			isLoading: false,
		});

		renderBoard();

		expect(screen.queryByText("Install and log in to a supported agent, then reload agents.")).not.toBeInTheDocument();
	});
});
