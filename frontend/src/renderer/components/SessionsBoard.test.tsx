import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

vi.mock("../lib/shell-context", () => ({
	useShell: () => ({ daemonStatus: { state: "ready" } }),
}));

vi.mock("./OrchestratorReviewBoard", () => ({
	OrchestratorReviewBoard: ({
		backgroundOnly,
		orchestrator,
	}: {
		backgroundOnly?: boolean;
		orchestrator: { id: string };
	}) => (
		<section
			aria-label={backgroundOnly ? "Background reviewer" : "Review decisions panel"}
			data-orchestrator={orchestrator.id}
		>
			Review decisions
		</section>
	),
}));

vi.mock("./AutoBypassToggle", () => ({
	AutoBypassToggle: () => <button type="button">Auto bypass</button>,
}));

vi.mock("./RepositoryStewardCard", () => ({
	RepositoryStewardCard: () => <section aria-label="Repository steward">Repository steward</section>,
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
		expect(screen.getByText("Task board")).toBeInTheDocument();
		expect(screen.getByRole("region", { name: "Board overview" })).toBeInTheDocument();
		expect(screen.getByRole("region", { name: "Working: 1 session" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Auto bypass" })).toBeInTheDocument();
		expect(screen.getByRole("region", { name: "Repository steward" })).toBeInTheDocument();
	});

	it("opens review decisions from the In review lane", () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "p1",
					name: "radic",
					path: "/tmp/radic",
					sessions: [
						{
							id: "p1-orchestrator",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "Orbit",
							provider: "codex",
							kind: "orchestrator",
							status: "working",
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
						{
							id: "s1",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "Choose release policy",
							provider: "codex",
							kind: "worker",
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

		expect(screen.getByRole("region", { name: "Background reviewer" })).toBeInTheDocument();
		const inReview = screen.getByRole("region", { name: "In review: 0 sessions" });
		fireEvent.click(within(inReview).getByRole("button", { name: "Review decisions" }));

		expect(screen.getByRole("dialog")).toBeInTheDocument();
		const review = screen.getByRole("region", { name: "Review decisions panel" });
		expect(review).toHaveAttribute("data-orchestrator", "p1-orchestrator");
		expect(screen.getByRole("region", { name: "Background reviewer", hidden: true })).toBeInTheDocument();
	});
});
