import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "../types/workspace";
import { CenterPane } from "./CenterPane";
import { TooltipProvider } from "./ui/tooltip";

const shortcutMocks = vi.hoisted(() => ({
	closeListener: undefined as (() => void) | undefined,
	closeableStates: [] as boolean[],
}));

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		app: {
			setCloseShellTerminalShortcutEnabled: (enabled: boolean) => shortcutMocks.closeableStates.push(enabled),
			onCloseShellTerminalShortcut: (listener: () => void) => {
				shortcutMocks.closeListener = listener;
				return () => {
					if (shortcutMocks.closeListener === listener) shortcutMocks.closeListener = undefined;
				};
			},
		},
	},
}));

// The terminal body pulls in xterm/SSE machinery irrelevant to the header under test.
vi.mock("./TerminalPane", () => ({
	TerminalPane: () => <div>terminal body</div>,
}));

const worker = {
	id: "sess-1",
	workspaceId: "proj-1",
	workspaceName: "my-app",
	title: "do the thing",
	provider: "claude-code",
	kind: "worker",
	branch: "ao/sess-1",
	status: "working",
	updatedAt: "2026-06-10T00:00:00Z",
	activity: { state: "active", lastActivityAt: "2026-06-10T00:00:00Z" },
	prs: [],
} satisfies WorkspaceSession;
const secondWorker = {
	...worker,
	id: "sess-2",
	title: "review the change",
	branch: "ao/sess-2",
} satisfies WorkspaceSession;

function renderCenterPane(props: Partial<ComponentProps<typeof CenterPane>> = {}) {
	return render(
		<TooltipProvider>
			<CenterPane daemonReady theme="dark" {...props} />
		</TooltipProvider>,
	);
}

beforeEach(() => {
	shortcutMocks.closeListener = undefined;
	shortcutMocks.closeableStates.length = 0;
});

describe("CenterPane toolbar session label", () => {
	const makeShells = (count: number) =>
		Array.from({ length: count }, (_, i) => ({
			handleId: `h-${i}`,
			title: `agent-orchestrator-${i}`,
			workingDir: "/tmp/ws",
			createdAt: "2026-07-22T00:00:00Z",
		}));

	it("shows the session display name for a worker", () => {
		renderCenterPane({ session: worker });
		expect(screen.getByText("do the thing")).toBeInTheDocument();
		expect(screen.queryByText("sess-1")).not.toBeInTheDocument();
	});

	it("shows the active session as a compact padded tab without a generic Terminal label", () => {
		render(<CenterPane session={worker} theme="dark" daemonReady />);
		const sessionTab = screen.getByRole("tab", { name: "do the thing" });
		expect(sessionTab).toHaveAttribute("aria-current", "true");
		expect(sessionTab).toHaveClass("session-pane-tab__label");
		expect(sessionTab.parentElement).toHaveClass("session-pane-tab", "bg-interactive-active");
		expect(sessionTab.closest(".h-inspector-tabs")).toHaveClass("px-1.5");
		expect(document.querySelector('button[aria-label="Scroll tabs left"]')).toHaveClass("hidden");
		expect(sessionTab.closest(".terminal-pane-frame")).toHaveClass("px-px");
		expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();
		expect(screen.queryByText("sess-1")).not.toBeInTheDocument();
	});

	it("renders project sessions as tabs and opens a sibling session", () => {
		const onSelectProjectSession = vi.fn();
		render(
			<CenterPane
				session={worker}
				projectSessions={[worker, secondWorker]}
				onSelectProjectSession={onSelectProjectSession}
				theme="dark"
				daemonReady
			/>,
		);

		expect(screen.getByRole("tab", { name: "do the thing" })).toHaveAttribute("aria-current", "true");
		fireEvent.click(screen.getByRole("tab", { name: "review the change" }));
		expect(onSelectProjectSession).toHaveBeenCalledWith(secondWorker);
	});

	it("uses the same compact frame for Orchestrator and added session tabs", () => {
		const orchestratorSession = {
			...worker,
			id: "sess-orch",
			title: "orchestrator",
			kind: "orchestrator",
		} satisfies WorkspaceSession;
		const dummySession = { ...secondWorker, title: "dummy-session" } satisfies WorkspaceSession;
		const dummyTwo = { ...secondWorker, id: "sess-3", title: "dummy-2" } satisfies WorkspaceSession;

		render(
			<CenterPane
				session={orchestratorSession}
				projectSessions={[orchestratorSession, dummySession, dummyTwo]}
				theme="dark"
				daemonReady
			/>,
		);

		for (const label of ["Orchestrator", "dummy-session", "dummy-2"]) {
			const tab = screen.getByRole("tab", { name: label });
			expect(tab.parentElement).toHaveClass("session-pane-tab");
			expect(tab.querySelector("img")).toHaveClass("size-icon-2xs");
		}
		expect(screen.getByRole("button", { name: "Close session tab dummy-session" })).toHaveClass("size-control-xs");
		expect(screen.getByRole("button", { name: "Close session tab dummy-2" })).toHaveClass("size-control-xs");
	});

	it("adds workers and terminals only through the tab launcher", () => {
		const onAddProjectSession = vi.fn();
		const onNewShellTerminal = vi.fn();
		render(
			<CenterPane
				session={worker}
				projectSessions={[worker]}
				availableProjectSessions={[secondWorker]}
				onAddProjectSession={onAddProjectSession}
				onNewShellTerminal={onNewShellTerminal}
				theme="dark"
				daemonReady
			/>,
		);

		expect(screen.queryByRole("button", { name: "review the change" })).not.toBeInTheDocument();
		fireEvent.pointerDown(screen.getByRole("button", { name: "Add tab" }), { button: 0, ctrlKey: false });
		fireEvent.click(screen.getByRole("menuitem", { name: /review the change/ }));
		expect(onAddProjectSession).toHaveBeenCalledWith(secondWorker);

		fireEvent.pointerDown(screen.getByRole("button", { name: "Add tab" }), { button: 0, ctrlKey: false });
		fireEvent.click(screen.getByRole("menuitem", { name: "New terminal" }));
		expect(onNewShellTerminal).toHaveBeenCalledOnce();
	});

	it("limits a large session list, then expands it into a searchable scroll area", () => {
		const sessions = Array.from({ length: 7 }, (_, index) => ({
			...secondWorker,
			id: `sess-${index + 2}`,
			title: `Worker ${index + 1}`,
		}));
		render(
			<CenterPane
				session={worker}
				projectSessions={[worker]}
				availableProjectSessions={sessions}
				theme="dark"
				daemonReady
			/>,
		);

		fireEvent.pointerDown(screen.getByRole("button", { name: "Add tab" }), { button: 0, ctrlKey: false });
		const search = screen.getByRole("textbox", { name: "Search sessions" });
		const terminal = screen.getByRole("menuitem", { name: "New terminal" });
		expect(terminal.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.getByRole("menuitem", { name: /Worker 5/ })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: /Worker 6/ })).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("menuitem", { name: "Show all sessions" }));
		const lastSession = screen.getByRole("menuitem", { name: /Worker 7/ });
		expect(lastSession).toBeInTheDocument();
		expect(lastSession.parentElement).toHaveClass("h-52", "overflow-y-auto");

		fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), {
			target: { value: "Worker 7" },
		});
		expect(screen.getByRole("menuitem", { name: /Worker 7/ })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: /Worker 1/ })).not.toBeInTheDocument();
	});

	it("uses the inspector tab height for the terminal header", () => {
		render(<CenterPane session={worker} theme="dark" daemonReady />);

		const header = screen.getByRole("tab", { name: "do the thing" }).closest(".h-inspector-tabs");
		expect(header).toHaveClass("h-inspector-tabs");
	});

	it("uses the session tab to return from a selected shell", () => {
		const onSelectSessionTerminal = vi.fn();
		render(
			<CenterPane
				session={worker}
				terminalTarget={{ generation: "2026-07-22T00:00:00Z", kind: "shell", handleId: "h-1", sessionId: "sess-1", title: "Shell" }}
				onSelectSessionTerminal={onSelectSessionTerminal}
				theme="dark"
				daemonReady
			/>,
		);

		const sessionTab = screen.getByRole("tab", { name: "do the thing" });
		expect(sessionTab).toHaveAttribute("aria-current", "false");
		fireEvent.click(sessionTab);
		expect(onSelectSessionTerminal).toHaveBeenCalledOnce();
	});

	it("lets tabs shrink into a scrollable strip instead of overflowing onto the controls", () => {
		const shells = makeShells(8);
		render(<CenterPane session={worker} shellTerminals={shells} theme="dark" daemonReady />);

		const scrollRegion = document.querySelector(".overflow-x-auto");
		expect(scrollRegion).toHaveClass("scrollbar-none", "min-w-flex-min", "flex-1");
		for (const tab of screen.getAllByTitle(/^\/tmp\/ws/)) {
			expect(tab.parentElement).toHaveClass("min-w-shell-tab-min");
			expect(tab.parentElement).not.toHaveClass("min-w-16", "shrink-0");
			expect(tab).toHaveClass("min-w-0", "w-full");
		}
		// jsdom reports no overflow, so the inactive indicator stays mounted without reserving layout space.
		const rightScrollButton = document.querySelector('button[aria-label="Scroll tabs right"]');
		expect(rightScrollButton).toBeDisabled();
		expect(rightScrollButton).toHaveClass("hidden");

		// The display controls share the fixed trailing toolbar area and never
		// overlap the independently scrolling tab strip.
		const tabBarRow = screen.getByRole("tab", { name: "do the thing" }).closest("div")?.parentElement;
		expect(tabBarRow).not.toBeNull();
		expect(tabBarRow?.contains(screen.getByRole("button", { name: /fullscreen/i }))).toBe(true);
		expect(screen.getByRole("button", { name: "Add tab" })).toHaveClass("bg-interactive-active");
	});

	it("reveals scroll chevrons only when the tab strip actually overflows", () => {
		const shells = makeShells(8);
		render(<CenterPane session={worker} shellTerminals={shells} theme="dark" daemonReady />);

		const scrollRegion = document.querySelector(".overflow-x-auto") as HTMLElement;
		Object.defineProperty(scrollRegion, "clientWidth", { value: 100, configurable: true });
		Object.defineProperty(scrollRegion, "scrollWidth", { value: 500, configurable: true });
		fireEvent.scroll(scrollRegion);

		expect(screen.getByRole("button", { name: "Scroll tabs right" })).toBeEnabled();
		expect(document.querySelector('button[aria-label="Scroll tabs left"]')).toHaveClass("hidden");

		Object.defineProperty(scrollRegion, "scrollLeft", { value: 400, configurable: true });
		fireEvent.scroll(scrollRegion);
		expect(screen.getByRole("button", { name: "Scroll tabs left" })).toBeEnabled();
		expect(document.querySelector('button[aria-label="Scroll tabs right"]')).toHaveClass("hidden");
	});

	it("scrolls the tab strip horizontally with the mouse wheel", () => {
		const shells = makeShells(8);
		render(<CenterPane session={worker} shellTerminals={shells} theme="dark" daemonReady />);

		const scrollRegion = document.querySelector(".overflow-x-auto") as HTMLElement;
		Object.defineProperty(scrollRegion, "clientWidth", { value: 100, configurable: true });
		Object.defineProperty(scrollRegion, "scrollWidth", { value: 500, configurable: true });
		const scrollBy = vi.fn();
		Object.defineProperty(scrollRegion, "scrollBy", { value: scrollBy, configurable: true });

		fireEvent.wheel(scrollRegion, { deltaY: 80 });
		expect(scrollBy).toHaveBeenCalledWith({ left: 80 });

		// Ctrl+wheel is terminal font zoom, not tab scrolling.
		scrollBy.mockClear();
		fireEvent.wheel(scrollRegion, { deltaY: 80, ctrlKey: true });
		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("renders auxiliary shell tabs with the connected compact appearance", () => {
		const [shell] = makeShells(1);
		renderCenterPane({ session: worker, shellTerminals: [shell] });

		const shellTab = screen.getByRole("tab", { name: shell.title });
		expect(shellTab.parentElement).toHaveClass("min-w-shell-tab-min", "w-shell-tab-connected");
		expect(shellTab.parentElement).not.toHaveClass("session-pane-tab");
	});

	it("closes only the selected auxiliary terminal from the application shortcut", () => {
		const [shell] = makeShells(1);
		const onCloseShellTerminal = vi.fn();
		renderCenterPane({
			session: worker,
			shellTerminals: [shell],
			terminalTarget: {
				generation: shell.createdAt,
				kind: "shell",
				handleId: shell.handleId,
				title: shell.title,
			},
			onCloseShellTerminal,
		});

		act(() => shortcutMocks.closeListener?.());
		expect(onCloseShellTerminal).toHaveBeenCalledWith(shell.handleId);
	});

	it("keeps the permanent main terminal open when the close shortcut fires", () => {
		const onCloseShellTerminal = vi.fn();
		renderCenterPane({ session: worker, onCloseShellTerminal });

		act(() => shortcutMocks.closeListener?.());
		expect(onCloseShellTerminal).not.toHaveBeenCalled();
	});

	it("enables the global close shortcut only while a closeable shell is active", () => {
		const [shell] = makeShells(1);
		const view = renderCenterPane({
			session: worker,
			shellTerminals: [shell],
			terminalTarget: {
				generation: shell.createdAt,
				kind: "shell",
				handleId: shell.handleId,
				title: shell.title,
			},
			onCloseShellTerminal: vi.fn(),
		});

		expect(shortcutMocks.closeableStates.at(-1)).toBe(true);
		view.unmount();
		expect(shortcutMocks.closeableStates.at(-1)).toBe(false);
	});

	it("shows 'Orchestrator' for an orchestrator session", () => {
		renderCenterPane({
			session: { ...worker, id: "sess-orch", kind: "orchestrator" },
		});
		expect(screen.getByText("Orchestrator")).toBeInTheDocument();
	});

	it("shows 'No session' when there is no session", () => {
		renderCenterPane();
		expect(screen.getByText("No session")).toBeInTheDocument();
	});

	it("uses roving keyboard focus to select terminal tabs", () => {
		const shells = makeShells(2);
		const onSelectShellTerminal = vi.fn();
		const onSelectSessionTerminal = vi.fn();
		const onRenameShellTerminal = vi.fn();
		renderCenterPane({
			session: worker,
			shellTerminals: shells,
			onSelectSessionTerminal,
			onSelectShellTerminal,
			onRenameShellTerminal,
		});

		const sessionTab = screen.getByRole("tab", { name: /^do the thing/ });
		const firstShellTab = screen.getByRole("tab", {
			name: "agent-orchestrator-0",
		});
		expect(sessionTab).toHaveAttribute("tabindex", "0");
		expect(firstShellTab).toHaveAttribute("tabindex", "-1");

		sessionTab.focus();
		fireEvent.keyDown(sessionTab, { key: "ArrowRight" });
		expect(firstShellTab).toHaveFocus();
		expect(onSelectShellTerminal).toHaveBeenCalledWith("h-0");

		fireEvent.keyDown(firstShellTab, { key: "Home" });
		expect(sessionTab).toHaveFocus();
		expect(onSelectSessionTerminal).toHaveBeenCalledOnce();

		// Revisiting a tab quickly by keyboard must not count as a double-click
		// and enter rename mode.
		fireEvent.keyDown(sessionTab, { key: "ArrowRight" });
		expect(firstShellTab).toHaveFocus();
		expect(screen.queryByRole("textbox", { name: /rename terminal/i })).not.toBeInTheDocument();
	});
});
