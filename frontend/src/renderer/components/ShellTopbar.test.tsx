import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../stores/ui-store";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";
import { ShellTopbar, TopbarKillButton } from "./ShellTopbar";
import { TooltipProvider } from "./ui/tooltip";

const { navigateMock, onKilledMock, paramsMock, postMock, spawnMock, useWorkspaceQueryMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
	onKilledMock: vi.fn(),
	paramsMock: {
		projectId: undefined as string | undefined,
		sessionId: undefined as string | undefined,
	},
	postMock: vi.fn(),
	spawnMock: vi.fn(),
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

vi.mock("../lib/spawn-orchestrator", () => ({ spawnOrchestrator: spawnMock }));
vi.mock("../lib/telemetry", () => ({
	addRendererExceptionStep: vi.fn(),
	captureRendererEvent: vi.fn(),
	captureRendererException: vi.fn(),
}));
vi.mock("./NewTaskDialog", () => ({ NewTaskDialog: () => null }));
vi.mock("./NotificationCenter", () => ({
	NotificationCenter: () => <button aria-label="Notifications" type="button" />,
}));

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

const secondWorker: WorkspaceSession = {
	...worker,
	id: "sess-2",
	title: "do the other thing",
	branch: "ao/sess-2",
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
	return renderTopbarSessions([session], session.id);
}

function renderTopbarSessions(sessions: WorkspaceSession[], sessionId: string) {
	const data: WorkspaceSummary[] = [
		{
			id: sessions[0].workspaceId,
			name: sessions[0].workspaceName,
			path: "/repo/my-app",
			orchestratorAgent: "claude-code",
			sessions,
		},
	];
	useWorkspaceQueryMock.mockReturnValue({
		data,
		isError: false,
		isLoading: false,
	});
	paramsMock.projectId = sessions[0].workspaceId;
	paramsMock.sessionId = sessionId;
	const queryClient = new QueryClient();
	const topbar = () => (
		<QueryClientProvider client={queryClient}>
			<TooltipProvider delayDuration={0}>
				<ShellTopbar />
			</TooltipProvider>
		</QueryClientProvider>
	);
	const result = render(topbar());
	return {
		...result,
		queryClient,
		rerenderTopbar: () => result.rerender(topbar()),
	};
}

function renderSurface(surfaceOverride?: "global-settings" | "project-settings" | "standalone-terminals") {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider delayDuration={0}>
				<ShellTopbar surfaceOverride={surfaceOverride} />
			</TooltipProvider>
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
			<TooltipProvider delayDuration={0}>
				<TopbarKillButton session={session} orchestratorId={orchestratorId} onKilled={onKilledMock} />
			</TooltipProvider>
		</QueryClientProvider>,
	);
	return queryClient;
}

async function clickKillDialogConfirm() {
	const dialog = await screen.findByRole("dialog", { name: "Kill session?" });
	await userEvent.click(within(dialog).getByRole("button", { name: "Kill session" }));
}

beforeEach(() => {
	navigateMock.mockReset();
	onKilledMock.mockReset();
	paramsMock.projectId = undefined;
	paramsMock.sessionId = undefined;
	postMock.mockReset();
	postMock.mockResolvedValue({
		data: { ok: true, sessionId: "sess-1" },
		error: undefined,
	});
	useWorkspaceQueryMock.mockReset();
	useWorkspaceQueryMock.mockReturnValue({
		data: [],
		isError: false,
		isLoading: false,
	});
	useUiStore.setState({ inspectorSessions: {} });
});

describe("ShellTopbar identity", () => {
	it("leaves the center of the bar empty", () => {
		renderTopbar(sessionWith({ activity: { state: "active", lastActivityAt: "2026-06-10T00:00:00Z" } }));

		// The context pill that carried branch and activity is gone; the bar is
		// breadcrumbs plus trailing controls.
		expect(screen.queryByText("Working")).not.toBeInTheDocument();
		expect(screen.queryByText("ao/sess-1")).not.toBeInTheDocument();
		expect(document.querySelector(".reverb-topbar__state")).toBeNull();
	});
});

describe("ShellTopbar orchestrator actions", () => {
	it.each([
		["active", "Working"],
		["waiting_input", "Input Needed"],
	] as const)("keeps the orchestrator control on a project board with %s activity", (state, label) => {
		renderTopbarSessions(
			[
				{
					...orchestrator,
					activity: { state, lastActivityAt: "2026-06-10T00:00:00Z" },
				},
			],
			"",
		);

		expect(screen.getByRole("button", { name: "Orchestrator" })).toBeInTheDocument();
		// Activity no longer has a surface in the bar.
		expect(screen.queryByText(label)).not.toBeInTheDocument();
	});

	it("keeps orchestrator-session actions compact and explains them on hover", async () => {
		renderTopbar(orchestrator);

		const actions = within(screen.getByRole("group", { name: "Page actions" })).getAllByRole("button");
		expect(actions.map((button) => button.getAttribute("aria-label"))).toEqual(["New task", "Open Board"]);
		for (const action of actions) {
			expect(action).toHaveClass("reverb-topbar__control--icon");
			expect(action.textContent).toBe("");
		}
		const separator = document.querySelector(".reverb-topbar__utility-separator");
		expect(separator).toBeInTheDocument();
		expect(screen.getByRole("group", { name: "Page actions" }).nextElementSibling).toBe(separator);
		expect(separator?.nextElementSibling).toBe(screen.getByRole("group", { name: "Global utilities" }));

		await userEvent.hover(screen.getByRole("button", { name: "Open Board" }));
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Open board");
	});

	it("opens project settings instead of spawning when no orchestrator agent is configured", async () => {
		useWorkspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "proj-1",
					name: "my-app",
					path: "/repo/my-app",
					sessions: [worker],
				},
			],
			isError: false,
			isLoading: false,
		});
		paramsMock.projectId = "proj-1";
		paramsMock.sessionId = "sess-1";
		render(
			<QueryClientProvider client={new QueryClient()}>
				<TooltipProvider delayDuration={0}>
					<ShellTopbar />
				</TooltipProvider>
			</QueryClientProvider>,
		);

		await userEvent.click(screen.getByRole("button", { name: "Open orchestrator" }));

		expect(useUiStore.getState().settingsModal).toEqual({ scope: "project", projectId: "proj-1" });
		expect(spawnMock).not.toHaveBeenCalled();
	});
});

describe("ShellTopbar route variants", () => {
	it("renders a safe unavailable state without live session actions", () => {
		paramsMock.projectId = "proj-1";
		paramsMock.sessionId = "removed-session";
		useWorkspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "proj-1",
					name: "my-app",
					path: "/repo/my-app",
					orchestratorAgent: "claude-code",
					sessions: [],
				},
			],
			isError: false,
			isLoading: false,
		});

		renderSurface();

		expect(screen.getByText("Session unavailable")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Open orchestrator" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /inspector panel/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Kill session" })).not.toBeInTheDocument();
	});

	it("renders a close action for global settings", async () => {
		renderSurface("global-settings");

		expect(screen.queryByText("Reverb")).not.toBeInTheDocument();
		expect(screen.getByText("Settings")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Close settings" }));

		expect(navigateMock).toHaveBeenCalledWith({ to: "/" });
	});

	it("renders the project settings identity without a redundant Board action", () => {
		paramsMock.projectId = "proj-1";
		useWorkspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "proj-1",
					name: "my-app",
					path: "/repo/my-app",
					orchestratorAgent: "claude-code",
					sessions: [],
				},
			],
			isError: false,
			isLoading: false,
		});

		renderSurface("project-settings");

		expect(screen.getByText("my-app")).toBeInTheDocument();
		// The repo path lived in the removed context pill.
		expect(screen.queryByText("/repo/my-app")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Back to Board" })).not.toBeInTheDocument();
	});

	it("renders the standalone terminal identity and action", () => {
		renderSurface("standalone-terminals");

		expect(screen.getByText("Terminals")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "New terminal" })).toBeInTheDocument();
	});
});

describe("ShellTopbar session controls", () => {
	it("keeps compact session actions in order without visible labels", () => {
		renderTopbarSessions([worker], "sess-1");

		const actions = within(screen.getByRole("group", { name: "Page actions" })).getAllByRole("button");
		const labels = actions.map((button) => button.getAttribute("aria-label"));
		expect(labels).toEqual(["Kill session", "Open orchestrator"]);
		for (const action of actions) {
			expect(action).toHaveClass("reverb-topbar__control--icon");
			expect(action).not.toHaveAttribute("data-priority");
			expect(action.textContent).toBe("");
		}
		expect(screen.queryByRole("button", { name: /inspector panel/i })).not.toBeInTheDocument();
		expect(document.querySelector(".reverb-topbar__utility-separator")).not.toBeInTheDocument();
	});

	it("explains the icon-only orchestrator control on hover", async () => {
		renderTopbarSessions([worker], "sess-1");

		await userEvent.hover(screen.getByRole("button", { name: "Open orchestrator" }));
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Open orchestrator");
	});

	it("moves the closed inspector reopen control after Notifications", async () => {
		useUiStore.getState().setInspectorOpen("sess-1", false);
		renderTopbarSessions([worker], "sess-1");

		const utilities = screen.getByRole("group", { name: "Global utilities" });
		const labels = within(utilities)
			.getAllByRole("button")
			.map((button) => button.getAttribute("aria-label"));
		expect(labels).toEqual(["Notifications", "Open inspector panel"]);
		expect(utilities.querySelector(".reverb-topbar__zone-divider")).toBeInTheDocument();

		await userEvent.click(within(utilities).getByRole("button", { name: "Open inspector panel" }));
		expect(useUiStore.getState().inspectorSessions["sess-1"]?.isOpen).toBe(true);
	});

	it("never renders an inspector reopen control for orchestrator sessions", () => {
		useUiStore.getState().setInspectorOpen("orch-1", false);
		renderTopbar(orchestrator);

		expect(screen.queryByRole("button", { name: "Open inspector panel" })).not.toBeInTheDocument();
	});
});

describe("TopbarKillButton", () => {
	it("explains the icon-only kill control on hover", async () => {
		renderKill();

		await userEvent.hover(screen.getByRole("button", { name: "Kill session" }));
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Kill session");
	});

	it("arms a confirmation before killing an active session", async () => {
		renderKill();

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		expect(postMock).not.toHaveBeenCalled();

		await clickKillDialogConfirm();

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
		postMock.mockResolvedValue({
			data: undefined,
			error: { message: "session not found" },
		});
		renderKill();

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		await clickKillDialogConfirm();

		expect(await screen.findByText("session not found")).toBeInTheDocument();
	});

	it("clears a stale daemon error before retrying the kill", async () => {
		postMock
			.mockResolvedValueOnce({
				data: undefined,
				error: { message: "session not found" },
			})
			.mockReturnValue(new Promise(() => {}));
		renderKill();

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		const dialog = await screen.findByRole("dialog", { name: "Kill session?" });
		const confirm = within(dialog).getByRole("button", {
			name: "Kill session",
		});

		await userEvent.click(confirm);
		expect(await screen.findByText("session not found")).toBeInTheDocument();

		await userEvent.click(confirm);

		await waitFor(() => expect(screen.queryByText("session not found")).not.toBeInTheDocument());
	});

	it("navigates back to the project orchestrator after a successful kill", async () => {
		renderKill(worker, orchestrator.id);

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		await clickKillDialogConfirm();

		await waitFor(() => {
			expect(onKilledMock).toHaveBeenCalledWith("proj-1", "orch-1");
		});
	});

	it("falls back to the project board when no orchestrator is available", async () => {
		renderKill();

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		await clickKillDialogConfirm();

		await waitFor(() => {
			expect(onKilledMock).toHaveBeenCalledWith("proj-1", undefined);
		});
	});

	it("isolates an in-flight kill when switching worker sessions", async () => {
		let resolveKill!: (value: { data: { ok: boolean; sessionId: string }; error: undefined }) => void;
		postMock.mockReturnValue(
			new Promise((resolve) => {
				resolveKill = resolve;
			}),
		);
		const view = renderTopbarSessions([worker, secondWorker], "sess-1");

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		await clickKillDialogConfirm();
		expect(await screen.findByRole("button", { name: "Killing..." })).toBeDisabled();

		paramsMock.sessionId = "sess-2";
		view.rerenderTopbar();

		expect(screen.queryByRole("dialog", { name: "Kill session?" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Kill session" })).toBeEnabled();

		resolveKill({ data: { ok: true, sessionId: "sess-1" }, error: undefined });
		await waitFor(() => expect(view.queryClient.isMutating()).toBe(0));

		expect(navigateMock).not.toHaveBeenCalled();
	});
});
