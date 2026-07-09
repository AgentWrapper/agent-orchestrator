import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "../types/workspace";
import { TerminalPane, providerScrollsByKeyboard } from "./TerminalPane";

vi.mock("./XtermTerminal", () => ({
	XtermTerminal: () => <div data-testid="xterm" />,
}));

vi.mock("../hooks/useTerminalSession", () => ({
	useTerminalSession: () => ({
		attach: vi.fn(),
		state: "idle",
		error: undefined,
	}),
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
	prs: [],
} satisfies WorkspaceSession;

const orchestrator = {
	...worker,
	id: "sess-orch",
	title: "orchestrate",
	kind: "orchestrator",
} satisfies WorkspaceSession;

function renderPane(session?: WorkspaceSession) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const previousAO = window.ao;
	window.ao = {} as typeof window.ao;
	const result = render(
		<QueryClientProvider client={queryClient}>
			<TerminalPane daemonReady fontSize={12} session={session} theme="dark" />
		</QueryClientProvider>,
	);
	return {
		...result,
		restore: () => {
			window.ao = previousAO;
		},
	};
}

describe("TerminalPane empty states", () => {
	it("shows a no-selection message when no session is selected", () => {
		const view = renderPane();
		try {
			expect(screen.getByText("Agent Orchestrator")).toBeInTheDocument();
			expect(screen.getByText("No session selected. Pick a worker to attach its terminal.")).toBeInTheDocument();
		} finally {
			view.restore();
		}
	});

	it("shows a startup message when a selected session has no terminal handle yet", () => {
		const view = renderPane(worker);
		try {
			expect(screen.getByText("Starting session")).toBeInTheDocument();
			expect(
				screen.getByText(
					"Preparing the worker terminal. This can take a moment while AO creates the worktree and starts the agent.",
				),
			).toBeInTheDocument();
			expect(screen.queryByText("No session selected. Pick a worker to attach its terminal.")).not.toBeInTheDocument();
		} finally {
			view.restore();
		}
	});

	it("shows orchestrator-specific startup copy for a pending orchestrator terminal", () => {
		const view = renderPane(orchestrator);
		try {
			expect(screen.getByText("Starting session")).toBeInTheDocument();
			expect(
				screen.getByText(
					"Preparing the orchestrator terminal. This can take a moment while AO creates the worktree and starts the agent.",
				),
			).toBeInTheDocument();
			expect(screen.queryByText(/worker terminal/i)).not.toBeInTheDocument();
		} finally {
			view.restore();
		}
	});
});

describe("providerScrollsByKeyboard", () => {
	// opencode and its fork kilocode share a TUI that scrolls its own transcript
	// by keyboard and ignores SGR wheel reports, so both must opt into the
	// PageUp/PageDown wheel routing (see XtermTerminal's paneScrollsByKeyboard).
	it("is true for keyboard-scroll TUIs (opencode and its kilocode fork)", () => {
		expect(providerScrollsByKeyboard("opencode")).toBe(true);
		expect(providerScrollsByKeyboard("kilocode")).toBe(true);
	});

	it("is false for mouse-report/native-scroll providers", () => {
		expect(providerScrollsByKeyboard("codex")).toBe(false);
		expect(providerScrollsByKeyboard("claude-code")).toBe(false);
	});

	it("is false when the provider is unknown", () => {
		expect(providerScrollsByKeyboard(undefined)).toBe(false);
	});
});
