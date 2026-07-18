import { act, render, screen, waitFor } from "@testing-library/react";
import { Suspense, type ComponentType, type PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../stores/ui-store";
import type { WorkspaceSummary } from "../types/workspace";

const shellMocks = vi.hoisted(() => {
	const state = {
		listener: undefined as (() => void) | undefined,
		routeParams: {} as { projectId?: string; sessionId?: string },
		workspaces: [] as WorkspaceSummary[],
	};
	return {
		navigate: vi.fn(),
		onNewSessionShortcut: vi.fn((listener: () => void) => {
			state.listener = listener;
			return vi.fn();
		}),
		queryClient: {
			ensureQueryData: vi.fn(),
			fetchQuery: vi.fn(),
			invalidateQueries: vi.fn(),
			setQueryData: vi.fn(),
		},
		state,
	};
});

vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => shellMocks.queryClient,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: unknown) => ({ options }),
	Outlet: () => null,
	useMatchRoute: () => () => false,
	useNavigate: () => shellMocks.navigate,
	useParams: () => shellMocks.state.routeParams,
}));

vi.mock("../lib/bridge", () => ({
	aoBridge: { app: { onNewSessionShortcut: shellMocks.onNewSessionShortcut } },
}));

vi.mock("../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: () => ({ data: shellMocks.state.workspaces, isError: false }),
	workspaceQueryKey: ["workspaces"],
	workspaceQueryOptions: {},
}));

vi.mock("../hooks/useDaemonStatus", () => ({
	useDaemonStatus: () => ({ state: "stopped" }),
}));

vi.mock("../hooks/useAgentsQuery", () => ({
	agentsQueryKey: ["agents"],
	agentsQueryOptions: {},
	refreshAgents: vi.fn(),
}));

vi.mock("../components/NotificationCenter", () => ({ NotificationRuntime: () => null }));
vi.mock("../components/OrchestratorReplacementDialog", () => ({ OrchestratorReplacementDialog: () => null }));
vi.mock("../components/ShellTopbar", () => ({ ShellTopbar: () => null }));
vi.mock("../components/TitlebarNav", () => ({ TitlebarNav: () => null }));
vi.mock("../components/WindowTitlebar", () => ({ WindowTitlebar: () => null }));
vi.mock("../lib/shell-context", () => ({
	ShellProvider: ({ children }: PropsWithChildren) => children,
}));
vi.mock("../components/ui/sidebar", () => ({
	SidebarProvider: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));

vi.mock("../components/GlobalNewTaskDialog", async () => {
	const { useUiStore: useStore } = await vi.importActual<typeof import("../stores/ui-store")>("../stores/ui-store");
	return {
		GlobalNewTaskDialog: () => {
			const request = useStore((state) => state.newTaskRequest);
			return request ? <div data-testid="new-task-flow" data-project={request.projectId} /> : null;
		},
	};
});

vi.mock("../components/Sidebar", async () => {
	const { useUiStore: useStore } = await vi.importActual<typeof import("../stores/ui-store")>("../stores/ui-store");
	return {
		Sidebar: () => {
			const nonce = useStore((state) => state.createProjectNonce);
			return nonce > 0 ? <div data-testid="create-project-flow" /> : null;
		},
	};
});

import { Route } from "../routes/_shell";

const workspaces = [
	{
		id: "proj-1",
		name: "Project One",
		path: "/one",
		sessions: [{ id: "sess-1" }],
	},
] as unknown as WorkspaceSummary[];

async function renderShell() {
	const ShellRoute = Route.options.component as ComponentType;
	await act(async () => {
		render(
			<Suspense fallback={null}>
				<ShellRoute />
			</Suspense>,
		);
	});
	await waitFor(() => expect(shellMocks.onNewSessionShortcut).toHaveBeenCalledTimes(1));
}

function emitShortcut() {
	const listener = shellMocks.state.listener;
	if (!listener) throw new Error("shell shortcut listener was not registered");
	act(() => listener());
}

beforeEach(() => {
	shellMocks.navigate.mockReset();
	shellMocks.onNewSessionShortcut.mockClear();
	shellMocks.state.listener = undefined;
	shellMocks.state.routeParams = {};
	shellMocks.state.workspaces = workspaces;
	useUiStore.setState({ createProjectNonce: 0, newTaskRequest: null });
});

describe("shell new-session shortcut subscription", () => {
	it("opens the new-task flow for the route project", async () => {
		shellMocks.state.routeParams = { projectId: "proj-1" };
		await renderShell();

		emitShortcut();

		expect(screen.getByTestId("new-task-flow")).toHaveAttribute("data-project", "proj-1");
		expect(screen.queryByTestId("create-project-flow")).not.toBeInTheDocument();
	});

	it("opens the new-task flow for the project owning the current session", async () => {
		shellMocks.state.routeParams = { sessionId: "sess-1" };
		await renderShell();

		emitShortcut();

		expect(screen.getByTestId("new-task-flow")).toHaveAttribute("data-project", "proj-1");
	});

	it("opens the create-project flow when no project is in scope", async () => {
		await renderShell();

		emitShortcut();

		expect(screen.getByTestId("create-project-flow")).toBeInTheDocument();
		expect(screen.queryByTestId("new-task-flow")).not.toBeInTheDocument();
	});
});
