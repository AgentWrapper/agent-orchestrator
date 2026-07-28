import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";

const { navigateMock, notificationShowMock, postMock, workspaceQueryMock, boardActionsInPanelMock, scmSummaryMock } =
	vi.hoisted(() => ({
		navigateMock: vi.fn(),
		notificationShowMock: vi.fn(),
		postMock: vi.fn(),
		workspaceQueryMock: vi.fn(),
		boardActionsInPanelMock: vi.fn(() => false),
		scmSummaryMock: vi.fn((): { data: unknown } => ({ data: undefined })),
	}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
}));

vi.mock("../hooks/useWorkspaceQuery", () => ({
	workspaceQueryKey: ["workspaces"],
	useWorkspaceQuery: workspaceQueryMock,
}));

vi.mock("../hooks/useSessionScmSummary", () => ({
	useSessionScmSummary: scmSummaryMock,
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
	scmSummaryMock.mockReset().mockReturnValue({ data: undefined });
	window.localStorage.removeItem("ao.board.archive.layout");
	boardActionsInPanelMock.mockReset().mockReturnValue(false);
});

describe("SessionsBoard", () => {
	it("does not show an agent setup warning on the board", () => {
		renderBoard();

		expect(screen.queryByText(/reload agents/i)).not.toBeInTheDocument();
	});

	it("shows the project name in the in-panel board chrome when actions live in the panel", () => {
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

		expect(screen.getByText("solkit-ui")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "New task" })).toBeInTheDocument();
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
		const noSignalCard = screen.getByText("no-signal-card-task").closest('[data-testid="board-session-card"]') as HTMLElement;
		const draftCard = screen.getByText("draft-card-task").closest('[data-testid="board-session-card"]') as HTMLElement;

		// The column header names the stage, so no card repeats a status pill —
		// idle, no signal and draft alike carry no status word.
		expect(within(idleCard).queryByText("Idle")).toBeNull();
		expect(within(noSignalCard).queryByText("No signal")).toBeNull();
		expect(within(draftCard).queryByText("Draft PR")).toBeNull();
	});

	it("keeps the status in the card's accessible name (sr-only) though the pill is hidden", () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				workspaceWithSessions([
					boardSession({
						id: "s-cr",
						title: "changes-task",
						status: "changes_requested",
						activity: { state: "waiting_input", lastActivityAt: "2026-01-01T00:00:00Z" },
					}),
				]),
			],
			isError: false,
		});

		renderBoard("p1");

		const card = screen.getByText("changes-task").closest('[data-testid="board-session-card"]') as HTMLElement;
		// No visible status pill…
		expect(within(card).queryByText("Changes requested")).toBeNull();
		// …but a screen reader still hears why the task needs attention.
		expect(within(card).getByText("Status: Changes requested")).toHaveClass("sr-only");
	});

	it("shows the diff totals from the SCM PR summary (production shape, no changedFiles)", () => {
		// Production sessions carry no `changedFiles`; the diff must be derived from
		// the PR summaries the SCM hook returns, or the packaged app shows nothing.
		scmSummaryMock.mockReturnValue({
			data: [
				{
					url: "https://github.com/acme/radic/pull/512",
					htmlUrl: "https://github.com/acme/radic/pull/512",
					number: 512,
					title: "diff-summary-task",
					state: "open",
					provider: "github",
					repo: "acme/radic",
					author: "agent",
					sourceBranch: "ao/s-diff",
					targetBranch: "main",
					headSha: "abc123",
					additions: 128,
					deletions: 47,
					changedFiles: 6,
					ci: { state: "passing", failingChecks: [] },
					review: { decision: "none", hasUnresolvedHumanComments: false, unresolvedBy: [] },
					mergeability: {
						state: "mergeable",
						reasons: [],
						prUrl: "https://github.com/acme/radic/pull/512",
						conflictFiles: [],
					},
					createdAt: "2026-01-01T00:00:00Z",
					stateChangedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					observedAt: "2026-01-01T00:00:00Z",
					ciObservedAt: "2026-01-01T00:00:00Z",
					reviewObservedAt: "2026-01-01T00:00:00Z",
				},
			],
		});
		workspaceQueryMock.mockReturnValue({
			data: [
				workspaceWithSessions([
					boardSession({
						id: "s-diff",
						title: "diff-summary-task",
						status: "pr_open",
						activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
						// No changedFiles — exactly what fetchWorkspaces() returns in production.
						prs: [
							{
								number: 512,
								url: "https://github.com/acme/radic/pull/512",
								state: "open",
								ci: "passing",
								review: "none",
								mergeability: "mergeable",
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

		const card = screen.getByText("diff-summary-task").closest('[data-testid="board-session-card"]') as HTMLElement;
		expect(within(card).getByText("+128")).toBeInTheDocument();
		expect(within(card).getByText("−47")).toBeInTheDocument();
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
		expect(needsYouColumn.firstElementChild).toHaveClass("h-12");
		expect(within(needsYouColumn).getByText("agent-exited-task")).toBeInTheDocument();
		expect(within(needsYouColumn).queryByText("Exited")).toBeNull();
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

		// The column header names only the lane the column starts with; "Working" is
		// named once, on the section that actually holds the working cards.
		// Titles carry their own weight and a colour bar rather than a glyph.
		expect(within(workSummary).getByText("Idle")).toHaveClass("font-mono", "text-xs", "uppercase");
		expect(within(workSummary).queryByText("Working")).toBeNull();
		expect(workSummary.parentElement).toHaveClass("h-12", "border-b");
		expect(within(workLane).getByLabelText("2 idle sessions")).toHaveTextContent("2");
		expect(within(workingRegion).getByText("Working")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /idle sessions/i })).not.toBeInTheDocument();
		// Lanes are sized by their content, so a short Idle lane leaves no dead
		// space above the Working header.
		expect(idleRegion.className).not.toContain("flex-[3]");
		expect(workingRegion.className).not.toContain("flex-[2]");
		expect(workingRegion.firstElementChild?.className).toContain("border-y");
		expect(within(idleRegion).getByText("idle-no-pr-task")).toBeInTheDocument();
		expect(within(idleRegion).getByText("second-idle-task")).toBeInTheDocument();
		expect(within(workingRegion).getByText("active-task")).toBeInTheDocument();
		expect(within(reviewRegion).getByText("idle-with-pr-task")).toBeInTheDocument();
		expect(within(workLane).queryByText("idle-with-pr-task")).not.toBeInTheDocument();

		const idleCard = screen.getByText("idle-no-pr-task").closest('[data-testid="board-session-card"]') as HTMLElement;
		// Under the Idle lane the card drops its redundant status pill and must not
		// fall back to a Working label.
		expect(within(idleCard).queryByText("Idle")).toBeNull();
		expect(within(idleCard).queryByText("Working")).toBeNull();
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
		// Only Idle has work, so the header names Idle alone rather than showing an
		// empty Working half.
		expect(within(workLane).queryByLabelText("0 working sessions")).not.toBeInTheDocument();
		const idleOnlySummary = within(workLane).getByRole("group", { name: "Idle / Working lane summary" });
		expect(within(idleOnlySummary).getByText("Idle")).toBeInTheDocument();
		expect(within(idleOnlySummary).queryByText("Working")).toBeNull();
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
		expect(within(workLane).getByLabelText("2 working sessions")).toHaveTextContent("2");
		// Working is the only lane with work, so Idle is absent from the header.
		expect(within(workLane).queryByLabelText("0 idle sessions")).not.toBeInTheDocument();
		const workingOnlySummary = within(workLane).getByRole("group", { name: "Idle / Working lane summary" });
		expect(within(workingOnlySummary).getByText("Working")).toBeInTheDocument();
		expect(within(workingOnlySummary).queryByText("Idle")).toBeNull();
		expect(within(workLane).queryByRole("region", { name: "Idle sessions" })).not.toBeInTheDocument();
		// Standalone: no repeated sub-header, since the column header already names it.
		expect(workingRegion.className).not.toContain("border-y");
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
		// Archive cards now use the board card's divider inset.
		const divider = terminatedCard!.querySelector(".mx-3\\.5.my-px.h-px.bg-border");
		expect(divider).not.toBeNull();
		expect(divider!.compareDocumentPosition(prStatus) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
		expect(
			screen.getByText("ao/dead-worker").compareDocumentPosition(divider!) & Node.DOCUMENT_POSITION_FOLLOWING,
		).not.toBe(0);
		expect(screen.getByRole("button", { name: "Restore dead worker" })).toBeInTheDocument();

		// The row layout renders the same accessible logo (both archive layouts changed).
		await userEvent.click(screen.getByRole("button", { name: "Rows" }));
		const rowCard = within(screen.getByRole("list", { name: "Archived sessions" }))
			.getByText("dead worker")
			.closest<HTMLElement>("[role='listitem']");
		expect(rowCard).not.toBeNull();
		expect(within(rowCard!).getByRole("img", { name: "claude-code" })).toBeInTheDocument();
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
		expect(within(mergeSummary).getByText("Merged")).toHaveClass("font-mono", "text-xs", "uppercase");
		expect(within(mergeLane).getByLabelText("1 merged session")).toHaveTextContent("1");
		// Nothing is ready to merge, so that half is dropped from the header too.
		expect(within(mergeLane).queryByLabelText("0 ready to merge sessions")).not.toBeInTheDocument();
		expect(within(mergeSummary).queryByText("Ready to merge")).toBeNull();
		expect(within(mergeLane).queryByRole("region", { name: "Ready to merge sessions" })).not.toBeInTheDocument();
		expect(mergedRegion.className).not.toContain("border-y");
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
		expect(within(mergedRegion).getByText("Merged")).toBeInTheDocument();
		// Content-sized lanes: no fixed ratio reserving height for a short lane.
		expect(readyRegion.className).not.toContain("flex-[3]");
		expect(mergedRegion.className).not.toContain("flex-[2]");
		expect(mergedRegion.firstElementChild?.className).toContain("border-y");
		expect(within(readyRegion).getByText("ready worker")).toBeInTheDocument();
		expect(within(mergedRegion).getByText("merged worker")).toBeInTheDocument();
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
		// One scroller per column: the split lanes share theirs so the lower lane
		// can sit directly under the upper one.
		expect(laneScrollers).toHaveLength(4);
		for (const scroller of laneScrollers) {
			expect(scroller).toHaveClass("board-scrollbar", "overflow-y-auto");
		}
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
