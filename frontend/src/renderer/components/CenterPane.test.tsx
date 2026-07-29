import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "../types/workspace";
import { CenterPane } from "./CenterPane";

// The terminal body pulls in xterm/SSE machinery irrelevant to the header under test.
vi.mock("./TerminalPane", () => ({ TerminalPane: () => <div>terminal body</div> }));

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
	prs: [],
} satisfies WorkspaceSession;
const secondWorker = {
	...worker,
	id: "sess-2",
	title: "review the change",
	branch: "ao/sess-2",
} satisfies WorkspaceSession;

describe("CenterPane toolbar session label", () => {
	const makeShells = (count: number) =>
		Array.from({ length: count }, (_, i) => ({
			handleId: `h-${i}`,
			title: `agent-orchestrator-${i}`,
			workingDir: "/tmp/ws",
			createdAt: "2026-07-22T00:00:00Z",
		}));

	it("shows the active session as a compact padded tab without a generic Terminal label", () => {
		render(<CenterPane session={worker} theme="dark" daemonReady />);
		const sessionTab = screen.getByRole("button", { name: "do the thing" });
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

		expect(screen.getByRole("button", { name: "do the thing" })).toHaveAttribute("aria-current", "true");
		fireEvent.click(screen.getByRole("button", { name: "review the change" }));
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
			expect(screen.getByRole("button", { name: label }).parentElement).toHaveClass("session-pane-tab");
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
		fireEvent.click(screen.getByRole("menuitem", { name: "Terminal" }));
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
		const terminal = screen.getByRole("menuitem", { name: "Terminal" });
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

	it("uses a compact Orchestrator tab for an orchestrator session", () => {
		render(<CenterPane session={{ ...worker, id: "sess-orch", kind: "orchestrator" }} theme="dark" daemonReady />);
		const orchestratorTab = screen.getByRole("button", { name: "Orchestrator" });
		expect(orchestratorTab).toHaveAttribute("aria-current", "true");
		expect(orchestratorTab).toHaveClass("session-pane-tab__label");
		expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();
	});

	it("shows 'No session' when there is no session", () => {
		render(<CenterPane theme="dark" daemonReady />);
		expect(screen.getByText("No session")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();
	});

	it("uses the inspector tab height for the terminal header", () => {
		render(<CenterPane session={worker} theme="dark" daemonReady />);

		const header = screen.getByRole("button", { name: "do the thing" }).closest(".h-inspector-tabs");
		expect(header).toHaveClass("h-inspector-tabs");
	});

	it("uses the session tab to return from a selected shell", () => {
		const onSelectSessionTerminal = vi.fn();
		render(
			<CenterPane
				session={worker}
				terminalTarget={{ kind: "shell", handleId: "h-1", title: "Shell" }}
				onSelectSessionTerminal={onSelectSessionTerminal}
				theme="dark"
				daemonReady
			/>,
		);

		const sessionTab = screen.getByRole("button", { name: "do the thing" });
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
			expect(tab).toHaveClass("min-w-flex-min");
			expect(tab).not.toHaveClass("min-w-0");
		}
		// jsdom reports no overflow, so the inactive indicator stays mounted without reserving layout space.
		const rightScrollButton = document.querySelector('button[aria-label="Scroll tabs right"]');
		expect(rightScrollButton).toBeDisabled();
		expect(rightScrollButton).toHaveClass("hidden");

		// The display controls float over the terminal body, not the tab bar,
		// so tabs and controls can never overlap.
		const tabBarRow = screen.getByRole("button", { name: "do the thing" }).closest("div")?.parentElement;
		expect(tabBarRow).not.toBeNull();
		expect(tabBarRow?.contains(screen.getByRole("button", { name: /fullscreen/i }))).toBe(false);
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
});
