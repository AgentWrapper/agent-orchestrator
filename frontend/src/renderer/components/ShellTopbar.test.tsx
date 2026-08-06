import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appI18n } from "../i18n";
import { useUiStore } from "../stores/ui-store";
import type { SessionActivityState, WorkspaceSession, WorkspaceSummary } from "../types/workspace";
import { ShellTopbar, TopbarKillButton } from "./ShellTopbar";
import { TooltipProvider } from "./ui/tooltip";

const { navigateMock, onKilledMock, paramsMock, platformFlags, postMock, spawnMock, useWorkspaceQueryMock } = vi.hoisted(
	() => ({
		navigateMock: vi.fn(),
		onKilledMock: vi.fn(),
		paramsMock: {
			projectId: undefined as string | undefined,
			sessionId: undefined as string | undefined,
		},
		platformFlags: {
			boardActionsInPanel: false,
			isMac: false,
		},
		postMock: vi.fn(),
		spawnMock: vi.fn(),
		useWorkspaceQueryMock: vi.fn(),
	}),
);

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

vi.mock("../lib/platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/platform")>();
	return {
		...actual,
		isMacPlatform: () => platformFlags.isMac,
		usesBoardActionsInPanel: () => platformFlags.boardActionsInPanel,
	};
});

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
	const killButton = (currentSession: WorkspaceSession, currentOrchestratorId?: string) => (
		<QueryClientProvider client={queryClient}>
			<TooltipProvider delayDuration={0}>
				<TopbarKillButton
					session={currentSession}
					orchestratorId={currentOrchestratorId}
					onKilled={onKilledMock}
				/>
			</TooltipProvider>
		</QueryClientProvider>
	);
	const result = render(killButton(session, orchestratorId));
	return {
		...result,
		queryClient,
		rerenderKill: (nextSession: WorkspaceSession, nextOrchestratorId?: string) =>
			result.rerender(killButton(nextSession, nextOrchestratorId)),
	};
}

async function clickKillDialogConfirm() {
	const dialog = await screen.findByRole("dialog", { name: "Terminate do the thing?" });
	await userEvent.click(within(dialog).getByRole("button", { name: "Yes, terminate session" }));
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
	spawnMock.mockReset().mockResolvedValue("orch-created");
	useWorkspaceQueryMock.mockReset();
	useWorkspaceQueryMock.mockReturnValue({
		data: [],
		isError: false,
		isLoading: false,
	});
	useUiStore.setState({ inspectorSessions: {} });
});

describe("ShellTopbar activity status", () => {
	it.each([
		["active", "Working"],
		["idle", "Idle"],
		["waiting_input", "Input Needed"],
		["exited", "Exited"],
	] as const)("renders %s activity as %s", (state: SessionActivityState, label) => {
		renderTopbar(
			sessionWith({
				activity: { state, lastActivityAt: "2026-06-10T00:00:00Z" },
			}),
		);

		expect(screen.getByText(label)).toBeInTheDocument();
	});

	it("places a plain, non-pill activity label beside the session name", () => {
		renderTopbar(sessionWith());

		const status = screen.getByText("Working");
		expect(status).toHaveClass("reverb-topbar__activity");
		expect(status.previousElementSibling).toHaveClass("reverb-topbar__state-divider");
		expect(status.closest(".reverb-topbar__context")).toHaveTextContent("do the thing");
		expect(status).not.toHaveClass("rounded-md");
	});

	it.each([
		["ci_failed", "idle", "Idle", "CI failed"],
		["mergeable", "active", "Working", "Ready"],
		["merged", "exited", "Exited", "Done"],
		["changes_requested", "waiting_input", "Input Needed", "Needs input"],
	] as const)("ignores derived %s topbar status in favor of activity", (status, state, label, hidden) => {
		renderTopbar(
			sessionWith({
				status,
				activity: { state, lastActivityAt: "2026-06-10T00:00:00Z" },
			}),
		);

		expect(screen.getByText(label)).toBeInTheDocument();
		expect(screen.queryByText(hidden)).not.toBeInTheDocument();
	});

	it("uses a compact unknown state when activity is missing or unknown", () => {
		const first = renderTopbar(sessionWith({ activity: undefined }));
		expect(screen.getByText("Unknown")).toBeInTheDocument();

		first.unmount();
		renderTopbar(sessionWith({ activity: { state: "unknown", lastActivityAt: "" } }));
		expect(screen.getByText("Unknown")).toBeInTheDocument();
	});

	it("does not synthesize branch text for branchless sessions", () => {
		renderTopbar(sessionWith({ branch: undefined }));

		expect(screen.queryByText("session/sess-1")).not.toBeInTheDocument();
		expect(screen.getByText("Working")).toBeInTheDocument();
	});

	it("localizes compact session controls without changing route-owned identity", async () => {
		await appI18n.changeLanguage("zh-CN");
		try {
			renderTopbar(sessionWith());

			expect(screen.getByText("do the thing")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "结束会话" })).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "启动编排器" })).toBeInTheDocument();
		} finally {
			await appI18n.changeLanguage("en");
		}
	});
});

describe("ShellTopbar orchestrator actions", () => {
	it.each([
		["active", "Working", true],
		["waiting_input", "Input Needed", false],
	] as const)("shows %s orchestrator activity in the project-board context", (state, label, pulses) => {
		renderTopbarSessions(
			[
				{
					...orchestrator,
					activity: { state, lastActivityAt: "2026-06-10T00:00:00Z" },
				},
			],
			"",
		);

		const status = screen.getByText(label);
		const indicator = status.querySelector("span");
		expect(screen.getByRole("button", { name: "Orchestrator" })).toBeInTheDocument();
		expect(indicator).toHaveClass("reverb-topbar__status-dot");
		if (pulses) expect(indicator).toHaveClass("animate-status-pulse");
		if (!pulses) expect(indicator).not.toHaveClass("animate-status-pulse");
	});

	it("shows labelled orchestrator-session actions and explains them on hover", async () => {
		renderTopbar(orchestrator);
		const providerLabel = screen.getByText("claude-code");
		expect(providerLabel.previousElementSibling?.tagName).toBe("IMG");
		expect(providerLabel.previousElementSibling).toHaveAttribute("aria-hidden", "true");
		expect(providerLabel.previousElementSibling).toHaveClass("size-icon-xs");

		const actions = within(screen.getByRole("group", { name: "Page actions" })).getAllByRole("button");
		expect(actions.map((button) => button.getAttribute("aria-label"))).toEqual(["New task", "Open Kanban"]);
		expect(actions.map((action) => action.textContent)).toEqual(["Task", "Open Kanban"]);
		expect(actions[0]).toHaveClass("reverb-topbar__control--accent");
		expect(actions[1]).toHaveClass("reverb-topbar__control--feature");
		const separator = document.querySelector(".reverb-topbar__utility-separator");
		expect(separator).toBeInTheDocument();
		expect(screen.getByRole("group", { name: "Page actions" }).nextElementSibling).toBe(separator);
		expect(separator?.nextElementSibling).toBe(screen.getByRole("group", { name: "Global utilities" }));

		await userEvent.hover(screen.getByRole("button", { name: "Open Kanban" }));
		expect(screen.getByRole("button", { name: "Open Kanban" })).toHaveClass("reverb-topbar__control--feature");
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Open Kanban");
	});

	it("keeps Win/Linux board actions in the topbar and separates global utilities", () => {
		renderTopbarSessions([orchestrator], "");

		const actions = screen.getByRole("group", { name: "Page actions" });
		expect(
			within(actions)
				.getAllByRole("button")
				.map((button) => button.getAttribute("aria-label")),
		).toEqual(["New task", "Orchestrator"]);
		expect(within(actions).getByRole("button", { name: "New task" })).toHaveClass("reverb-topbar__control--accent");
		expect(within(actions).getByRole("button", { name: "New task" })).toHaveTextContent("Task");
		expect(within(actions).getByRole("button", { name: "Orchestrator" })).toHaveClass(
			"reverb-topbar__control--primary",
		);
		expect(within(actions).getByRole("button", { name: "Orchestrator" })).toHaveTextContent("Orchestrator");
		expect(actions.nextElementSibling).toHaveClass("reverb-topbar__utility-separator");
		expect(screen.getByRole("group", { name: "Global utilities" })).toContainElement(
			screen.getByRole("button", { name: "Notifications" }),
		);
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

		await userEvent.click(screen.getByRole("button", { name: "Spawn Orchestrator" }));

		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/settings",
			params: { projectId: "proj-1" },
		});
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("navigates to an existing project orchestrator without spawning", async () => {
		renderTopbarSessions([worker, orchestrator], worker.id);

		await userEvent.click(screen.getByRole("button", { name: "Open orchestrator" }));

		expect(spawnMock).not.toHaveBeenCalled();
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "proj-1", sessionId: "orch-1" },
		});
	});

	it("spawns and opens an orchestrator when the project has none", async () => {
		renderTopbar(worker);

		await userEvent.click(screen.getByRole("button", { name: "Spawn Orchestrator" }));

		await waitFor(() => {
			expect(spawnMock).toHaveBeenCalledWith("proj-1", "topbar");
			expect(navigateMock).toHaveBeenCalledWith({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId: "proj-1", sessionId: "orch-created" },
			});
		});
	});

	it("switches from a worker to its orchestrator as soon as termination is confirmed", async () => {
		postMock.mockReturnValue(new Promise(() => {}));
		renderTopbarSessions([worker, orchestrator], worker.id);

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		await clickKillDialogConfirm();

		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "proj-1", sessionId: "orch-1" },
		});
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
		await userEvent.click(screen.getByRole("button", { name: "Close" }));

		expect(navigateMock).toHaveBeenCalledWith({ to: "/" });
	});

	it("renders compact project settings context without a redundant Board action", () => {
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
		expect(screen.getByText("/repo/my-app")).toHaveClass("reverb-topbar__state-label", "font-mono");
		expect(screen.queryByRole("button", { name: "Back to Board" })).not.toBeInTheDocument();
	});

	it("renders the standalone terminal identity and action", () => {
		renderSurface("standalone-terminals");

		expect(screen.getByText("Terminals")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "New terminal" })).toBeInTheDocument();
	});
});

describe("ShellTopbar session controls", () => {
	it("keeps breadcrumb, context, actions, and utilities in the shared three-zone order", () => {
		renderTopbarSessions([sessionWith()], "sess-1");

		const topbar = document.querySelector(".reverb-topbar");
		expect(topbar).not.toBeNull();
		const [identity, context, trailing] = Array.from(topbar!.children);
		expect(identity).toHaveClass("reverb-topbar__context");
		expect(context).toHaveClass("reverb-topbar__state");
		expect(trailing).toHaveClass("reverb-topbar__trailing");
		expect(within(identity as HTMLElement).getByText("do the thing")).toBeInTheDocument();
		expect(within(identity as HTMLElement).getByText("Working")).toBeInTheDocument();
		expect(context).toHaveClass("reverb-topbar__state--empty");
		expect(screen.queryByText("ao/sess-1")).not.toBeInTheDocument();

		const trailingButtons = within(trailing as HTMLElement)
			.getAllByRole("button")
			.map((button) => button.getAttribute("aria-label"));
		expect(trailingButtons).toEqual(["Kill session", "Spawn Orchestrator", "Notifications"]);
	});

	it("keeps the destructive action compact and makes the orchestrator label responsive", () => {
		renderTopbarSessions([worker], "sess-1");

		const actions = within(screen.getByRole("group", { name: "Page actions" })).getAllByRole("button");
		const labels = actions.map((button) => button.getAttribute("aria-label"));
		expect(labels).toEqual(["Kill session", "Spawn Orchestrator"]);
		expect(actions[0]).toHaveClass("reverb-topbar__control--icon");
		expect(actions[0]).not.toHaveAttribute("data-priority");
		expect(actions[0]).toHaveTextContent("");
		expect(actions[1]).toHaveClass("reverb-topbar__control--primary");
		expect(actions[1]).toHaveAttribute("data-priority", "secondary");
		expect(actions[1]).toHaveTextContent("Orchestrator");
		expect(screen.queryByRole("button", { name: /inspector panel/i })).not.toBeInTheDocument();
		expect(document.querySelector(".reverb-topbar__utility-separator")).not.toBeInTheDocument();
	});

	it("explains the icon-only orchestrator control on hover", async () => {
		renderTopbarSessions([worker], "sess-1");

		await userEvent.hover(screen.getByRole("button", { name: "Spawn Orchestrator" }));
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Spawn orchestrator");
	});

	it("moves the closed inspector reopen control after Notifications", async () => {
		useUiStore.setState({
			inspectorSessions: {
				"sess-1": { isOpen: false, view: "summary" },
				"sess-2": { isOpen: true, view: "browser" },
			},
		});
		renderTopbarSessions([worker], "sess-1");

		const utilities = screen.getByRole("group", { name: "Global utilities" });
		const labels = within(utilities)
			.getAllByRole("button")
			.map((button) => button.getAttribute("aria-label"));
		expect(labels).toEqual(["Notifications", "Open inspector panel"]);
		expect(utilities.querySelector(".reverb-topbar__zone-divider")).toBeInTheDocument();

		await userEvent.click(within(utilities).getByRole("button", { name: "Open inspector panel" }));
		expect(useUiStore.getState().inspectorSessions["sess-1"]?.isOpen).toBe(true);
		expect(useUiStore.getState().inspectorSessions["sess-2"]).toEqual({ isOpen: true, view: "browser" });
	});

	it("routes the inspector reopen control to the current worker", () => {
		useUiStore.setState({
			inspectorSessions: {
				"sess-1": { isOpen: true, view: "summary" },
				"sess-2": { isOpen: false, view: "summary" },
			},
		});
		const view = renderTopbarSessions([worker, secondWorker], "sess-1");

		expect(screen.queryByRole("button", { name: "Open inspector panel" })).not.toBeInTheDocument();

		paramsMock.sessionId = "sess-2";
		view.rerenderTopbar();

		expect(screen.getByRole("button", { name: "Open inspector panel" })).toHaveAttribute("aria-expanded", "false");
	});

	it("never renders an inspector reopen control for orchestrator sessions", () => {
		useUiStore.getState().setInspectorOpen("orch-1", false);
		renderTopbar(orchestrator);

		expect(screen.queryByRole("button", { name: "Open inspector panel" })).not.toBeInTheDocument();
	});
});

describe("TopbarKillButton", () => {
	it("explains the compact icon control on hover", async () => {
		renderKill();

		await userEvent.hover(screen.getByRole("button", { name: "Kill session" }));
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Kill session");
	});

	it("opens a compact confirmation card before killing", async () => {
		renderKill();

		const killButton = screen.getByRole("button", { name: "Kill session" });
		await userEvent.click(killButton);

		expect(postMock).not.toHaveBeenCalled();
		expect(killButton).toHaveAttribute("aria-expanded", "true");
		const confirmation = screen.getByRole("dialog", { name: "Terminate do the thing?" });
		expect(confirmation).toHaveClass("w-64", "bg-popover", "p-3");
		expect(confirmation).toHaveAttribute("data-side", "bottom");
		expect(within(confirmation).getByRole("button", { name: "No" })).toBeInTheDocument();
		expect(within(confirmation).getByRole("button", { name: "Yes, terminate session" })).toHaveTextContent("Yes");

		await clickKillDialogConfirm();

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/kill", {
			params: { path: { sessionId: "sess-1" } },
		});
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("can back out of the confirmation without killing", async () => {
		renderKill();

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		await userEvent.click(screen.getByRole("button", { name: "No" }));

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
		expect(screen.getByRole("button", { name: "Kill session" })).toBeEnabled();
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
		await clickKillDialogConfirm();
		expect(await screen.findByText("session not found")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		await clickKillDialogConfirm();

		await waitFor(() => expect(screen.queryByText("session not found")).not.toBeInTheDocument());
	});

	it("returns to the project orchestrator immediately after confirming", async () => {
		let resolveKill!: (value: { data: { ok: boolean; sessionId: string }; error: undefined }) => void;
		postMock.mockReturnValue(
			new Promise((resolve) => {
				resolveKill = resolve;
			}),
		);
		renderKill(worker, orchestrator.id);

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		await clickKillDialogConfirm();

		expect(onKilledMock).toHaveBeenCalledWith("proj-1", "orch-1");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		resolveKill({ data: { ok: true, sessionId: "sess-1" }, error: undefined });
	});

	it("shows pending and failure feedback after navigating to the orchestrator", async () => {
		let finishKill!: (value: {
			data: undefined;
			error: { message: string };
			response: { status: number };
		}) => void;
		postMock.mockReturnValue(
			new Promise((resolve) => {
				finishKill = resolve;
			}),
		);
		const view = renderTopbarSessions([worker, orchestrator], worker.id);

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		await clickKillDialogConfirm();
		paramsMock.sessionId = orchestrator.id;
		view.rerenderTopbar();

		expect(screen.getByRole("status")).toHaveTextContent("Killing do the thing");
		finishKill({
			data: undefined,
			error: { message: "runtime teardown failed" },
			response: { status: 500 },
		});

		expect(await screen.findByRole("alert")).toHaveTextContent("do the thing: runtime teardown failed");
	});

	it("falls back to the project board when no orchestrator is available", async () => {
		renderKill();

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		await clickKillDialogConfirm();

		await waitFor(() => {
			expect(onKilledMock).toHaveBeenCalledWith("proj-1", undefined);
		});
	});

	it("scopes pending state to the worker id during rapid switching", async () => {
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

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Kill session" })).toBeEnabled();

		paramsMock.sessionId = "sess-1";
		view.rerenderTopbar();
		expect(screen.getByRole("button", { name: "Killing..." })).toBeDisabled();

		resolveKill({ data: { ok: true, sessionId: "sess-1" }, error: undefined });
		await waitFor(() => expect(screen.getByRole("button", { name: "Kill session" })).toBeEnabled());
	});

	it("keeps kill failures with their worker and clears only that worker pending state", async () => {
		let resolveKill!: (value: {
			data: undefined;
			error: { message: string };
			response: { status: number };
		}) => void;
		postMock.mockReturnValue(
			new Promise((resolve) => {
				resolveKill = resolve;
			}),
		);
		const view = renderTopbarSessions([worker, secondWorker], "sess-1");

		await userEvent.click(screen.getByRole("button", { name: "Kill session" }));
		await clickKillDialogConfirm();
		paramsMock.sessionId = "sess-2";
		view.rerenderTopbar();
		resolveKill({
			data: undefined,
			error: { message: "worker one failed" },
			response: { status: 500 },
		});

		await waitFor(() => expect(view.queryClient.isMutating()).toBe(0));
		expect(screen.getByRole("button", { name: "Kill session" })).toBeEnabled();
		expect(screen.queryByText("worker one failed")).not.toBeInTheDocument();

		paramsMock.sessionId = "sess-1";
		view.rerenderTopbar();
		expect(await screen.findByText("worker one failed")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Kill session" })).toBeEnabled();
	});
});
