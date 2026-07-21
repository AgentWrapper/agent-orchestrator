import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../types/workspace";
import { useUiStore } from "../stores/ui-store";

const navigateMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const choosePathMock = vi.hoisted(() => vi.fn());

const ctx = vi.hoisted(() => {
	const workspaces: WorkspaceSummary[] = [
		{
			id: "proj-1",
			name: "app",
			path: "/repos/app",
			type: "main",
			sessions: [
				{
					id: "w-merge",
					workspaceId: "proj-1",
					workspaceName: "app",
					title: "ship banner",
					provider: "codex",
					kind: "worker",
					branch: "feature/ship",
					status: "mergeable",
					updatedAt: "2026-06-10T00:00:00Z",
					prs: [],
				},
				{
					id: "w-fix",
					workspaceId: "proj-1",
					workspaceName: "app",
					title: "fix flake",
					provider: "codex",
					kind: "worker",
					branch: "feature/fix",
					status: "working",
					updatedAt: "2026-06-10T00:00:00Z",
					prs: [],
				},
				{
					id: "w-archived",
					workspaceId: "proj-1",
					workspaceName: "app",
					title: "archived cleanup",
					provider: "codex",
					kind: "worker",
					branch: "feature/archived",
					status: "terminated",
					updatedAt: "2026-06-10T00:00:00Z",
					prs: [],
				},
				{
					id: "orch",
					workspaceId: "proj-1",
					workspaceName: "app",
					title: "orchestrate",
					provider: "codex",
					kind: "orchestrator",
					branch: "main",
					status: "working",
					updatedAt: "2026-06-10T00:00:00Z",
					prs: [],
				},
			],
		},
		{
			id: "proj-2",
			name: "lib",
			path: "/repos/lib",
			type: "main",
			sessions: [],
		},
	];
	return {
		params: {} as { projectId?: string; sessionId?: string },
		enabled: true,
		workspaces,
	};
});

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
	useParams: () => ctx.params,
}));

vi.mock("../hooks/useCommandPaletteEnabled", () => ({
	useCommandPaletteEnabled: () => ctx.enabled,
	useAppVersion: () => "0.0.0-test",
}));

vi.mock("../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: () => ({ data: ctx.workspaces }),
	workspaceQueryKey: ["workspaces"],
}));

vi.mock("../lib/shell-context", () => ({
	useShell: () => ({ createProject: vi.fn(), initializeProjectRepository: vi.fn(), daemonStatus: {} }),
}));

vi.mock("../lib/spawn-orchestrator", () => ({ spawnOrchestrator: spawnMock }));

vi.mock("./NewTaskDialog", () => ({
	NewTaskDialog: ({ open, projectId }: { open: boolean; projectId?: string }) =>
		open ? <div data-testid="new-task-dialog">new task {projectId}</div> : null,
}));

vi.mock("./CreateProjectFlow", () => ({
	CreateProjectFlow: ({ children }: { children: (state: { choosePath: () => void }) => ReactNode }) =>
		children({ choosePath: choosePathMock }),
}));

import { CommandPalette } from "./CommandPalette";

function renderPalette() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<CommandPalette />
		</QueryClientProvider>,
	);
}

function pressKey(init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
	act(() => {
		window.dispatchEvent(event);
	});
	return event;
}

function focusTerminal() {
	const xterm = document.createElement("div");
	xterm.className = "xterm";
	const input = document.createElement("textarea");
	xterm.appendChild(input);
	document.body.appendChild(xterm);
	input.focus();
	return xterm;
}

const paletteInput = () => screen.queryByPlaceholderText(/search projects/i);

beforeEach(() => {
	ctx.params = {};
	ctx.enabled = true;
	navigateMock.mockReset();
	spawnMock.mockReset();
	choosePathMock.mockReset();
	act(() => {
		useUiStore.setState({
			isCommandPaletteOpen: false,
			themePreference: "dark",
			resolvedTheme: "dark",
			restartingProjectIds: new Set(),
		});
	});
});

afterEach(() => {
	document.querySelectorAll(".xterm, [data-fake-modal]").forEach((node) => node.remove());
});

describe("CommandPalette gating", () => {
	it("renders nothing and binds no shortcut on a disabled (stable) build", () => {
		ctx.enabled = false;
		renderPalette();
		pressKey({ key: "k", metaKey: true });
		expect(paletteInput()).toBeNull();
		expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
	});
});

describe("CommandPalette shortcut (Windows/Linux)", () => {
	it("opens on Ctrl+K and toggles closed on a second Ctrl+K", async () => {
		renderPalette();
		pressKey({ key: "k", ctrlKey: true });
		expect(await screen.findByPlaceholderText(/search projects/i)).toBeInTheDocument();
		pressKey({ key: "k", ctrlKey: true });
		await waitFor(() => expect(paletteInput()).toBeNull());
	});

	it("ignores Cmd+K off macOS (the opening modifier is platform-gated)", () => {
		renderPalette();
		const event = pressKey({ key: "k", metaKey: true });
		expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
		expect(event.defaultPrevented).toBe(false);
	});

	it("yields Ctrl+K to a focused terminal (does not open, does not preventDefault)", () => {
		renderPalette();
		focusTerminal();
		const event = pressKey({ key: "k", ctrlKey: true });
		expect(event.defaultPrevented).toBe(false);
		expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
	});

	it("does not open over an already-open modal", () => {
		renderPalette();
		const modal = document.createElement("div");
		modal.setAttribute("role", "dialog");
		modal.setAttribute("data-state", "open");
		modal.setAttribute("data-fake-modal", "");
		document.body.appendChild(modal);
		pressKey({ key: "k", ctrlKey: true });
		expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
	});

	it.each([
		{ label: "Cmd", init: { key: "1", metaKey: true } satisfies KeyboardEventInit },
		{ label: "Ctrl", init: { key: "1", ctrlKey: true } satisfies KeyboardEventInit },
	])("swallows $label+digit project-switch while the palette is open", async ({ init }) => {
		renderPalette();
		act(() => useUiStore.getState().setCommandPaletteOpen(true));
		await screen.findByPlaceholderText(/search projects/i);
		expect(pressKey(init).defaultPrevented).toBe(true);
	});

	it("does not swallow Cmd+digit while the palette is closed (project switch still works)", () => {
		renderPalette();
		const event = pressKey({ key: "1", metaKey: true });
		expect(event.defaultPrevented).toBe(false);
	});
});

describe("CommandPalette shortcut (macOS)", () => {
	beforeEach(() => {
		vi.stubGlobal("navigator", {
			...globalThis.navigator,
			userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
		});
	});

	afterEach(() => vi.unstubAllGlobals());

	it("opens on Cmd+K", async () => {
		renderPalette();
		pressKey({ key: "k", metaKey: true });
		expect(await screen.findByPlaceholderText(/search projects/i)).toBeInTheDocument();
	});

	it("opens on Cmd+K even when a terminal is focused", async () => {
		renderPalette();
		focusTerminal();
		pressKey({ key: "k", metaKey: true });
		expect(await screen.findByPlaceholderText(/search projects/i)).toBeInTheDocument();
	});

	it("ignores Ctrl+K on macOS, leaving the system kill-to-end-of-line binding alone", () => {
		renderPalette();
		const event = pressKey({ key: "k", ctrlKey: true });
		expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
		expect(event.defaultPrevented).toBe(false);
	});
});

describe("CommandPalette search + Enter", () => {
	it("jumps to a session by typing a query and pressing Enter", async () => {
		ctx.params = {};
		renderPalette();
		act(() => useUiStore.getState().setCommandPaletteOpen(true));
		const input = await screen.findByPlaceholderText(/search projects/i);

		fireEvent.change(input, { target: { value: "ship" } });
		await waitFor(() => {
			const selected = document.querySelector('[cmdk-item][data-selected="true"]');
			expect(selected?.textContent).toContain("ship banner");
		});
		fireEvent.keyDown(input, { key: "Enter" });

		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "proj-1", sessionId: "w-merge" },
		});
		await waitFor(() => expect(paletteInput()).toBeNull());
	});

	it("jumps to an archived (terminated) session via search + Enter", async () => {
		ctx.params = {};
		renderPalette();
		act(() => useUiStore.getState().setCommandPaletteOpen(true));
		const input = await screen.findByPlaceholderText(/search projects/i);

		expect(screen.queryByText("archived cleanup")).toBeNull();

		fireEvent.change(input, { target: { value: "archived" } });
		await waitFor(() => {
			const selected = document.querySelector('[cmdk-item][data-selected="true"]');
			expect(selected?.textContent).toContain("archived cleanup");
		});
		fireEvent.keyDown(input, { key: "Enter" });

		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "proj-1", sessionId: "w-archived" },
		});
	});
});

describe("CommandPalette actions", () => {
	it("shows disabled New task reason, skips it for selection, and ignores clicks", async () => {
		ctx.params = {};
		renderPalette();
		act(() => useUiStore.getState().setCommandPaletteOpen(true));
		await screen.findByPlaceholderText(/search projects/i);
		expect(screen.getByText("No current project")).toBeInTheDocument();
		await waitFor(() => {
			const selected = document.querySelector('[cmdk-item][data-selected="true"]');
			expect(selected?.textContent).not.toContain("No current project");
			expect(selected?.getAttribute("aria-disabled")).not.toBe("true");
		});
		fireEvent.click(screen.getByText("New task"));
		expect(navigateMock).not.toHaveBeenCalled();
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("does not spawn Open orchestrator while the project is restarting", async () => {
		ctx.params = { projectId: "proj-1" };
		act(() => useUiStore.setState({ restartingProjectIds: new Set(["proj-1"]) }));
		renderPalette();
		act(() => useUiStore.getState().setCommandPaletteOpen(true));
		await screen.findByPlaceholderText(/search projects/i);
		fireEvent.click(screen.getByText("Open orchestrator"));
		expect(spawnMock).not.toHaveBeenCalled();
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("navigates and closes when selecting a project", async () => {
		ctx.params = {};
		renderPalette();
		act(() => useUiStore.getState().setCommandPaletteOpen(true));
		await screen.findByPlaceholderText(/search projects/i);
		fireEvent.click(screen.getByText("lib"));
		expect(navigateMock).toHaveBeenCalledWith({ to: "/projects/$projectId", params: { projectId: "proj-2" } });
		await waitFor(() => expect(paletteInput()).toBeNull());
	});

	it("re-highlights the first result after the query changes", async () => {
		ctx.params = { projectId: "proj-1" };
		renderPalette();
		act(() => useUiStore.getState().setCommandPaletteOpen(true));
		const input = await screen.findByPlaceholderText(/search projects/i);
		fireEvent.change(input, { target: { value: "ship" } });
		await waitFor(() => {
			const selected = document.querySelector('[cmdk-item][data-selected="true"]');
			expect(selected?.textContent).toContain("ship banner");
		});
		fireEvent.change(input, { target: { value: "fix" } });
		await waitFor(() => {
			const selected = document.querySelector('[cmdk-item][data-selected="true"]');
			expect(selected?.textContent).toContain("fix flake");
		});
	});

	it("spawns only once when Open orchestrator is selected twice (in-flight guard)", async () => {
		ctx.params = { projectId: "proj-2" };
		spawnMock.mockReturnValueOnce(new Promise<string>(() => {}));
		renderPalette();
		act(() => useUiStore.getState().setCommandPaletteOpen(true));
		await screen.findByPlaceholderText(/search projects/i);
		const item = screen.getByText("Open orchestrator");
		fireEvent.click(item);
		fireEvent.click(item);
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	it("keeps the palette open and shows an error when spawning an orchestrator fails", async () => {
		ctx.params = { projectId: "proj-2" };
		spawnMock.mockRejectedValueOnce(new Error("daemon down"));
		renderPalette();
		act(() => useUiStore.getState().setCommandPaletteOpen(true));
		await screen.findByPlaceholderText(/search projects/i);
		fireEvent.click(screen.getByText("Open orchestrator"));
		expect(await screen.findByRole("alert")).toHaveTextContent("daemon down");
		expect(spawnMock).toHaveBeenCalledWith("proj-2", "command_palette");
		expect(useUiStore.getState().isCommandPaletteOpen).toBe(true);
	});

	it("toggles the theme and closes", async () => {
		renderPalette();
		act(() => useUiStore.getState().setCommandPaletteOpen(true));
		await screen.findByPlaceholderText(/search projects/i);
		fireEvent.click(screen.getByText("Toggle theme"));
		expect(useUiStore.getState().resolvedTheme).toBe("light");
		await waitFor(() => expect(paletteInput()).toBeNull());
	});

	it("opens the new-project path picker and closes the palette", async () => {
		renderPalette();
		act(() => useUiStore.getState().setCommandPaletteOpen(true));
		await screen.findByPlaceholderText(/search projects/i);
		fireEvent.click(screen.getByText("New project"));
		await waitFor(() => expect(choosePathMock).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(paletteInput()).toBeNull());
	});
});
