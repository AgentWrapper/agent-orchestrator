import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense, type ComponentType, type PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../stores/ui-store";
import type { WorkspaceSummary } from "../types/workspace";

const shellMocks = vi.hoisted(() => {
	const state = {
		newSessionListener: undefined as (() => void) | undefined,
		keyboardShortcutsListener: undefined as (() => void) | undefined,
		routeParams: {} as { projectId?: string; sessionId?: string },
		workspaces: [] as WorkspaceSummary[],
	};
	return {
		navigate: vi.fn(),
		setTrafficLightsInset: vi.fn(async () => undefined),
		onNewSessionShortcut: vi.fn((listener: () => void) => {
			state.newSessionListener = listener;
			return vi.fn();
		}),
		onKeyboardShortcutsHelp: vi.fn((listener: () => void) => {
			state.keyboardShortcutsListener = listener;
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
	aoBridge: {
		app: {
			onNewSessionShortcut: shellMocks.onNewSessionShortcut,
			onKeyboardShortcutsHelp: shellMocks.onKeyboardShortcutsHelp,
		},
		window: {
			setTrafficLightsInset: shellMocks.setTrafficLightsInset,
		},
	},
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
vi.mock("../components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("../components/OrchestratorReplacementDialog", () => ({ OrchestratorReplacementDialog: () => null }));
vi.mock("../components/ShellTopbar", () => ({ ShellTopbar: () => null }));
vi.mock("../components/TitlebarNav", async () => {
	const { useUiStore: useStore } = await vi.importActual<typeof import("../stores/ui-store")>("../stores/ui-store");
	return {
		TitlebarNav: ({ onSidebarPreviewEnter }: { onSidebarPreviewEnter?: () => void }) => {
			const isSidebarOpen = useStore((state) => state.isSidebarOpen);
			const toggleSidebar = useStore((state) => state.toggleSidebar);
			return (
				<button
					aria-label={isSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
					onClick={toggleSidebar}
					onPointerEnter={onSidebarPreviewEnter}
					type="button"
				/>
			);
		},
	};
});
vi.mock("../components/WindowTitlebar", () => ({ WindowTitlebar: () => null }));
vi.mock("../components/KeyboardShortcutsDialog", () => ({
	KeyboardShortcutsDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="keyboard-shortcuts" /> : null),
}));
vi.mock("../lib/shell-context", () => ({
	ShellProvider: ({ children }: PropsWithChildren) => children,
}));
vi.mock("../components/ui/sidebar", () => ({
	SidebarProvider: ({ children, open }: PropsWithChildren<{ open?: boolean }>) => (
		<div data-open={open ? "true" : "false"} data-testid="sidebar-provider">
			{children}
		</div>
	),
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
		Sidebar: ({ isOverlay, onPreviewLeave }: { isOverlay?: boolean; onPreviewLeave?: () => void }) => {
			const nonce = useStore((state) => state.createProjectNonce);
			return (
				<div data-overlay={isOverlay ? "true" : "false"} data-testid="sidebar" onPointerLeave={onPreviewLeave}>
					{nonce > 0 ? <div data-testid="create-project-flow" /> : null}
				</div>
			);
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
	await waitFor(() => expect(shellMocks.onKeyboardShortcutsHelp).toHaveBeenCalledTimes(1));
}

function emitShortcut() {
	const listener = shellMocks.state.newSessionListener;
	if (!listener) throw new Error("shell shortcut listener was not registered");
	act(() => listener());
}

beforeEach(() => {
	shellMocks.navigate.mockReset();
	shellMocks.onNewSessionShortcut.mockClear();
	shellMocks.onKeyboardShortcutsHelp.mockClear();
	shellMocks.setTrafficLightsInset.mockClear();
	shellMocks.state.newSessionListener = undefined;
	shellMocks.state.keyboardShortcutsListener = undefined;
	shellMocks.state.routeParams = {};
	shellMocks.state.workspaces = workspaces;
	useUiStore.setState({ createProjectNonce: 0, isSidebarOpen: true, newTaskRequest: null });
});

describe("shell sidebar hover preview", () => {
	it("moves native traffic lights only with persistent sidebar state", async () => {
		await renderShell();
		await waitFor(() => expect(shellMocks.setTrafficLightsInset).toHaveBeenLastCalledWith(false));

		fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
		await waitFor(() => expect(shellMocks.setTrafficLightsInset).toHaveBeenLastCalledWith(true));

		fireEvent.pointerEnter(screen.getByRole("button", { name: "Expand sidebar" }));
		expect(shellMocks.setTrafficLightsInset).toHaveBeenCalledTimes(2);

		fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
		await waitFor(() => expect(shellMocks.setTrafficLightsInset).toHaveBeenLastCalledWith(false));
	});

	it("temporarily overlays a collapsed sidebar from the titlebar toggle and closes after pointer leave", async () => {
		useUiStore.setState({ isSidebarOpen: false });
		await renderShell();

		const provider = screen.getByTestId("sidebar-provider");
		const sidebar = screen.getByTestId("sidebar");
		const previewTrigger = screen.getByRole("button", { name: "Expand sidebar" });
		expect(screen.queryByRole("button", { name: "Preview sidebar" })).not.toBeInTheDocument();

		expect(provider).toHaveAttribute("data-open", "false");
		fireEvent.pointerEnter(previewTrigger);

		expect(provider).toHaveAttribute("data-open", "true");
		expect(sidebar).toHaveAttribute("data-overlay", "true");
		expect(useUiStore.getState().isSidebarOpen).toBe(false);

		fireEvent.pointerMove(window, { clientX: 500, clientY: 300 });
		await waitFor(() => expect(provider).toHaveAttribute("data-open", "false"));
		expect(useUiStore.getState().isSidebarOpen).toBe(false);
	});

	it("pins the sidebar open when the titlebar toggle is clicked", async () => {
		useUiStore.setState({ isSidebarOpen: false });
		await renderShell();

		const previewTrigger = screen.getByRole("button", { name: "Expand sidebar" });
		fireEvent.pointerEnter(previewTrigger);
		fireEvent.click(previewTrigger);

		expect(useUiStore.getState().isSidebarOpen).toBe(true);
		expect(screen.getByTestId("sidebar-provider")).toHaveAttribute("data-open", "true");
		expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
	});
});

describe("shell keyboard-shortcuts help subscription", () => {
	it("opens the keyboard-shortcuts dialog", async () => {
		await renderShell();

		const listener = shellMocks.state.keyboardShortcutsListener;
		if (!listener) throw new Error("keyboard-shortcuts listener was not registered");
		act(() => listener());

		expect(screen.getByTestId("keyboard-shortcuts")).toBeInTheDocument();
	});
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
