import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";

const { navigateMock, postMock, workspaceQueryMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
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

import { SessionsBoard } from "./SessionsBoard";

function renderBoard(projectId?: string) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	renderBoardWithClient(queryClient, projectId);
	return queryClient;
}

function renderBoardWithClient(queryClient: QueryClient, projectId?: string) {
	return render(
		<QueryClientProvider client={queryClient}>
			<SessionsBoard projectId={projectId} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	navigateMock.mockReset();
	postMock.mockReset().mockResolvedValue({ data: {} });
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

		fireEvent.click(screen.getByRole("button", { name: /idle sessions/i }));
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
		fireEvent.click(screen.getByRole("button", { name: /idle sessions/i }));

		const idleCard = screen.getByText("idle-card-task").closest('[role="button"]') as HTMLElement;
		const noSignalCard = screen.getByText("no-signal-card-task").closest('[role="button"]') as HTMLElement;
		const draftCard = screen.getByText("draft-card-task").closest('[role="button"]') as HTMLElement;

		expect(within(idleCard).getByText("Idle").closest("span")).toHaveClass("text-passive");
		expect(within(noSignalCard).getByText("No signal").closest("span")).toHaveClass("text-warning");
		expect(within(draftCard).getByText("Draft PR").closest("span")).toHaveClass("text-accent");
	});

	it("collapses idle sessions into a nested Working-column stack", () => {
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
							title: "active-task",
							provider: "claude-code",
							branch: "ao/radic-4",
							status: "working",
							activity: { state: "active", lastActivityAt: "2026-01-01T00:00:00Z" },
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
						{
							id: "s1",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "idle-no-pr-task",
							provider: "claude-code",
							branch: "ao/radic-5",
							status: "working",
							activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
						{
							id: "s2",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "idle-with-pr-task",
							provider: "claude-code",
							branch: "ao/radic-6",
							status: "working",
							activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [{ number: 7, url: "https://github.com/acme/radic/pull/7", state: "open" }],
						},
					],
				},
			],
			isError: false,
		});

		renderBoard("p1");

		expect(screen.getByText("active-task")).toBeInTheDocument();
		expect(screen.queryByText("idle-no-pr-task")).not.toBeInTheDocument();
		expect(screen.queryByText("idle-with-pr-task")).not.toBeInTheDocument();

		const idleStackToggle = screen.getByRole("button", { name: /idle sessions/i });
		expect(idleStackToggle).toHaveAttribute("aria-expanded", "false");
		expect(within(idleStackToggle).getByText("2")).toBeInTheDocument();

		fireEvent.click(idleStackToggle);

		expect(screen.getByRole("button", { name: /idle sessions/i })).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("active-task")).toBeInTheDocument();
		const idleCard = screen.getByText("idle-no-pr-task").closest('[role="button"]') as HTMLElement;
		expect(screen.getByText("idle-with-pr-task")).toBeInTheDocument();
		const badge = within(idleCard).getByText("Working").closest("span");
		expect(badge).toHaveClass("text-working");
		expect(badge).not.toHaveClass("text-passive");
	});

	it("toggles idle contents without hiding active cards or remounting the toggle", () => {
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
							title: "active-task",
							provider: "claude-code",
							branch: "ao/radic-4",
							status: "working",
							activity: { state: "active", lastActivityAt: "2026-01-01T00:00:00Z" },
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
						{
							id: "s1",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "idle-task",
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

		expect(screen.getByText("active-task")).toBeInTheDocument();
		expect(screen.queryByText("idle-task")).not.toBeInTheDocument();

		const idleToggle = screen.getByRole("button", { name: /idle sessions/i });
		expect(idleToggle).toHaveAttribute("aria-expanded", "false");
		expect(idleToggle.parentElement).toHaveClass("transition-[opacity,transform]");
		expect(idleToggle.parentElement).not.toHaveClass("transition-[flex-grow,opacity,transform]");
		expect(idleToggle.parentElement).toHaveClass("motion-reduce:transition-none");
		expect(idleToggle.querySelector("svg")).toHaveClass("motion-reduce:transition-none");
		fireEvent.click(idleToggle);

		expect(screen.getByRole("button", { name: /idle sessions/i })).toBe(idleToggle);
		expect(idleToggle).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("active-task")).toBeInTheDocument();
		expect(screen.getByText("idle-task")).toBeInTheDocument();

		fireEvent.click(idleToggle);

		expect(screen.getByText("active-task")).toBeInTheDocument();
		expect(screen.queryByText("idle-task")).not.toBeInTheDocument();
		expect(idleToggle).toHaveAttribute("aria-expanded", "false");
	});

	it("resets the idle stack when navigating between project boards", () => {
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

		fireEvent.click(screen.getByRole("button", { name: /idle sessions/i }));
		expect(screen.getByText("p1 idle")).toBeInTheDocument();

		view.rerender(
			<QueryClientProvider client={queryClient}>
				<SessionsBoard projectId="p2" />
			</QueryClientProvider>,
		);

		expect(screen.getByText("p2 active")).toBeInTheDocument();
		expect(screen.queryByText("p2 idle")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /idle sessions/i })).toHaveAttribute("aria-expanded", "false");
	});

	it("shows a restore action for terminated sessions in expanded Done / Terminated", async () => {
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession()])],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: /done \/ terminated/i }));

		expect(screen.getByText("dead worker")).toBeInTheDocument();
		expect(screen.getByText("Terminated")).toBeInTheDocument();
		expect(screen.getByText("Claude")).toBeInTheDocument();
		expect(screen.getByText("ao/dead-worker")).toBeInTheDocument();
		expect(screen.getByText("github:INT-17")).toBeInTheDocument();
		expect(screen.getByLabelText("#42 merged")).toHaveTextContent("PR#42merged");
		expect(screen.getByRole("button", { name: "Restore dead worker" })).toBeInTheDocument();
	});

	it("restores a terminated session, refreshes workspace data, and opens the restored terminal", async () => {
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession()])],
			isError: false,
			isSuccess: true,
		});
		const queryClient = renderBoard("p1");
		const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);

		await userEvent.click(screen.getByRole("button", { name: /done \/ terminated/i }));
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

	it("keeps other restore buttons hidden while one session is restoring", async () => {
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

		await userEvent.click(screen.getByRole("button", { name: /done \/ terminated/i }));
		await userEvent.click(screen.getByRole("button", { name: "Restore dead worker" }));

		const restoringButton = screen.getByRole("button", { name: "Restore dead worker" });
		const otherButton = screen.getByRole("button", { name: "Restore other worker" });
		expect(restoringButton).toHaveClass("opacity-100");
		expect(otherButton).toBeDisabled();
		expect(otherButton).toHaveClass("opacity-0");
		expect(otherButton.className).not.toContain("group-hover:opacity-100");
		expect(otherButton.className).not.toContain("group-focus-within:opacity-100");

		finishRestore?.({ data: {} });
	});

	it("opens the restore-unavailable dialog when a session is not resumable", async () => {
		postMock.mockResolvedValueOnce({ error: { code: "SESSION_NOT_RESUMABLE" } });
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession()])],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: /done \/ terminated/i }));
		await userEvent.click(screen.getByRole("button", { name: "Restore dead worker" }));

		expect(await screen.findByText("Session can no longer be restored")).toBeInTheDocument();
	});

	it("shows a card error when restore fails", async () => {
		postMock.mockResolvedValueOnce({ error: { code: "RESTORE_FAILED", message: "boom" } });
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession()])],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: /done \/ terminated/i }));
		await userEvent.click(screen.getByRole("button", { name: "Restore dead worker" }));

		expect(await screen.findByText("Unable to restore session")).toBeInTheDocument();
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("opens a terminated session from the card body without restoring it", async () => {
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession()])],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: /done \/ terminated/i }));
		await userEvent.click(screen.getByText("dead worker"));

		expect(postMock).not.toHaveBeenCalled();
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "p1", sessionId: "s-dead" },
		});
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

		await userEvent.click(screen.getByRole("button", { name: /done \/ terminated/i }));
		await userEvent.click(screen.getByRole("button", { name: "Restore dead worker" }));

		view.rerender(
			<QueryClientProvider client={queryClient}>
				<SessionsBoard projectId="p2" />
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

		await userEvent.click(screen.getByRole("button", { name: /done \/ terminated/i }));
		await userEvent.click(screen.getByRole("button", { name: "Restore dead worker" }));

		view.rerender(
			<QueryClientProvider client={queryClient}>
				<SessionsBoard projectId="p2" />
			</QueryClientProvider>,
		);
		await act(async () => {
			finishRestore?.({ error: { code: "SESSION_NOT_RESUMABLE" } });
		});

		expect(navigateMock).not.toHaveBeenCalled();
		expect(screen.queryByText("Session can no longer be restored")).not.toBeInTheDocument();
	});

	it("opens a merged Done session from the card body without showing restore", async () => {
		workspaceQueryMock.mockReturnValue({
			data: [workspaceWithSessions([terminatedSession({ id: "s-merged", title: "merged worker", status: "merged" })])],
			isError: false,
			isSuccess: true,
		});

		renderBoard("p1");

		await userEvent.click(screen.getByRole("button", { name: /done \/ terminated/i }));

		expect(screen.queryByRole("button", { name: "Restore merged worker" })).not.toBeInTheDocument();

		await userEvent.click(screen.getByText("merged worker"));

		expect(postMock).not.toHaveBeenCalled();
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "p1", sessionId: "s-merged" },
		});
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
