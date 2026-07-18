import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionActivityState, WorkspaceSession, WorkspaceSummary } from "../types/workspace";
import { ShellTopbar, TopbarKillButton } from "./ShellTopbar";

const { navigateMock, onKilledMock, paramsMock, postMock, useWorkspaceQueryMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
	onKilledMock: vi.fn(),
	paramsMock: { projectId: undefined as string | undefined, sessionId: undefined as string | undefined },
	postMock: vi.fn(),
	useWorkspaceQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => navigateMock,
		useParams: () => paramsMock,
	};
});

vi.mock("../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: () => useWorkspaceQueryMock(),
	workspaceQueryKey: ["workspaces"],
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		POST: postMock,
	},
	apiErrorMessage: (error: unknown, fallback = "Request failed") => {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error) {
			return String((error as { message: unknown }).message);
		}
		return fallback;
	},
}));

vi.mock("../lib/spawn-orchestrator", () => ({ spawnOrchestrator: vi.fn() }));
vi.mock("../lib/telemetry", () => ({
	addRendererExceptionStep: vi.fn(),
	captureRendererEvent: vi.fn(),
	captureRendererException: vi.fn(),
}));
vi.mock("./NewTaskDialog", () => ({ NewTaskDialog: () => null }));
vi.mock("./NotificationCenter", () => ({ NotificationCenter: () => null }));

const worker: WorkspaceSession = {
	id: "sess-1",
	workspaceId: "proj-1",
	workspaceName: "my-app",
	title: "do the thing",
	provider: "claude-code",
	kind: "worker",
	branch: "ao/sess-1",
	status: "working",
	updatedAt: "2026-06-10T00:00:00Z",
	prs: [],
};

const orchestrator: WorkspaceSession = {
	id: "orch-1",
	workspaceId: "proj-1",
	workspaceName: "my-app",
	title: "orchestrator",
	provider: "claude-code",
	kind: "orchestrator",
	branch: "main",
	status: "working",
	updatedAt: "2026-06-10T00:00:00Z",
	prs: [],
};

function sessionWith(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
	return {
		...worker,
		activity: { state: "active", lastActivityAt: "2026-06-10T00:00:00Z" },
		...overrides,
	};
}

function renderTopbar(session: WorkspaceSession) {
	const data: WorkspaceSummary[] = [
		{
			id: session.workspaceId,
			name: session.workspaceName,
			path: "/repo/my-app",
			sessions: [session],
		},
	];
	useWorkspaceQueryMock.mockReturnValue({ data, isError: false, isLoading: false });
	paramsMock.projectId = session.workspaceId;
	paramsMock.sessionId = session.id;
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<ShellTopbar />
		</QueryClientProvider>,
	);
}

function renderKill(session: WorkspaceSession = worker, orchestratorId?: string) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	render(
		<QueryClientProvider client={queryClient}>
			<TopbarKillButton session={session} orchestratorId={orchestratorId} onKilled={onKilledMock} />
		</QueryClientProvider>,
	);
	return queryClient;
}

beforeEach(() => {
	navigateMock.mockReset();
	onKilledMock.mockReset();
	paramsMock.projectId = undefined;
	paramsMock.sessionId = undefined;
	postMock.mockReset();
	postMock.mockResolvedValue({ data: { ok: true, sessionId: "sess-1" }, error: undefined });
	useWorkspaceQueryMock.mockReset();
	useWorkspaceQueryMock.mockReturnValue({ data: [], isError: false, isLoading: false });
});

describe("ShellTopbar status pill", () => {
	it.each([
		["active", "Working"],
		["idle", "Idle"],
		["waiting_input", "Input Needed"],
		["exited", "Exited"],
	] as const)("renders %s activity as %s", (state: SessionActivityState, label) => {
		renderTopbar(sessionWith({ activity: { state, lastActivityAt: "2026-06-10T00:00:00Z" } }));

		expect(screen.getByText(label)).toBeInTheDocument();
	});

	it.each([
		["ci_failed", "ci_failed", "idle", "Idle", "CI failed"],
		["mergeable", "mergeable", "active", "Working", "Ready"],
		["merged", "done", "exited", "Exited", "Done"],
		["changes_requested", "needs_you", "waiting_input", "Input Needed", "Needs input"],
	] as const)(
		"ignores coarse %s/%s topbar status in favor of activity",
		(status, displayStatus, state, label, hidden) => {
			renderTopbar(
				sessionWith({
					status,
					displayStatus,
					activity: { state, lastActivityAt: "2026-06-10T00:00:00Z" },
				}),
			);

			expect(screen.getByText(label)).toBeInTheDocument();
			expect(screen.queryByText(hidden)).not.toBeInTheDocument();
		},
	);

	it("uses a compact unknown state when activity is missing or unknown", () => {
		const first = renderTopbar(sessionWith({ activity: undefined }));
		expect(screen.getByText("Unknown")).toBeInTheDocument();

		first.unmount();
		renderTopbar(sessionWith({ activity: { state: "unknown", lastActivityAt: "" } }));
		expect(screen.getByText("Unknown")).toBeInTheDocument();
	});
});

describe("ShellTopbar orchestrator actions", () => {
	it("marks Kanban as the primary action on orchestrator sessions", () => {
		renderTopbar(orchestrator);

		expect(screen.getByRole("button", { name: "Open Kanban" })).toHaveClass("bg-primary");
		expect(screen.getByRole("button", { name: "New task" })).toHaveClass("bg-raised");
		expect(screen.getByRole("button", { name: "New task" })).not.toHaveClass("bg-primary");
	});
});

describe("TopbarKillButton", () => {
	it("arms a confirmation before killing an active session", async () => {
		renderKill();

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		expect(postMock).not.toHaveBeenCalled();

		await userEvent.click(screen.getByRole("button", { name: "Confirm kill" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/kill", {
			params: { path: { sessionId: "sess-1" } },
		});
	});

	it("can back out of the confirmation without killing", async () => {
		renderKill();

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(screen.getByRole("button", { name: "Kill session" })).toBeInTheDocument();
		expect(postMock).not.toHaveBeenCalled();
	});

	it("surfaces the daemon error when the kill fails", async () => {
		postMock.mockResolvedValue({ data: undefined, error: { message: "session not found" } });
		renderKill();

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		await userEvent.click(screen.getByRole("button", { name: "Confirm kill" }));

		expect(await screen.findByText("session not found")).toBeInTheDocument();
	});

	it("navigates back to the project orchestrator after a successful kill", async () => {
		renderKill(worker, orchestrator.id);

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		await userEvent.click(screen.getByRole("button", { name: "Confirm kill" }));

		await waitFor(() => {
			expect(onKilledMock).toHaveBeenCalledWith("proj-1", "orch-1");
		});
	});

	it("falls back to the project board when no orchestrator is available", async () => {
		renderKill();

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		await userEvent.click(screen.getByRole("button", { name: "Confirm kill" }));

		await waitFor(() => {
			expect(onKilledMock).toHaveBeenCalledWith("proj-1", undefined);
		});
	});
});
