import type { ReactNode, Ref } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { SessionView } from "./SessionView";
import { useUiStore } from "../stores/ui-store";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";

type FakePanelHandle = {
	collapse: Mock;
	expand: Mock;
	getSize: Mock;
	isCollapsed: Mock;
	resize: Mock;
};

type PanelEntry = {
	handle: FakePanelHandle;
	onResize?: (size: { asPercentage: number; inPixels: number }) => void;
};

const { workspaces, panels } = vi.hoisted(() => {
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
	const orchestrator = {
		...worker,
		id: "sess-orch",
		kind: "orchestrator",
		title: "orchestrate",
	} satisfies WorkspaceSession;
	const workspaces: WorkspaceSummary[] = [
		{ id: "proj-1", name: "my-app", path: "/p", type: "main", sessions: [worker, orchestrator] },
	];
	return { workspaces, panels: new Map<string, PanelEntry>() };
});

// The terminal and inspector body pull in xterm/SSE machinery irrelevant to
// the split under test. (The topbar is shell-owned — see ShellTopbar.)
vi.mock("./CenterPane", () => ({ CenterPane: () => <div>terminal center</div> }));
vi.mock("./BrowserPanel", () => ({
	BrowserPanelView: ({
		poppedOut,
		onTogglePopOut,
	}: {
		poppedOut: boolean;
		onTogglePopOut: (next: boolean) => void;
	}) => (
		<button type="button" onClick={() => onTogglePopOut(!poppedOut)}>
			{poppedOut ? "browser center" : "browser rail"}
		</button>
	),
	useBrowserAnnotationQueue: () => ({
		status: "idle",
		error: "",
		queuedCount: 0,
		beginPicking: vi.fn(),
		cancelPicking: vi.fn(),
		enqueue: vi.fn(),
		failPicking: vi.fn(),
		retryQueued: vi.fn(),
	}),
}));
vi.mock("./SessionFilesView", () => ({
	SessionFilesView: ({
		isMaximized,
		onToggleMaximized,
	}: {
		isMaximized?: boolean;
		onToggleMaximized?: (next: boolean) => void;
	}) => (
		<button type="button" onClick={() => onToggleMaximized?.(!isMaximized)}>
			{isMaximized ? "files center" : "files rail"}
		</button>
	),
}));
const browserDestroy = vi.hoisted(() => vi.fn());
vi.mock("../hooks/useBrowserView", () => ({
	useBrowserView: () => ({
		viewId: "browser:sess-1",
		navState: {
			viewId: "browser:sess-1",
			url: "http://127.0.0.1:4173/",
			title: "Calculator",
			canGoBack: false,
			canGoForward: false,
			isLoading: false,
		},
		slotRef: vi.fn(),
		navigate: vi.fn(),
		goBack: vi.fn(),
		goForward: vi.fn(),
		reload: vi.fn(),
		stop: vi.fn(),
		destroy: browserDestroy,
	}),
}));
vi.mock("./SessionInspector", () => ({
	SessionInspector: ({
		filesView,
		onOpenFiles,
		onToggleBrowserPopOut,
		view,
	}: {
		filesView?: ReactNode;
		onOpenFiles?: () => void;
		onToggleBrowserPopOut?: () => void;
		view?: string;
	}) => (
		<div>
			<button type="button" data-view={view} onClick={onToggleBrowserPopOut}>
				pop browser
			</button>
			<button type="button" onClick={onOpenFiles}>
				open files
			</button>
			{view === "files" ? filesView : null}
		</div>
	),
}));
vi.mock("../lib/shell-context", () => ({
	useShell: () => ({ daemonStatus: { state: "ready" } }),
}));
vi.mock("../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: () => ({ data: workspaces, isLoading: false }),
}));

// jsdom has no layout engine, so the real react-resizable-panels would never
// produce meaningful sizes — record the props SessionView passes and expose a
// fake imperative handle per panel instead.
vi.mock("./ui/resizable", () => ({
	ResizablePanelGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	ResizableHandle: ({ elementRef }: { elementRef?: Ref<HTMLDivElement | null> }) => (
		<div
			data-separator="inactive"
			data-testid="resize-handle"
			ref={(el) => {
				if (elementRef && typeof elementRef === "object") {
					(elementRef as { current: HTMLDivElement | null }).current = el;
				}
			}}
		/>
	),
	ResizablePanel: ({
		children,
		id,
		defaultSize,
		minSize,
		maxSize,
		collapsible,
		panelRef,
		onResize,
		style: _style,
		...rest
	}: {
		children?: ReactNode;
		id: string;
		defaultSize?: number | string;
		minSize?: number | string;
		maxSize?: number | string;
		collapsible?: boolean;
		panelRef?: Ref<FakePanelHandle | null>;
		onResize?: (size: { asPercentage: number; inPixels: number }) => void;
		style?: React.CSSProperties;
	}) => {
		let entry = panels.get(id);
		if (!entry) {
			entry = {
				handle: {
					collapse: vi.fn(),
					expand: vi.fn(),
					getSize: vi.fn(() => ({ asPercentage: 28, inPixels: 280 })),
					isCollapsed: vi.fn(() => false),
					resize: vi.fn(),
				},
			};
			panels.set(id, entry);
		}
		entry.onResize = onResize;
		if (panelRef && typeof panelRef === "object") {
			(panelRef as { current: FakePanelHandle | null }).current = entry.handle;
		}
		return (
			<div data-testid={`panel-${id}`} data-collapsible={collapsible ? "true" : undefined} {...rest}>
				<span data-testid={`panel-${id}-sizes`}>
					{JSON.stringify([defaultSize, minSize, maxSize].filter((s) => s !== undefined))}
				</span>
				{children}
			</div>
		);
	},
}));

function panelSizes(id: string): unknown[] {
	return JSON.parse(screen.getByTestId(`panel-${id}-sizes`).textContent ?? "[]") as unknown[];
}

describe("SessionView", () => {
	beforeEach(() => {
		window.localStorage.clear();
		useUiStore.setState({ isInspectorOpen: true });
		panels.clear();
		browserDestroy.mockReset();
	});

	// Regression: react-resizable-panels v4 treats bare numeric sizes as PIXELS
	// (numbers were percentages in the older API the shadcn examples use).
	// defaultSize={28}/maxSize={45} clamped the inspector rail to a 45px sliver.
	// Every size must be an explicit percentage string.
	it("sizes the terminal/inspector split in percentages, not pixels", () => {
		render(<SessionView sessionId="sess-1" />);

		for (const panelId of ["terminal", "inspector"]) {
			const sizes = panelSizes(panelId);
			expect(sizes.length).toBeGreaterThan(0);
			for (const size of sizes) {
				expect(size, `${panelId} size ${String(size)} must be a percentage string`).toMatch(/^\d+(\.\d+)?%$/);
			}
		}
	});

	it("marks the inspector collapsible and renders the resize handle", () => {
		render(<SessionView sessionId="sess-1" />);

		expect(screen.getByTestId("panel-inspector")).toHaveAttribute("data-collapsible", "true");
		expect(screen.getByTestId("resize-handle")).toBeInTheDocument();
		expect(screen.getByTestId("panel-inspector")).not.toHaveAttribute("inert");
	});

	it("mounts collapsed and inert when the store says closed", () => {
		useUiStore.setState({ isInspectorOpen: false });
		render(<SessionView sessionId="sess-1" />);

		expect(panelSizes("inspector")[0]).toBe("0%");
		const pane = screen.getByTestId("panel-inspector");
		expect(pane).toHaveAttribute("inert");
		expect(pane).toHaveAttribute("aria-hidden", "true");
		expect(panels.get("inspector")!.handle.collapse).toHaveBeenCalled();
	});

	it("toggles the inspector with mod+shift+B through the imperative panel API", () => {
		render(<SessionView sessionId="sess-1" />);
		const handle = panels.get("inspector")!.handle;

		fireEvent.keyDown(window, { key: "B", metaKey: true, shiftKey: true });
		expect(useUiStore.getState().isInspectorOpen).toBe(false);
		expect(handle.collapse).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(window, { key: "B", ctrlKey: true, shiftKey: true });
		expect(useUiStore.getState().isInspectorOpen).toBe(true);
		expect(handle.expand).toHaveBeenCalled();

		// Plain ⌘B belongs to the sidebar — the inspector must not react.
		fireEvent.keyDown(window, { key: "b", metaKey: true });
		expect(useUiStore.getState().isInspectorOpen).toBe(true);
	});

	it("syncs drag resizes back into the store and persists the split", () => {
		render(<SessionView sessionId="sess-1" />);
		const entry = panels.get("inspector")!;
		// rrp marks the separator active for the duration of a pointer drag.
		screen.getByTestId("resize-handle").setAttribute("data-separator", "active");

		// Dragging past minSize collapses the panel → store follows.
		act(() => entry.onResize?.({ asPercentage: 0, inPixels: 0 }));
		expect(useUiStore.getState().isInspectorOpen).toBe(false);

		// Dragging it back open reopens + persists the width.
		act(() => entry.onResize?.({ asPercentage: 31.5, inPixels: 400 }));
		expect(useUiStore.getState().isInspectorOpen).toBe(true);
		expect(window.localStorage.getItem("ao.inspector.split")).toBe("31.5");
	});

	// Regression: rrp v4 reports observed DOM sizes, so the flex-grow
	// transition animating an imperative collapse fires onResize with transient
	// non-zero sizes. Mirroring those into the store re-opened the panel
	// mid-animation — the topbar toggle looked dead and a mount-time 0-size
	// event flipped a fresh profile to collapsed. Only drag events (separator
	// active) may write back.
	it("ignores onResize churn while the separator is not being dragged", () => {
		render(<SessionView sessionId="sess-1" />);
		const entry = panels.get("inspector")!;

		// Mount-time/layout event at 0% must not collapse the store…
		act(() => entry.onResize?.({ asPercentage: 0, inPixels: 0 }));
		expect(useUiStore.getState().isInspectorOpen).toBe(true);

		// …and a mid-collapse transition frame must not re-open or persist.
		act(() => useUiStore.getState().toggleInspector());
		act(() => entry.onResize?.({ asPercentage: 12.4, inPixels: 160 }));
		expect(useUiStore.getState().isInspectorOpen).toBe(false);
		expect(window.localStorage.getItem("ao.inspector.split")).toBeNull();
	});

	it("restores the persisted split width", () => {
		window.localStorage.setItem("ao.inspector.split", "40");
		render(<SessionView sessionId="sess-1" />);
		expect(panelSizes("inspector")[0]).toBe("40%");
	});

	// Regression: rrp only derives a panel's constraints one commit after it
	// registers into a live group. Driving the imperative API in the commit
	// where the inspector mounts (orchestrator → worker navigation; SessionView
	// itself stays mounted) threw "Panel constraints not found for Panel
	// inspector" and unwound the route to the error boundary. The panel must
	// mount already in sync via defaultSize instead.
	it("mounts the inspector in sync when navigating from an orchestrator session, without the imperative API", () => {
		useUiStore.setState({ isInspectorOpen: false });
		const { rerender } = render(<SessionView sessionId="sess-orch" />);
		expect(screen.queryByTestId("panel-inspector")).not.toBeInTheDocument();

		// Toggled open while on the orchestrator (shell topbar button) — the
		// panel that mounts later must pick this up from defaultSize alone.
		act(() => useUiStore.getState().toggleInspector());
		rerender(<SessionView sessionId="sess-1" />);

		expect(panelSizes("inspector")[0]).toMatch(/^[1-9]\d*(\.\d+)?%$/);
		const handle = panels.get("inspector")!.handle;
		expect(handle.expand).not.toHaveBeenCalled();
		expect(handle.collapse).not.toHaveBeenCalled();
		expect(handle.resize).not.toHaveBeenCalled();
	});

	it("renders no inspector panel or handle for orchestrator sessions", () => {
		render(<SessionView sessionId="sess-orch" />);

		expect(screen.queryByTestId("panel-inspector")).not.toBeInTheDocument();
		expect(screen.queryByTestId("resize-handle")).not.toBeInTheDocument();

		// The shortcut is inactive without an inspector.
		fireEvent.keyDown(window, { key: "B", metaKey: true, shiftKey: true });
		expect(useUiStore.getState().isInspectorOpen).toBe(true);
	});

	it("maximizes the browser over the whole app window and returns to the rail", () => {
		render(<SessionView sessionId="sess-1" />);

		expect(screen.getByText("terminal center")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "pop browser" }));

		// The maximized overlay appears; the terminal stays mounted behind it.
		expect(screen.getByRole("button", { name: "browser center" })).toBeInTheDocument();
		expect(screen.getByText("terminal center")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "browser center" }));
		expect(screen.queryByRole("button", { name: "browser center" })).not.toBeInTheDocument();
		expect(screen.getByText("terminal center")).toBeInTheDocument();
		expect(browserDestroy).not.toHaveBeenCalled();
	});

	it("opens the files view in the inspector rail first", () => {
		render(<SessionView sessionId="sess-1" />);

		fireEvent.click(screen.getByRole("button", { name: "open files" }));

		expect(
			within(screen.getByTestId("panel-inspector")).getByRole("button", { name: "files rail" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "files center" })).not.toBeInTheDocument();
		expect(screen.getByText("terminal center")).toBeInTheDocument();
	});

	it("lets the user maximize and minimize the files view explicitly", () => {
		render(<SessionView sessionId="sess-1" />);

		fireEvent.click(screen.getByRole("button", { name: "open files" }));
		fireEvent.click(within(screen.getByTestId("panel-inspector")).getByRole("button", { name: "files rail" }));

		expect(screen.getByRole("button", { name: "files center" })).toBeInTheDocument();
		expect(screen.getByText("terminal center")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "files center" }));
		expect(screen.queryByRole("button", { name: "files center" })).not.toBeInTheDocument();
		expect(
			within(screen.getByTestId("panel-inspector")).getByRole("button", { name: "files rail" }),
		).toBeInTheDocument();
		expect(screen.getByText("terminal center")).toBeInTheDocument();
	});

	it("reveals an `ao preview` URL in the inspector Browser tab, not the center pane", () => {
		const worker = workspaces[0].sessions[0];
		worker.previewUrl = "http://localhost:5173/";
		try {
			useUiStore.setState({ isInspectorOpen: false });
			render(<SessionView sessionId="sess-1" />);

			// Center pane keeps the terminal — the preview must not pop out over it.
			expect(screen.getByText("terminal center")).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "browser center" })).not.toBeInTheDocument();
			// Rail opened and switched to the Browser tab.
			expect(useUiStore.getState().isInspectorOpen).toBe(true);
			expect(screen.getByRole("button", { name: "pop browser" })).toHaveAttribute("data-view", "browser");
		} finally {
			delete worker.previewUrl;
		}
	});
});
