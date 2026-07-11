import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "../types/workspace";
import { TerminalPane } from "./TerminalPane";

const terminalState = vi.hoisted(() => ({
	attach: vi.fn(() => () => undefined),
	fakeTerminal: {
		cols: 80,
		rows: 24,
		write: vi.fn(),
		writeln: vi.fn(),
		clear: vi.fn(),
		onUserInput: vi.fn(() => ({ dispose: vi.fn() })),
		onResize: vi.fn(() => ({ dispose: vi.fn() })),
	},
}));

const muxState = vi.hoisted(() => ({
	open: vi.fn(),
	close: vi.fn(),
	dispose: vi.fn(),
	dataListener: undefined as undefined | ((bytes: Uint8Array) => void),
	openedListener: undefined as undefined | (() => void),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { POST: vi.fn() },
	apiErrorMessage: (_error: unknown, fallback: string) => fallback,
	getApiBaseUrl: () => "http://127.0.0.1:3001",
}));

vi.mock("../hooks/useTerminalSession", () => ({
	useTerminalSession: () => ({ attach: terminalState.attach, state: "attached", error: undefined }),
}));

vi.mock("../lib/terminal-mux", () => ({
	muxUrlFromApiBase: (baseUrl: string) => `${baseUrl.replace(/^http/, "ws")}/mux`,
	createTerminalMux: () => ({
		open: muxState.open,
		close: muxState.close,
		dispose: muxState.dispose,
		onData: (_id: string, listener: (bytes: Uint8Array) => void) => {
			muxState.dataListener = listener;
			return vi.fn();
		},
		onOpened: (_id: string, listener: () => void) => {
			muxState.openedListener = listener;
			return vi.fn();
		},
		onExit: () => vi.fn(),
		onError: () => vi.fn(),
		onConnectionChange: () => vi.fn(),
	}),
}));

vi.mock("./XtermTerminal", async () => {
	const React = await vi.importActual<typeof import("react")>("react");
	return {
		XtermTerminal: ({ onReady }: { onReady?: (terminal: typeof terminalState.fakeTerminal) => void }) => {
			React.useEffect(() => {
				onReady?.(terminalState.fakeTerminal);
			}, [onReady]);
			return React.createElement("div", null, "terminal");
		},
	};
});

const baseSession = {
	id: "sess-a",
	terminalHandleId: "sess-a/terminal_0",
	workspaceId: "proj-1",
	workspaceName: "my-app",
	title: "Session A",
	provider: "claude-code",
	kind: "worker",
	branch: "ao/sess-a",
	status: "working",
	updatedAt: "2026-06-10T00:00:00Z",
	prs: [],
} satisfies WorkspaceSession;

function renderPane(session: WorkspaceSession) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<TerminalPane session={session} theme="dark" daemonReady fontSize={13} scrollback={5000} />
		</QueryClientProvider>,
	);
}

describe("TerminalPane message composer", () => {
	it("renders the live xterm terminal in browser mode without the Electron bridge", async () => {
		// Browser mode must use the real cursor-addressed xterm surface, not an
		// ANSI-stripped <pre> transcript: stripping the escapes from a full-screen
		// TUI destroys spatial layout (spinner soup, lost word spacing — GH #60).
		const bridge = window.ao;
		terminalState.attach.mockClear();
		delete window.ao;
		try {
			renderPane({ ...baseSession, kind: "orchestrator", title: "my Orc" });

			// The mocked XtermTerminal renders the marker "terminal"; the retired
			// transcript never did. `attach` (the useTerminalSession hook is mocked)
			// firing confirms the live AttachedTerminal → PTY-attach path is wired up
			// in browser mode, not the passive transcript reader. This asserts the
			// component routing, not the mux transport itself (covered elsewhere).
			expect(await screen.findByText("terminal")).toBeInTheDocument();
			await waitFor(() => expect(terminalState.attach).toHaveBeenCalled());
		} finally {
			window.ao = bridge;
		}
	});

	it("clears draft text when navigating between sessions", async () => {
		const user = userEvent.setup();
		const { rerender } = renderPane(baseSession);

		await user.type(screen.getByRole("textbox", { name: "Message Session A" }), "status?");

		const nextSession = { ...baseSession, id: "sess-b", terminalHandleId: "sess-b/terminal_0", title: "Session B" };
		rerender(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TerminalPane session={nextSession} theme="dark" daemonReady fontSize={13} scrollback={5000} />
			</QueryClientProvider>,
		);

		expect(screen.getByRole("textbox", { name: "Message Session B" })).toHaveValue("");
	});

	it("does not show a send composer for archived merged sessions", () => {
		renderPane({ ...baseSession, status: "merged" });

		expect(screen.queryByRole("textbox", { name: /Message/ })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
	});
});
