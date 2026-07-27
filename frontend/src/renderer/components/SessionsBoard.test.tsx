import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";

const { navigateMock, notificationShowMock, postMock, workspaceQueryMock, boardActionsInPanelMock } = vi.hoisted(
	() => ({
		navigateMock: vi.fn(),
		notificationShowMock: vi.fn(),
		postMock: vi.fn(),
		workspaceQueryMock: vi.fn(),
		boardActionsInPanelMock: vi.fn(() => false),
	}),
);

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
}));

vi.mock("../hooks/useWorkspaceQuery", () => ({
	workspaceQueryKey: ["workspaces"],
	useWorkspaceQuery: workspaceQueryMock,
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { POST: (...args: unknown[]) => postMock(...args) },
	apiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		clipboard: {
			writeText: vi.fn(),
		},
		notifications: {
			show: (...args: unknown[]) => notificationShowMock(...args),
		},
	},
}));

vi.mock("../lib/platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/platform")>();
	return {
		...actual,
		usesBoardActionsInPanel: () => boardActionsInPanelMock(),
		isLinuxPlatform: () => false,
	};
});

import { SessionsBoard } from "./SessionsBoard";
import { TooltipProvider } from "./ui/tooltip";

function renderBoard(projectId?: string) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	renderBoardWithClient(queryClient, projectId);
	return queryClient;
}

/** Cards render in one flat list per column, so order is the only grouping signal. */
function cardSessionIds(column: HTMLElement): string[] {
	return within(column)
		.queryAllByTestId("board-session-card")
		.map((card) => card.getAttribute("data-session-id") ?? "");
}

function renderBoardWithClient(queryClient: QueryClient, projectId?: string) {
	return render(
		<QueryClientProvider client={queryClient}>
			<TooltipProvider delayDuration={0}>
				<SessionsBoard projectId={projectId} />
			</TooltipProvider>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	navigateMock.mockReset();
	notificationShowMock.mockReset().mockResolvedValue(undefined);
	postMock.mockReset().mockResolvedValue({ data: {} });
	workspaceQueryMock.mockReset().mockReturnValue({ data: [], isError: false });
	window.localStorage.removeItem("ao.board.archive.layout");
	boardActionsInPanelMock.mockReset().mockReturnValue(false);
});

describe("SessionsBoard", () => {
	it("does not show an agent setup warning on the board", () => {
		renderBoard();

		expect(screen.queryByText(/reload agents/i)).not.toBeInTheDocument();
	});

	it("keeps in-panel board identity and actions compact", async () => {
		boardActionsInPanelMock.mockReturnValue(true);
		workspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "p1",
					name: "solkit-ui",
					path: "/tmp/solkit-ui",
					sessions: [
						{
							id: "s1",
							workspaceId: "p1",
							workspaceName: "solkit-ui",
							title: "test",
							provider: "codex",
							branch: "ao/dev/solkit-ui-5/root",
							status: "running",
							activity: { state: "working", lastActivityAt: "2026-01-01T00:00:00Z" },
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
					],
				},
			],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		expect(screen.getByText("Board")).toBeInTheDocument();
		expect(screen.queryByText("solkit-ui")).not.toBeInTheDocument();
		const newTask = screen.getByRole("button", { name: "New task" });
		expect(newTask).toHaveClass("reverb-topbar__control--icon");
		expect(newTask.textContent).toBe("");
		await userEvent.hover(newTask);
		expect(await screen.findByRole("tooltip")).toHaveTextContent("New task");
	});

	it.each([
		["active", "Working"],
		["idle", "Idle"],
	] as const)("names %s orchestrator activity on the in-panel board toolbar control", (state, label) => {
		boardActionsInPanelMock.mockReturnValue(true);
		workspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "p1",
					name: "solkit-ui",
					path: "/tmp/solkit-ui",
					sessions: [
						{
							id: "orch-1",
							workspaceId: "p1",
							workspaceName: "solkit-ui",
							title: "orchestrator",
							provider: "codex",
							kind: "orchestrator",
							branch: "main",
							status: "working",
							activity: { state, lastActivityAt: "2026-01-01T00:00:00Z" },
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
					],
				},
			],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		// Activity now reaches assistive tech through the control's name only; the
		// center context pill that used to show it is gone.
		const button = screen.getByRole("button", { name: `Orchestrator, ${label}` });
		expect(button).toHaveClass("reverb-topbar__control--icon");
		expect(button.textContent).toBe("");
		expect(screen.queryByText(label)).not.toBeInTheDocument();
	});

	it("shows the Board crumb on the root board when actions live in the panel", () => {
		boardActionsInPanelMock.mockReturnValue(true);
		workspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "p1",
					name: "solkit-ui",
					path: "/tmp/solkit-ui",
					sessions: [],
				},
			],
			isError: false,
			isSuccess: true,
		});

		renderBoard();

		expect(screen.getByText("Board")).toBeInTheDocument();
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

		const idleCard = screen
			.getByText("brand-font-pipeline")
			.closest('[data-testid="board-session-card"]') as HTMLElement;
		// The Idle lane header already names the stage, so the card omits a redundant
		// "Idle" pill — and must never mislabel the idle session as Working.
		expect(within(idleCard).queryByText("Idle")).toBeNull();
		expect(within(idleCard).queryByText("Working")).toBeNull();
		expect(screen.getByRole("region", { name: "Idle sessions" })).toContainElement(idleCard);
		const terminateButton = within(idleCard).getByRole("button", { name: "Terminate brand-font-pipeline" });
		expect(terminateButton).toHaveClass("opacity-0", "group-hover:opacity-100", "group-focus-within:opacity-100");
		expect(terminateButton.querySelector("svg")).toHaveClass("lucide-trash-2");
		expect(within(idleCard).getByText("brand-font-pipeline")).toHaveClass("font-semibold", "line-clamp-2");
	});

	it("omits the status pill on cards since the column names the stage", () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "p1",
					name: "radic",
					path: "/tmp/radic",
					sessions: [
						{
							id: "s0",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "idle-card-task",
							provider: "claude-code",
							branch: "ao/radic-5",
							status: "idle",
							activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
						{
							id: "s1",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "no-signal-card-task",
							provider: "claude-code",
							branch: "ao/radic-6",
							status: "no_signal",
							activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
						{
							id: "s2",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "draft-card-task",
							provider: "claude-code",
							branch: "ao/radic-7",
							status: "draft",
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
		const idleCard = screen.getByText("idle-card-task").closest('[data-testid="board-session-card"]') as HTMLElement;
		const noSignalCard = screen
			.getByText("no-signal-card-task")
			.closest('[data-testid="board-session-card"]') as HTMLElement;
		const draftCard = screen.getByText("draft-card-task").closest('[data-testid="board-session-card"]') as HTMLElement;

		// The column header names the stage, so cards never repeat a status pill —
		// idle, no-signal and draft alike carry no status word.
		expect(within(idleCard).queryByText("Idle")).toBeNull();
		expect(within(noSignalCard).queryByText("No signal")).toBeNull();
		expect(within(draftCard).queryByText("Draft PR")).toBeNull();
	});

	it("places an exited live session in Needs you", () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				workspaceWithSessions([
					{
						id: "s-exited",
						workspaceId: "p1",
						workspaceName: "radic",
						title: "agent-exited-task",
						provider: "codex",
						branch: "ao/exited",
						status: "exited",
						activity: { state: "exited", lastActivityAt: "2026-01-01T00:00:00Z" },
						updatedAt: "2026-01-01T00:00:00Z",
						prs: [],
					},
				]),
			],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		const needsYouColumn = screen.getByText("Needs you").closest("section") as HTMLElement;
		expect(needsYouColumn.firstElementChild).toHaveClass("h-9");
		expect(within(needsYouColumn).getByText("agent-exited-task")).toBeInTheDocument();
		expect(within(needsYouColumn).queryByText("Exited")).toBeNull();
	});

	it("orders working sessions above idle ones in a single column list", () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				workspaceWithSessions([
					boardSession({
						id: "s-active",
						title: "active-task",
						status: "working",
						activity: { state: "active", lastActivityAt: "2026-01-01T00:00:00Z" },
					}),
					boardSession({
						id: "s-idle-1",
						title: "idle-no-pr-task",
						status: "idle",
						activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
					}),
					boardSession({
						id: "s-idle-2",
						title: "second-idle-task",
						status: "idle",
						activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
					}),
					boardSession({
						id: "s-review",
						title: "idle-with-pr-task",
						status: "pr_open",
						activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
						prs: [
							{
								number: 7,
								url: "https://github.com/acme/radic/pull/7",
								state: "open",
								ci: "unknown",
								review: "none",
								mergeability: "unknown",
								reviewComments: false,
								updatedAt: "2026-01-01T00:00:00Z",
							},
						],
					}),
				]),
			],
			isError: false,
		});

		renderBoard("p1");

		const workLane = screen.getByRole("region", { name: "Working sessions" });
		const reviewRegion = screen.getByRole("region", { name: "In review sessions" });
		const workHeader = workLane.firstElementChild as HTMLElement;

		expect(workHeader).toHaveClass("h-9");
		expect(workHeader.firstElementChild).toHaveClass("rounded-swatch");
		expect(within(workHeader).getByText("Working")).toBeInTheDocument();
		// One count for the whole column now that idle has no section of its own.
		expect(within(workHeader).getByLabelText("3 working sessions")).toHaveTextContent("3");
		expect(screen.queryByRole("button", { name: /idle sessions/i })).not.toBeInTheDocument();
		expect(workLane.querySelectorAll(".overflow-y-auto")).toHaveLength(1);
		// Working leads so attention lands on live work first; idle settles below.
		expect(cardSessionIds(workLane)).toEqual(["s-active", "s-idle-1", "s-idle-2"]);
		expect(within(reviewRegion).getByText("idle-with-pr-task")).toBeInTheDocument();
		expect(within(workLane).queryByText("idle-with-pr-task")).not.toBeInTheDocument();

		const idleCard = screen.getByText("idle-no-pr-task").closest('[data-testid="board-session-card"]') as HTMLElement;
		// Under the Idle lane the card drops its redundant status pill and must not
		// fall back to a Working label.
		expect(within(idleCard).queryByText("Idle")).toBeNull();
		expect(within(idleCard).queryByText("Working")).toBeNull();
	});

	it("uses one shared scrollbar for the whole work column", () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				workspaceWithSessions([
					boardSession({
						id: "s-idle",
						title: "single-idle-task",
						status: "idle",
						activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
					}),
					...Array.from({ length: 7 }, (_, index) =>
						boardSession({
							id: `s-working-${index + 1}`,
							title: `working-task-${index + 1}`,
							status: "working",
							activity: { state: "active", lastActivityAt: "2026-01-01T00:00:00Z" },
						}),
					),
				]),
			],
			isError: false,
		});

		renderBoard("p1");

		const workLane = screen.getByRole("region", { name: "Working sessions" });
		const laneScrollers = Array.from(workLane.querySelectorAll<HTMLElement>(".overflow-y-auto"));

		expect(laneScrollers).toHaveLength(1);
		expect(laneScrollers[0]).toHaveClass("board-scrollbar", "overflow-y-auto");
		expect(within(laneScrollers[0]).getAllByTestId("board-session-card")).toHaveLength(8);
		// The single idle session trails the seven working ones.
		expect(cardSessionIds(workLane).at(-1)).toBe("s-idle");
	});

	it("shows an idle-only work column without any section chrome", () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				workspaceWithSessions([
					boardSession({
						id: "s-idle",
						title: "idle-task",
						status: "idle",
						activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
					}),
				]),
			],
			isError: false,
		});

		renderBoard("p1");

		const workLane = screen.getByRole("region", { name: "Working sessions" });
		expect(within(workLane).getByLabelText("1 working session")).toHaveTextContent("1");
		expect(within(workLane).getByText("idle-task")).toBeInTheDocument();
		// No "Idle" sub-header competing with the column header above it.
		expect(within(workLane).queryByText("Idle sessions")).not.toBeInTheDocument();
		expect(cardSessionIds(workLane)).toEqual(["s-idle"]);
	});

	it("shows a working-only column with a single scroller", () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				workspaceWithSessions([
					boardSession({
						id: "s-working-1",
						title: "first-working-task",
						status: "working",
						activity: { state: "active", lastActivityAt: "2026-01-01T00:00:00Z" },
					}),
					boardSession({
						id: "s-working-2",
						title: "second-working-task",
						status: "working",
						activity: { state: "active", lastActivityAt: "2026-01-01T00:00:00Z" },
					}),
				]),
			],
			isError: false,
		});

		renderBoard("p1");

		const workLane = screen.getByRole("region", { name: "Working sessions" });
		expect(within(workLane).getByLabelText("2 working sessions")).toHaveTextContent("2");
		expect(workLane.querySelectorAll(".overflow-y-auto")).toHaveLength(1);
		expect(cardSessionIds(workLane)).toEqual(["s-working-1", "s-working-2"]);
	});

	it("keeps idle and working cards visible when navigating between project boards", () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		workspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "p1",
					name: "radic",
					path: "/tmp/radic",
					sessions: [
						{
							id: "p1-active",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "p1 active",
							provider: "claude-code",
							branch: "ao/radic-active",
							status: "working",
							activity: { state: "active", lastActivityAt: "2026-01-01T00:00:00Z" },
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
						{
							id: "p1-idle",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "p1 idle",
							provider: "claude-code",
							branch: "ao/radic-idle",
							status: "idle",
							activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
					],
				},
				{
					id: "p2",
					name: "other",
					path: "/tmp/other",
					sessions: [
						{
							id: "p2-active",
							workspaceId: "p2",
							workspaceName: "other",
							title: "p2 active",
							provider: "claude-code",
							branch: "ao/other-active",
							status: "working",
							activity: { state: "active", lastActivityAt: "2026-01-01T00:00:00Z" },
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
						{
							id: "p2-idle",
							workspaceId: "p2",
							workspaceName: "other",
							title: "p2 idle",
							provider: "claude-code",
							branch: "ao/other-idle",
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
		const view = renderBoardWithClient(queryClient, "p1");

		const p1Lane = screen.getByRole("region", { name: "Working sessions" });
		expect(cardSessionIds(p1Lane)).toEqual(["p1-active", "p1-idle"]);

		view.rerender(
			<QueryClientProvider client={queryClient}>
				<TooltipProvider>
					<SessionsBoard projectId="p2" />
				</TooltipProvider>
			</QueryClientProvider>,
		);

		const p2Lane = screen.getByRole("region", { name: "Working sessions" });
		expect(screen.queryByText("p1 idle")).not.toBeInTheDocument();
		expect(cardSessionIds(p2Lane)).toEqual(["p2-active", "p2-idle"]);
	});

	it("shows a static archive card with a persistent restore action", async () => {
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession()])],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: /archive/i }));

		const archive = screen.getByRole("list", { name: "Archived sessions" });
		expect(archive).toHaveClass("board-scrollbar", "overflow-y-auto");
		const terminatedCard = within(archive).getByText("dead worker").closest<HTMLElement>("[role='listitem']");
		expect(terminatedCard).not.toBeNull();
		expect(within(terminatedCard!).queryByRole("button", { name: "Open dead worker" })).not.toBeInTheDocument();
		expect(within(terminatedCard!).getByText("Terminated")).toBeInTheDocument();
		// Agent shown as its brand logo with an accessible name (not a text label).
		expect(within(terminatedCard!).getByRole("img", { name: "claude-code" })).toBeInTheDocument();
		expect(screen.getByText("ao/dead-worker")).toBeInTheDocument();
		expect(screen.getByText("github:INT-17")).toBeInTheDocument();
		const prStatus = screen.getByLabelText("#42 merged");
		expect(prStatus).toHaveTextContent("PR#42merged");
		const divider = terminatedCard!.querySelector(".mx-3.my-px.h-px.bg-border");
		expect(divider).not.toBeNull();
		expect(divider!.compareDocumentPosition(prStatus) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
		expect(
			screen.getByText("ao/dead-worker").compareDocumentPosition(divider!) & Node.DOCUMENT_POSITION_FOLLOWING,
		).not.toBe(0);
		expect(screen.getByRole("button", { name: "Restore dead worker" })).toBeInTheDocument();

		expect(screen.queryByRole("group", { name: "Archive layout" })).not.toBeInTheDocument();
	});

	it("renders archived sessions as a grid even when rows were previously saved", async () => {
		window.localStorage.setItem("ao.board.archive.layout", "rows");
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession()])],
			isError: false,
			isSuccess: true,
		});
		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: /archive/i }));
		expect(screen.queryByRole("group", { name: "Archive layout" })).not.toBeInTheDocument();
		const archive = screen.getByRole("list", { name: "Archived sessions" });
		expect(archive).toHaveClass("grid");
		const restore = screen.getByRole("button", { name: "Restore dead worker" });
		expect(restore.parentElement).toContainElement(screen.getByText("Terminated"));
		expect(screen.queryByRole("button", { name: "Open dead worker" })).not.toBeInTheDocument();
	});

	it("restores a terminated session, refreshes workspace data, and opens the restored terminal", async () => {
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession()])],
			isError: false,
			isSuccess: true,
		});
		const queryClient = renderBoard("p1");
		const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);

		await userEvent.click(screen.getByRole("button", { name: /archive/i }));
		await userEvent.click(screen.getByRole("button", { name: "Restore dead worker" }));

		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/restore", {
				params: { path: { sessionId: "s-dead" } },
			}),
		);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workspaces"] });
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "p1", sessionId: "s-dead" },
		});
	});

	it("shows a toast when restore falls back to a saved-prompt conversation", async () => {
		postMock.mockResolvedValueOnce({ data: { restoreMode: "saved_prompt" } });
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession()])],
			isError: false,
			isSuccess: true,
		});
		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: /archive/i }));
		await userEvent.click(screen.getByRole("button", { name: "Restore dead worker" }));

		await waitFor(() =>
			expect(notificationShowMock).toHaveBeenCalledWith(
				expect.objectContaining({
					title: "Started from saved prompt",
					body: expect.stringContaining("started a new conversation from the saved prompt"),
				}),
			),
		);
	});

	it("does not show a fallback toast when restore uses native resume", async () => {
		postMock.mockResolvedValueOnce({ data: { restoreMode: "native" } });
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession()])],
			isError: false,
			isSuccess: true,
		});
		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: /archive/i }));
		await userEvent.click(screen.getByRole("button", { name: "Restore dead worker" }));

		await waitFor(() => expect(postMock).toHaveBeenCalled());
		expect(notificationShowMock).not.toHaveBeenCalled();
	});

	it("keeps restore actions visible and disables siblings while one session is restoring", async () => {
		let finishRestore: ((value: { data: Record<string, never> }) => void) | undefined;
		postMock.mockReturnValueOnce(
			new Promise((resolve) => {
				finishRestore = resolve;
			}),
		);
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession(), terminatedSession({ id: "s-other", title: "other worker" })])],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: /archive/i }));
		await userEvent.click(screen.getByRole("button", { name: "Restore dead worker" }));

		const restoringButton = screen.getByRole("button", { name: "Restore dead worker" });
		const otherButton = screen.getByRole("button", { name: "Restore other worker" });
		expect(restoringButton.querySelector("svg")).toHaveClass("animate-spin");
		expect(otherButton).toBeDisabled();
		expect(otherButton).not.toHaveClass("opacity-0");

		await act(async () => {
			finishRestore?.({ data: {} });
		});
	});

	it("opens the restore-unavailable dialog when a session is not resumable", async () => {
		postMock.mockResolvedValueOnce({ error: { code: "SESSION_NOT_RESUMABLE" } });
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession()])],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: /archive/i }));
		await userEvent.click(screen.getByRole("button", { name: "Restore dead worker" }));

		expect(await screen.findByText("Session can no longer be restored")).toBeInTheDocument();
	});

	it("shows an archive row error when restore fails", async () => {
		postMock.mockResolvedValueOnce({ error: { code: "RESTORE_FAILED", message: "boom" } });
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession()])],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: /archive/i }));
		await userEvent.click(screen.getByRole("button", { name: "Restore dead worker" }));

		expect(await screen.findByText("Unable to restore session")).toBeInTheDocument();
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("does not navigate when the static archive card is clicked", async () => {
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession()])],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: /archive/i }));
		await userEvent.click(screen.getByText("dead worker"));

		expect(postMock).not.toHaveBeenCalled();
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("ignores restore completion after navigating to another project board", async () => {
		let finishRestore: ((value: { data: Record<string, never> }) => void) | undefined;
		postMock.mockReturnValueOnce(
			new Promise((resolve) => {
				finishRestore = resolve;
			}),
		);
		workspaceQueryMock.mockReturnValue({
			data: [
				workspaceWithSessions([terminatedSession()]),
				{
					id: "p2",
					name: "other",
					path: "/tmp/other",
					sessions: [],
				},
			],
			isError: false,
			isSuccess: true,
		});
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const view = renderBoardWithClient(queryClient, "p1");

		await userEvent.click(screen.getByRole("button", { name: /archive/i }));
		await userEvent.click(screen.getByRole("button", { name: "Restore dead worker" }));

		view.rerender(
			<QueryClientProvider client={queryClient}>
				<TooltipProvider>
					<SessionsBoard projectId="p2" />
				</TooltipProvider>
			</QueryClientProvider>,
		);
		await act(async () => {
			finishRestore?.({ data: {} });
		});

		expect(navigateMock).not.toHaveBeenCalled();
		expect(screen.queryByText("Session can no longer be restored")).not.toBeInTheDocument();
	});

	it("ignores restore-unavailable completion after navigating to another project board", async () => {
		let finishRestore: ((value: { error: { code: string } }) => void) | undefined;
		postMock.mockReturnValueOnce(
			new Promise((resolve) => {
				finishRestore = resolve;
			}),
		);
		workspaceQueryMock.mockReturnValue({
			data: [
				workspaceWithSessions([terminatedSession()]),
				{
					id: "p2",
					name: "other",
					path: "/tmp/other",
					sessions: [],
				},
			],
			isError: false,
			isSuccess: true,
		});
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const view = renderBoardWithClient(queryClient, "p1");

		await userEvent.click(screen.getByRole("button", { name: /archive/i }));
		await userEvent.click(screen.getByRole("button", { name: "Restore dead worker" }));

		view.rerender(
			<QueryClientProvider client={queryClient}>
				<TooltipProvider>
					<SessionsBoard projectId="p2" />
				</TooltipProvider>
			</QueryClientProvider>,
		);
		await act(async () => {
			finishRestore?.({ error: { code: "SESSION_NOT_RESUMABLE" } });
		});

		expect(navigateMock).not.toHaveBeenCalled();
		expect(screen.queryByText("Session can no longer be restored")).not.toBeInTheDocument();
	});

	it("shows a merged-only lane and opens its card without showing restore", async () => {
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([boardSession({ id: "s-merged", title: "merged worker", status: "merged" })])],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		const mergeLane = screen.getByRole("region", { name: "Ready to merge sessions" });
		expect(within(mergeLane).getByLabelText("1 ready to merge session")).toHaveTextContent("1");
		expect(within(mergeLane).queryByText("Merged sessions")).not.toBeInTheDocument();
		expect(within(mergeLane).getByText("merged worker")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /archive/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Restore merged worker" })).not.toBeInTheDocument();

		await userEvent.click(screen.getByText("merged worker"));

		expect(postMock).not.toHaveBeenCalled();
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "p1", sessionId: "s-merged" },
		});
	});

	it("orders ready-to-merge sessions above merged ones in a single column list", () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				workspaceWithSessions([
					boardSession({ id: "s-ready", title: "ready worker", status: "mergeable" }),
					boardSession({ id: "s-merged", title: "merged worker", status: "merged" }),
				]),
			],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		const mergeLane = screen.getByRole("region", { name: "Ready to merge sessions" });
		expect(within(mergeLane).getByLabelText("2 ready to merge sessions")).toHaveTextContent("2");
		expect(mergeLane.querySelectorAll(".overflow-y-auto")).toHaveLength(1);
		expect(cardSessionIds(mergeLane)).toEqual(["s-ready", "s-merged"]);
		expect(screen.queryByRole("button", { name: /archive/i })).not.toBeInTheDocument();
	});

	it("uses the shared minimal scrollbar styling for every Kanban lane", () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				workspaceWithSessions([
					boardSession({ id: "s-idle", title: "idle worker", status: "idle" }),
					boardSession({ id: "s-working", title: "working worker", status: "working" }),
					boardSession({ id: "s-action", title: "action worker", status: "needs_input" }),
					boardSession({ id: "s-review", title: "review worker", status: "review_pending" }),
					boardSession({ id: "s-ready", title: "ready worker", status: "mergeable" }),
					boardSession({ id: "s-merged", title: "merged worker", status: "merged" }),
				]),
			],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		const laneScrollers = screen
			.getAllByTestId("board-column")
			.flatMap((column) => Array.from(column.querySelectorAll<HTMLElement>(".overflow-y-auto")));
		expect(laneScrollers).toHaveLength(4);
		for (const scroller of laneScrollers) {
			expect(scroller).toHaveClass("board-scrollbar", "overflow-y-auto");
		}
	});

	it("archives a terminated merged runtime without duplicating it in the merge column", async () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				workspaceWithSessions([
					boardSession({ id: "s-live-merged", title: "live merged worker", status: "merged" }),
					terminatedSession({ id: "s-archived-merged", title: "archived merged worker", status: "merged" }),
				]),
			],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		const mergeLane = screen.getByRole("region", { name: "Ready to merge sessions" });
		expect(within(mergeLane).getByText("live merged worker")).toBeInTheDocument();
		expect(within(mergeLane).queryByText("archived merged worker")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /archive/i }));
		const archive = screen.getByRole("list", { name: "Archived sessions" });
		const archivedMergedCard = within(archive)
			.getByText("archived merged worker")
			.closest<HTMLElement>("[role='listitem']");
		expect(archivedMergedCard).not.toBeNull();
		expect(
			within(archivedMergedCard!).queryByRole("button", { name: "Open archived merged worker" }),
		).not.toBeInTheDocument();
		expect(
			within(archivedMergedCard!).queryByRole("button", { name: "Terminate archived merged worker" }),
		).not.toBeInTheDocument();
		expect(within(archivedMergedCard!).getByText("Merged").closest("span")).toHaveClass("text-status-merged");
		expect(within(archive).getByRole("button", { name: "Restore archived merged worker" })).toBeInTheDocument();
	});

	it("asks for confirmation when terminating an ordinary live session from its card", async () => {
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([boardSession({ id: "s-idle", title: "idle worker", status: "idle" })])],
			isError: false,
			isSuccess: true,
		});
		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: "Terminate idle worker" }));

		expect(navigateMock).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog", { name: "Terminate idle worker?" })).toBeInTheDocument();
	});

	it("terminates a live merged session from its card without opening the session", async () => {
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([boardSession({ id: "s-merged", title: "merged worker", status: "merged" })])],
			isError: false,
			isSuccess: true,
		});
		renderBoard("p1");

		const terminateButton = screen.getByRole("button", { name: "Terminate merged worker" });
		expect(terminateButton).toHaveClass("opacity-100");
		expect(terminateButton).not.toHaveClass("opacity-0");
		await userEvent.click(terminateButton);
		expect(navigateMock).not.toHaveBeenCalled();
		const dialog = screen.getByRole("dialog", { name: "Terminate merged worker?" });
		await userEvent.click(within(dialog).getByRole("button", { name: "Yes, terminate session" }));

		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/kill", {
				params: { path: { sessionId: "s-merged" } },
			}),
		);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("keeps only the targeted card disabled while its termination is pending", async () => {
		let finishKill!: (value: { data: { ok: boolean; sessionId: string }; error: undefined }) => void;
		postMock.mockReturnValueOnce(
			new Promise((resolve) => {
				finishKill = resolve;
			}),
		);
		workspaceQueryMock.mockReturnValue({
			data: [
				workspaceWithSessions([
					boardSession({ id: "s-one", title: "worker one", status: "working" }),
					boardSession({ id: "s-two", title: "worker two", status: "merged" }),
				]),
			],
			isError: false,
			isSuccess: true,
		});
		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: "Terminate worker one" }));
		await userEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", { name: "Yes, terminate session" }),
		);

		expect(screen.getByRole("button", { name: "Killing worker one" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Killing worker one" })).toHaveClass("opacity-100");
		expect(screen.getByRole("button", { name: "Terminate worker two" })).toBeEnabled();
		expect(postMock).toHaveBeenCalledTimes(1);

		finishKill({ data: { ok: true, sessionId: "s-one" }, error: undefined });
		await waitFor(() => expect(screen.getByRole("button", { name: "Terminate worker one" })).toBeEnabled());
	});

	it("keeps the merged-card confirmation dismissed and surfaces termination failures", async () => {
		postMock.mockResolvedValueOnce({ error: { message: "runtime failed" }, response: { status: 500 } });
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([boardSession({ id: "s-merged", title: "merged worker", status: "merged" })])],
			isError: false,
			isSuccess: true,
		});
		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: "Terminate merged worker" }));
		await userEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", { name: "Yes, terminate session" }),
		);

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(await screen.findByRole("alert")).toHaveTextContent("Failed to terminate session (500)");
		expect(screen.getByRole("button", { name: "Terminate merged worker" })).toBeEnabled();
	});
});

function workspaceWithSessions(sessions: WorkspaceSession[]): WorkspaceSummary {
	return {
		id: "p1",
		name: "radic",
		path: "/tmp/radic",
		sessions,
	};
}

function boardSession(
	overrides: Pick<WorkspaceSession, "id" | "title" | "status"> & Partial<WorkspaceSession>,
): WorkspaceSession {
	return {
		workspaceId: "p1",
		workspaceName: "radic",
		provider: "claude-code",
		branch: `ao/${overrides.id}`,
		updatedAt: "2026-01-01T00:00:00Z",
		prs: [],
		...overrides,
	};
}

function terminatedSession(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
	return {
		id: "s-dead",
		workspaceId: "p1",
		workspaceName: "radic",
		title: "dead worker",
		issueId: "github:INT-17",
		provider: "claude-code",
		kind: "worker",
		branch: "ao/dead-worker",
		status: "terminated",
		isTerminated: true,
		updatedAt: "2026-01-01T00:00:00Z",
		prs: [
			{
				url: "https://github.com/example/radic/pull/42",
				number: 42,
				state: "merged",
				ci: "passing",
				review: "approved",
				mergeability: "mergeable",
				reviewComments: false,
				updatedAt: "2026-01-01T00:00:00Z",
			},
		],
		...overrides,
	};
}
