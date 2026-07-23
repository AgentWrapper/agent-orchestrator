import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";

const { navigateMock, notificationShowMock, postMock, workspaceQueryMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
	notificationShowMock: vi.fn(),
	postMock: vi.fn(),
	workspaceQueryMock: vi.fn(),
}));

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
		notifications: {
			show: (...args: unknown[]) => notificationShowMock(...args),
		},
	},
}));

import { SessionsBoard } from "./SessionsBoard";
import { TooltipProvider } from "./ui/tooltip";

function renderBoard(projectId?: string) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	renderBoardWithClient(queryClient, projectId);
	return queryClient;
}

function renderBoardWithClient(queryClient: QueryClient, projectId?: string) {
	return render(
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>
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

		const idleCard = screen.getByText("brand-font-pipeline").closest('[role="button"]') as HTMLElement;
		expect(within(idleCard).getByText("Idle")).toBeInTheDocument();
	});

	it("uses distinct card badge tones for idle, no signal, and draft PR sessions", () => {
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
		const idleCard = screen.getByText("idle-card-task").closest('[role="button"]') as HTMLElement;
		const noSignalCard = screen.getByText("no-signal-card-task").closest('[role="button"]') as HTMLElement;
		const draftCard = screen.getByText("draft-card-task").closest('[role="button"]') as HTMLElement;

		expect(within(idleCard).getByText("Idle").closest("span")).toHaveClass("text-status-idle");
		expect(within(noSignalCard).getByText("No signal").closest("span")).toHaveClass("text-status-unknown");
		expect(within(draftCard).getByText("Draft PR").closest("span")).toHaveClass("text-status-in-review");
	});

	it("places an exited live session in Needs you with an Exited badge", () => {
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
		expect(needsYouColumn.firstElementChild).toHaveClass("pb-2.5");
		expect(within(needsYouColumn).getByText("agent-exited-task")).toBeInTheDocument();
		expect(within(needsYouColumn).getByText("Exited").closest("span")).toHaveClass("text-status-exited");
	});

	it("renders an idle-first work lane with a separate lower working section", () => {
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

		const workLane = screen.getByRole("region", { name: "Idle / Working sessions" });
		const idleRegion = within(workLane).getByRole("region", { name: "Idle sessions" });
		const workingRegion = within(workLane).getByRole("region", { name: "Working sessions" });
		const reviewRegion = screen.getByRole("region", { name: "In review sessions" });
		const workSummary = within(workLane).getByRole("group", { name: "Idle / Working lane summary" });

		expect(within(workSummary).getByText("Idle").querySelector("span")).toHaveClass("bg-status-idle");
		expect(within(workSummary).getByText("Working").querySelector("span")).toHaveClass("bg-status-working");
		expect(workSummary.parentElement).toHaveClass("pb-2.5");
		expect(workingRegion.firstElementChild).toHaveClass("pb-2.5");
		expect(within(workLane).getByLabelText("2 idle sessions")).toHaveTextContent("2");
		expect(within(workLane).getByLabelText("1 working session")).toHaveTextContent("1");
		expect(screen.queryByRole("button", { name: /idle sessions/i })).not.toBeInTheDocument();
		expect(idleRegion).toHaveClass("flex-[3]");
		expect(workingRegion).toHaveClass("flex-[2]", "rounded-t-(--radius-panel)", "border-t");
		expect(within(idleRegion).getByText("idle-no-pr-task")).toBeInTheDocument();
		expect(within(idleRegion).getByText("second-idle-task")).toBeInTheDocument();
		expect(within(workingRegion).getByText("active-task")).toBeInTheDocument();
		expect(within(reviewRegion).getByText("idle-with-pr-task")).toBeInTheDocument();
		expect(within(workLane).queryByText("idle-with-pr-task")).not.toBeInTheDocument();

		const idleCard = screen.getByText("idle-no-pr-task").closest('[role="button"]') as HTMLElement;
		const badge = within(idleCard).getByText("Idle").closest("span");
		expect(badge).toHaveClass("text-status-idle");
		expect(badge).not.toHaveClass("text-status-working");
	});

	it("lets idle sessions fill the lane when no working sessions exist", () => {
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

		const workLane = screen.getByRole("region", { name: "Idle / Working sessions" });
		const idleRegion = within(workLane).getByRole("region", { name: "Idle sessions" });
		expect(within(workLane).getByLabelText("1 idle session")).toHaveTextContent("1");
		expect(within(workLane).getByLabelText("0 working sessions")).toHaveTextContent("0");
		expect(idleRegion).toHaveClass("flex-1");
		expect(within(idleRegion).getByText("idle-task")).toBeInTheDocument();
		expect(within(workLane).queryByRole("region", { name: "Working sessions" })).not.toBeInTheDocument();
	});

	it("lets working sessions fill the lane when no idle sessions exist", () => {
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

		const workLane = screen.getByRole("region", { name: "Idle / Working sessions" });
		const workingRegion = within(workLane).getByRole("region", { name: "Working sessions" });
		expect(within(workLane).getByLabelText("0 idle sessions")).toHaveTextContent("0");
		expect(within(workLane).getByLabelText("2 working sessions")).toHaveTextContent("2");
		expect(within(workLane).queryByRole("region", { name: "Idle sessions" })).not.toBeInTheDocument();
		expect(workingRegion).toHaveClass("flex-1");
		expect(workingRegion).not.toHaveClass("flex-[2]", "border-t");
		expect(within(workingRegion).getByText("first-working-task")).toBeInTheDocument();
		expect(within(workingRegion).getByText("second-working-task")).toBeInTheDocument();
	});

	it("keeps idle and working sections visible when navigating between project boards", () => {
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

		const p1Lane = screen.getByRole("region", { name: "Idle / Working sessions" });
		expect(within(p1Lane).getByRole("region", { name: "Idle sessions" })).toHaveTextContent("p1 idle");
		expect(within(p1Lane).getByRole("region", { name: "Working sessions" })).toHaveTextContent("p1 active");

		view.rerender(
			<QueryClientProvider client={queryClient}>
				<TooltipProvider>
					<SessionsBoard projectId="p2" />
				</TooltipProvider>
			</QueryClientProvider>,
		);

		const p2Lane = screen.getByRole("region", { name: "Idle / Working sessions" });
		expect(screen.queryByText("p1 idle")).not.toBeInTheDocument();
		expect(within(p2Lane).getByRole("region", { name: "Idle sessions" })).toHaveTextContent("p2 idle");
		expect(within(p2Lane).getByRole("region", { name: "Working sessions" })).toHaveTextContent("p2 active");
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
		const terminatedCard = within(archive).getByText("dead worker").closest<HTMLElement>("[role='listitem']");
		expect(terminatedCard).not.toBeNull();
		expect(within(terminatedCard!).queryByRole("button", { name: "Open dead worker" })).not.toBeInTheDocument();
		expect(within(terminatedCard!).getByText("Terminated")).toBeInTheDocument();
		expect(screen.getByText("Claude")).toBeInTheDocument();
			expect(screen.getByText("ao/dead-worker")).toBeInTheDocument();
			expect(screen.getByText("github:INT-17")).toBeInTheDocument();
			const prStatus = screen.getByLabelText("#42 merged");
			expect(prStatus).toHaveTextContent("PR#42merged");
			const divider = terminatedCard!.querySelector(".mx-3.my-px.h-px.bg-border");
			expect(divider).not.toBeNull();
			expect(divider!.compareDocumentPosition(prStatus) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
			expect(screen.getByText("ao/dead-worker").compareDocumentPosition(divider!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
				0,
			);
			expect(screen.getByRole("button", { name: "Restore dead worker" })).toBeInTheDocument();
		});

	it("switches between rows and columns and remembers the archive layout", async () => {
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession()])],
			isError: false,
			isSuccess: true,
		});
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const view = renderBoardWithClient(queryClient, "p1");

		await userEvent.click(screen.getByRole("button", { name: /archive/i }));
		const layout = screen.getByRole("group", { name: "Archive layout" });
		expect(within(layout).getByRole("button", { name: "Columns" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("list", { name: "Archived sessions" })).toHaveClass("grid");
		const restore = screen.getByRole("button", { name: "Restore dead worker" });
		expect(restore.parentElement).toContainElement(screen.getByText("Terminated"));

		await userEvent.click(within(layout).getByRole("button", { name: "Rows" }));
		expect(within(layout).getByRole("button", { name: "Rows" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("list", { name: "Archived sessions" })).not.toHaveClass("grid");
		expect(screen.queryByRole("button", { name: "Open dead worker" })).not.toBeInTheDocument();
		expect(window.localStorage.getItem("ao.board.archive.layout")).toBe("rows");

		view.unmount();
		renderBoard("p1");
		await userEvent.click(screen.getByRole("button", { name: /archive/i }));
		expect(screen.getByRole("button", { name: "Rows" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("list", { name: "Archived sessions" })).not.toHaveClass("grid");
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

		const mergeLane = screen.getByRole("region", { name: "Ready to merge / Merged sessions" });
		const mergedRegion = within(mergeLane).getByRole("region", { name: "Merged sessions" });
		const mergeSummary = within(mergeLane).getByRole("group", { name: "Ready to merge / Merged lane summary" });
		expect(within(mergeSummary).getByText("Ready to merge").querySelector("span")).toHaveClass("bg-status-ready");
		expect(within(mergeSummary).getByText("Merged").querySelector("span")).toHaveClass("bg-status-merged");
		expect(within(mergeLane).getByLabelText("0 ready to merge sessions")).toHaveTextContent("0");
		expect(within(mergeLane).getByLabelText("1 merged session")).toHaveTextContent("1");
		expect(within(mergeLane).queryByRole("region", { name: "Ready to merge sessions" })).not.toBeInTheDocument();
		expect(mergedRegion).toHaveClass("flex-1");
		expect(within(mergedRegion).getByText("merged worker")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /archive/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Restore merged worker" })).not.toBeInTheDocument();

		await userEvent.click(screen.getByText("merged worker"));

		expect(postMock).not.toHaveBeenCalled();
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "p1", sessionId: "s-merged" },
		});
	});

	it("splits ready and merged sessions into upper and lower regions", () => {
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

		const mergeLane = screen.getByRole("region", { name: "Ready to merge / Merged sessions" });
		const readyRegion = within(mergeLane).getByRole("region", { name: "Ready to merge sessions" });
		const mergedRegion = within(mergeLane).getByRole("region", { name: "Merged sessions" });
		expect(within(mergeLane).getByLabelText("1 ready to merge session")).toHaveTextContent("1");
		expect(within(mergeLane).getByLabelText("1 merged session")).toHaveTextContent("1");
		expect(readyRegion).toHaveClass("flex-[3]");
		expect(mergedRegion).toHaveClass("flex-[2]", "rounded-t-(--radius-panel)", "border-t");
		expect(within(readyRegion).getByText("ready worker")).toBeInTheDocument();
		expect(within(mergedRegion).getByText("merged worker")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /archive/i })).not.toBeInTheDocument();
	});

	it("archives a terminated merged runtime without duplicating it in the merged lane", async () => {
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

		const mergedRegion = screen.getByRole("region", { name: "Merged sessions" });
		expect(within(mergedRegion).getByText("live merged worker")).toBeInTheDocument();
		expect(within(mergedRegion).queryByText("archived merged worker")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /archive/i }));
		const archive = screen.getByRole("list", { name: "Archived sessions" });
		const archivedMergedCard = within(archive)
			.getByText("archived merged worker")
			.closest<HTMLElement>("[role='listitem']");
		expect(archivedMergedCard).not.toBeNull();
		expect(
			within(archivedMergedCard!).queryByRole("button", { name: "Open archived merged worker" }),
		).not.toBeInTheDocument();
		expect(within(archivedMergedCard!).getByText("Merged").closest("span")).toHaveClass("text-status-merged");
		expect(within(archive).getByRole("button", { name: "Restore archived merged worker" })).toBeInTheDocument();
	});

	it("terminates a live merged session from its card without opening the session", async () => {
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([boardSession({ id: "s-merged", title: "merged worker", status: "merged" })])],
			isError: false,
			isSuccess: true,
		});
		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: "Terminate merged worker" }));
		expect(navigateMock).not.toHaveBeenCalled();
		const dialog = screen.getByRole("dialog", { name: "Terminate merged worker?" });
		await userEvent.click(within(dialog).getByRole("button", { name: "Terminate session" }));

		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/kill", {
				params: { path: { sessionId: "s-merged" } },
			}),
		);
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("keeps the merged-card confirmation open when termination fails", async () => {
		postMock.mockResolvedValueOnce({ error: { message: "runtime failed" }, response: { status: 500 } });
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([boardSession({ id: "s-merged", title: "merged worker", status: "merged" })])],
			isError: false,
			isSuccess: true,
		});
		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: "Terminate merged worker" }));
		await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Terminate session" }));

		expect(await screen.findByText("Failed to terminate session (500)")).toBeInTheDocument();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
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
