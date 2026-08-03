import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shellTerminalsQueryKey, type ShellTerminal } from "../hooks/useShellTerminals";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import type { AttachableTerminal } from "../hooks/useTerminalSession";
import type { TerminalTarget } from "../types/terminal";
import type { WorkspaceSession } from "../types/workspace";
import { useUiStore } from "../stores/ui-store";
import {
	TerminalCacheProvider,
	TerminalPane,
	providerScrollsByKeyboard,
} from "./TerminalPane";

const {
	attachMock,
	getMock,
	postMock,
	reviewResponses,
	terminalError,
	terminalState,
	replaySettled,
	terminalPreparations,
	terminalOutputHandlers,
	xtermMounts,
	xtermUnmounts,
} = vi.hoisted(
	() => ({
		attachMock: vi.fn(() => vi.fn()),
		getMock: vi.fn(
			async (
				_path: string,
				options: { params?: { path?: { sessionId?: string } } },
			) => ({
				data:
					reviewResponses.get(options.params?.path?.sessionId ?? "") ??
					{ reviewerGeneration: "", reviewerHandleId: "", reviews: [] },
			}),
		),
		postMock: vi.fn(),
		reviewResponses: new Map<string, unknown>(),
		terminalError: { value: undefined as string | undefined },
		terminalState: { value: "idle" },
		replaySettled: { value: true },
		terminalPreparations: { value: 0 },
		terminalOutputHandlers: new Map<string, (text: string) => void>(),
		xtermMounts: { value: 0 },
		xtermUnmounts: { value: 0 },
	}),
);
let terminalLinkHandler: ((uri: string) => void) | undefined;

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: (
			path: string,
			options: { params?: { path?: { sessionId?: string } } },
		) => getMock(path, options),
		POST: (...args: unknown[]) => postMock(...args),
	},
	apiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

vi.mock("./XtermTerminal", () => ({
	XtermTerminal: (props: {
		onLinkOpen?: (uri: string) => void;
		onReady?: (terminal: AttachableTerminal) => void;
	}) => {
		terminalLinkHandler = props.onLinkOpen;
		const instance = useRef(0);
		if (instance.current === 0) {
			xtermMounts.value += 1;
			instance.current = xtermMounts.value;
		}
		useEffect(() => {
			const disposable = { dispose: vi.fn() };
			props.onReady?.({
				cols: 80,
				rows: 24,
				write: vi.fn((_data, done) => done?.()),
				writeln: vi.fn(),
				showLatestOutput: vi.fn(),
				prepareForActivation: vi.fn(async () => {
					terminalPreparations.value += 1;
				}),
				clear: vi.fn(),
				onUserInput: vi.fn(() => disposable),
				onResize: vi.fn(() => disposable),
			});
			return () => {
				xtermUnmounts.value += 1;
			};
		}, []);
		return <div data-testid="xterm" data-xterm-instance={instance.current} tabIndex={-1} />;
	},
}));

vi.mock("../hooks/useTerminalSession", () => ({
	useTerminalSession: (
		session: WorkspaceSession | undefined,
		options: { onOutput?: (text: string) => void },
	) => {
		if (session?.id && options.onOutput) terminalOutputHandlers.set(session.id, options.onOutput);
		return {
			attach: attachMock,
			state: terminalState.value,
			error: terminalError.value,
			replaySettled: replaySettled.value,
		};
	},
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

beforeEach(() => {
	getMock.mockClear();
	postMock.mockReset();
	postMock.mockResolvedValue({ data: {} });
	reviewResponses.clear();
	terminalError.value = undefined;
	terminalState.value = "idle";
	replaySettled.value = true;
	terminalPreparations.value = 0;
	terminalLinkHandler = undefined;
	terminalOutputHandlers.clear();
	attachMock.mockClear();
	xtermMounts.value = 0;
	xtermUnmounts.value = 0;
	useUiStore.setState({ inspectorSessions: {} });
});

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
		queryClient,
		restore: () => {
			window.ao = previousAO;
		},
	};
}

function workspaceWithSessions(sessions: WorkspaceSession[]) {
	return [
		{
			id: "proj-1",
			name: "my-app",
			kind: "single_repo" as const,
			path: "/repo/my-app",
			type: "main" as const,
			sessions,
		},
	];
}

function renderCachedPane({
	session,
	sessions,
	shellTerminals = [],
	terminalTarget,
}: {
	session?: WorkspaceSession;
	sessions: WorkspaceSession[];
	shellTerminals?: ShellTerminal[];
	terminalTarget?: TerminalTarget;
}) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClient.setQueryData(workspaceQueryKey, workspaceWithSessions(sessions));
	queryClient.setQueryData(shellTerminalsQueryKey, shellTerminals);
	if (session && terminalTarget?.kind === "reviewer") {
		reviewResponses.set(
			session.id,
			reviewerResponse(terminalTarget.handleId, terminalTarget.generation),
		);
		queryClient.setQueryData(
			["session-reviews", session.id],
			reviewerResponse(terminalTarget.handleId, terminalTarget.generation),
		);
	}
	const previousAO = window.ao;
	window.ao = {} as typeof window.ao;

	const tree = (nextSession?: WorkspaceSession, nextTarget?: TerminalTarget, showPane = true) => (
		<QueryClientProvider client={queryClient}>
			<TerminalCacheProvider daemonReady theme="dark">
				{showPane ? (
					<TerminalPane
						daemonReady
						fontSize={12}
						session={nextSession}
						terminalTarget={nextTarget}
						theme="dark"
					/>
				) : (
					<div data-testid="away" />
				)}
			</TerminalCacheProvider>
		</QueryClientProvider>
	);
	const result = render(tree(session, terminalTarget));
	return {
		...result,
		queryClient,
		show: (nextSession?: WorkspaceSession, nextTarget?: TerminalTarget) =>
			result.rerender(tree(nextSession, nextTarget)),
		restore: () => {
			window.ao = previousAO;
		},
	};
}

function reviewerResponse(handleId: string, generation: string) {
	return {
		reviewerGeneration: generation,
		reviewerHandleId: handleId,
		reviews: [
			{
				latestRun: {
					batchId: generation,
					body: "",
					createdAt: "2026-07-31T00:00:00Z",
					githubReviewId: "",
					harness: "codex",
					id: `${generation}-run`,
					prUrl: "https://github.com/example/repo/pull/1",
					reviewId: `${generation}-review`,
					sessionId: "sess-a",
					status: "delivered",
					targetSha: generation,
					verdict: "approved",
				},
				prNumber: 1,
				prUrl: "https://github.com/example/repo/pull/1",
				status: "up_to_date",
				targetSha: generation,
				title: "Review",
			},
		],
	};
}

function activeXterm(): HTMLElement {
	return within(screen.getByTestId("session-terminal-slot")).getByTestId("xterm");
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
					"Preparing the worker terminal. This can take a moment while AO creates the workspace and starts the agent.",
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
					"Preparing the orchestrator terminal. This can take a moment while AO creates the workspace and starts the agent.",
				),
			).toBeInTheDocument();
			expect(screen.queryByText(/worker terminal/i)).not.toBeInTheDocument();
		} finally {
			view.restore();
		}
	});
});

// Initial-replay cover (issue #3160): xterm stays mounted and ingesting behind
// a blank cover so the pane is revealed already drawn at the tail.
describe("TerminalPane replay cover", () => {
	beforeEach(() => {
		// The cover is scoped to an attachment that is actually expecting a
		// replay, so these cases have to be in a connecting/attached state.
		terminalState.value = "connecting";
	});

	it("covers the terminal while the attachment is still buffering the replay", () => {
		replaySettled.value = false;
		const view = renderPane({ ...worker, terminalHandleId: "term-1" });
		try {
			const cover = screen.getByTestId("terminal-replay-cover");
			expect(cover).toBeInTheDocument();
			expect(cover).toHaveClass("bg-terminal-opaque", "opacity-100", "transition-none");
			expect(cover).not.toHaveClass("bg-terminal");
			// xterm keeps rendering underneath — covered, never unmounted, so the
			// grid it measures stays correct.
			expect(screen.getByTestId("xterm")).toBeInTheDocument();
		} finally {
			view.restore();
		}
	});

	it("uncovers once the replay has settled", () => {
		replaySettled.value = true;
		const view = renderPane({ ...worker, terminalHandleId: "term-1" });
		try {
			expect(screen.queryByTestId("terminal-replay-cover")).not.toBeInTheDocument();
		} finally {
			view.restore();
		}
	});

	it("shows no loader text on a fast open", () => {
		replaySettled.value = false;
		const view = renderPane({ ...worker, terminalHandleId: "term-1" });
		try {
			// The label is delayed, so a session switch that resolves quickly never
			// flashes a spinner — the whole point of a blank cover.
			expect(screen.queryByText("Loading latest output…")).not.toBeInTheDocument();
		} finally {
			view.restore();
		}
	});

	it("stays out of the way while the pane is visibly reattaching", () => {
		replaySettled.value = false;
		terminalState.value = "reattaching";
		const view = renderPane({ ...worker, terminalHandleId: "term-1" });
		try {
			// An open timeout lifts the cover and the backoff reconnect would pull
			// it straight back down; the banner explains this window better.
			expect(screen.queryByTestId("terminal-replay-cover")).not.toBeInTheDocument();
			expect(screen.getByText("Terminal disconnected — reattaching…")).toBeInTheDocument();
		} finally {
			view.restore();
		}
	});

	it("keeps the startup card, not the blank cover, when there is no terminal handle yet", () => {
		replaySettled.value = false;
		const view = renderPane(worker);
		try {
			expect(screen.getByText("Starting session")).toBeInTheDocument();
			expect(screen.queryByTestId("terminal-replay-cover")).not.toBeInTheDocument();
		} finally {
			view.restore();
		}
	});
});

describe("TerminalCacheProvider", () => {
	const sessionA = { ...worker, id: "sess-a", title: "session A", terminalHandleId: "handle-a" };
	const sessionB = { ...worker, id: "sess-b", title: "session B", terminalHandleId: "handle-b" };

	it("removes externally-created terminal hosts when the shell provider unmounts", async () => {
		const view = renderCachedPane({ session: sessionA, sessions: [sessionA, sessionB] });
		try {
			await waitFor(() => activeXterm());
			view.show(sessionB);
			await waitFor(() => expect(screen.getAllByTestId("xterm")).toHaveLength(2));
			view.unmount();
			expect(document.querySelectorAll("[data-terminal-cache-key]")).toHaveLength(0);
			expect(xtermUnmounts.value).toBe(2);
		} finally {
			view.restore();
		}
	});

	it("uses an opaque backing so another retained frame cannot show through", async () => {
		const view = renderCachedPane({ session: sessionA, sessions: [sessionA] });
		try {
			const terminal = await waitFor(() => activeXterm());
			expect(terminal.closest("[data-terminal-cache-key]")).toHaveClass("bg-terminal-opaque");
		} finally {
			view.restore();
		}
	});

	it("prepares a retained terminal at the latest output before revealing it", async () => {
		const view = renderCachedPane({ session: sessionA, sessions: [sessionA, sessionB] });
		try {
			const terminalA = await waitFor(() => activeXterm());
			view.show(sessionB);
			await waitFor(() => expect(activeXterm()).not.toBe(terminalA));
			expect(terminalPreparations.value).toBe(0);

			view.show(sessionA);
			await waitFor(() => expect(activeXterm()).toBe(terminalA));
			expect(terminalPreparations.value).toBe(1);
			await waitFor(() =>
				expect(
					terminalA.closest("[data-terminal-cache-key]"),
				).toHaveAttribute("data-terminal-activation-phase", "visible"),
			);
		} finally {
			view.restore();
		}
	});

	it("disposes an old handle generation instead of reusing its terminal state", async () => {
		const replacement = { ...sessionA, terminalHandleId: "handle-a-generation-2" };
		const view = renderCachedPane({ session: sessionA, sessions: [sessionA] });
		try {
			const oldGeneration = await waitFor(() => activeXterm());
			act(() => {
				view.queryClient.setQueryData(workspaceQueryKey, workspaceWithSessions([replacement]));
			});
			view.show(replacement);

			await waitFor(() => expect(oldGeneration.isConnected).toBe(false));
			expect(activeXterm()).not.toBe(oldGeneration);
			expect(xtermMounts.value).toBe(2);
			await waitFor(() => expect(xtermUnmounts.value).toBe(1));
			expect(attachMock).toHaveBeenCalledTimes(2);
		} finally {
			view.restore();
		}
	});

	it("disposes parked entries when their session is removed", async () => {
		const view = renderCachedPane({ session: sessionA, sessions: [sessionA, sessionB] });
		try {
			const terminalA = await waitFor(() => activeXterm());
			view.show(sessionB);
			await waitFor(() => expect(activeXterm()).not.toBe(terminalA));
			act(() => {
				view.queryClient.setQueryData(workspaceQueryKey, workspaceWithSessions([sessionB]));
			});

			await waitFor(() => expect(terminalA.isConnected).toBe(false));
			await waitFor(() => expect(xtermUnmounts.value).toBe(1));
		} finally {
			view.restore();
		}
	});

	it("disposes a retained generation when its authoritative handle disappears", async () => {
		const view = renderCachedPane({ session: sessionA, sessions: [sessionA] });
		try {
			const terminalA = await waitFor(() => activeXterm());
			const withoutHandle = { ...sessionA, terminalHandleId: undefined };
			act(() => {
				view.queryClient.setQueryData(workspaceQueryKey, workspaceWithSessions([withoutHandle]));
			});

			await waitFor(() => expect(terminalA.isConnected).toBe(false));
			await waitFor(() => expect(xtermUnmounts.value).toBe(1));
		} finally {
			view.restore();
		}
	});

	it("disposes a parked shell when the shell lifecycle removes its handle", async () => {
		const shell: ShellTerminal = {
			handleId: "shell-handle",
			sessionId: sessionA.id,
			workingDir: "/repo/my-app",
			title: "scratch",
			createdAt: "2026-07-30T00:00:00Z",
		};
		const shellTarget: TerminalTarget = {
			generation: shell.createdAt,
			kind: "shell",
			handleId: shell.handleId,
			sessionId: sessionA.id,
			title: shell.title,
		};
		const view = renderCachedPane({
			session: sessionA,
			sessions: [sessionA],
			shellTerminals: [shell],
			terminalTarget: shellTarget,
		});
		try {
			const shellXterm = await waitFor(() => activeXterm());
			view.show(sessionA, { kind: "worker" });
			await waitFor(() => expect(activeXterm()).not.toBe(shellXterm));
			act(() => {
				view.queryClient.setQueryData(shellTerminalsQueryKey, []);
			});

			await waitFor(() => expect(shellXterm.isConnected).toBe(false));
			await waitFor(() => expect(xtermUnmounts.value).toBe(1));
		} finally {
			view.restore();
		}
	});

	it("rejects a reviewer target retained from the previous route before assigning cache ownership", async () => {
		const staleTarget = {
			generation: "review-batch-a",
			handleId: "review-handle-a",
			harness: "codex",
			kind: "reviewer",
			sessionId: sessionA.id,
		} as unknown as TerminalTarget;
		const view = renderCachedPane({
			session: sessionB,
			sessions: [sessionA, sessionB],
			terminalTarget: staleTarget,
		});
		try {
			await waitFor(() => activeXterm());
			const keys = [...document.querySelectorAll<HTMLElement>("[data-terminal-cache-key]")].map(
				(element) => element.dataset.terminalCacheKey,
			);
			expect(keys).toContain(`session:${sessionB.id}:worker|handle:${sessionB.terminalHandleId}`);
			expect(keys.some((key) => key?.includes("review-handle-a"))).toBe(false);
		} finally {
			view.restore();
		}
	});

	it("replaces an exited reviewer renderer when its run generation changes", async () => {
		const reviewer = (generation: string) =>
			({
				generation,
				handleId: "stable-reviewer-handle",
				harness: "codex",
				kind: "reviewer",
				sessionId: sessionA.id,
			}) as unknown as TerminalTarget;
		const view = renderCachedPane({
			session: sessionA,
			sessions: [sessionA],
			terminalTarget: reviewer("batch-1"),
		});
		try {
			const first = await waitFor(() => activeXterm());
			reviewResponses.set(sessionA.id, reviewerResponse("stable-reviewer-handle", "batch-2"));
			act(() => {
				view.queryClient.setQueryData(
					["session-reviews", sessionA.id],
					reviewerResponse("stable-reviewer-handle", "batch-2"),
				);
			});
			view.show(sessionA, reviewer("batch-2"));
			await waitFor(() => expect(activeXterm()).not.toBe(first));
			expect(first.isConnected).toBe(false);
			expect(xtermMounts.value).toBe(2);
		} finally {
			view.restore();
		}
	});

	it("disposes a parked reviewer when authoritative review state replaces its generation", async () => {
		const reviewer = {
			generation: "batch-1",
			handleId: "stable-reviewer-handle",
			harness: "codex",
			kind: "reviewer",
			sessionId: sessionA.id,
		} as unknown as TerminalTarget;
		const view = renderCachedPane({
			session: sessionA,
			sessions: [sessionA],
			terminalTarget: reviewer,
		});
		try {
			const retainedReviewer = await waitFor(() => activeXterm());
			view.show(sessionA, { kind: "worker" });
			await waitFor(() => expect(activeXterm()).not.toBe(retainedReviewer));

			reviewResponses.set(
				sessionA.id,
				reviewerResponse("stable-reviewer-handle", "batch-2"),
			);
			await act(async () => {
				await view.queryClient.refetchQueries({
					queryKey: ["session-reviews", sessionA.id],
				});
			});

			await waitFor(() => expect(retainedReviewer.isConnected).toBe(false));
			expect(
				document.querySelector(
					`[data-terminal-cache-key*="generation:batch-1"]`,
				),
			).not.toBeInTheDocument();
		} finally {
			view.restore();
		}
	});

	it("keeps an active superseded reviewer visible until the user leaves it", async () => {
		const reviewer = {
			generation: "batch-1",
			handleId: "stable-reviewer-handle",
			harness: "codex",
			kind: "reviewer",
			sessionId: sessionA.id,
		} as unknown as TerminalTarget;
		const view = renderCachedPane({
			session: sessionA,
			sessions: [sessionA],
			terminalTarget: reviewer,
		});
		try {
			const activeReviewer = await waitFor(() => activeXterm());
			await waitFor(() => expect(getMock).toHaveBeenCalled());
			const replacement = reviewerResponse("stable-reviewer-handle", "batch-2");
			reviewResponses.set(sessionA.id, replacement);
			await act(async () => {
				await view.queryClient.refetchQueries({
					queryKey: ["session-reviews", sessionA.id],
				});
			});
			await waitFor(() =>
				expect(
					view.queryClient.getQueryData(["session-reviews", sessionA.id]),
				).toEqual(replacement),
			);
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});

			expect(activeReviewer.isConnected).toBe(true);
			expect(activeXterm()).toBe(activeReviewer);

			view.show(sessionA, { kind: "worker" });
			await waitFor(() => expect(activeReviewer.isConnected).toBe(false));
		} finally {
			view.restore();
		}
	});

	it("keeps an attachment error inspectable until the pane leaves", async () => {
		terminalState.value = "error";
		terminalError.value = "attach failed";
		const view = renderCachedPane({ session: sessionA, sessions: [sessionA, sessionB] });
		try {
			await waitFor(() => expect(screen.getByText("Terminal error: attach failed")).toBeInTheDocument());
			expect(activeXterm()).toBeInTheDocument();
			expect(xtermUnmounts.value).toBe(0);
			expect(xtermMounts.value).toBe(1);
			terminalState.value = "attached";
			terminalError.value = undefined;
			view.show(sessionB);

			await waitFor(() => activeXterm());
			expect(xtermMounts.value).toBe(2);
		} finally {
			view.restore();
		}
	});
});

describe("terminal restore", () => {
	it.each([
		["exited", undefined],
		["error", "terminal handle missing"],
		["idle", undefined],
	])("posts restore from the terminal-ended strip when mux state is %s", async (state, error) => {
		terminalState.value = state;
		terminalError.value = error;
		const view = renderPane({ ...worker, status: "terminated", terminalHandleId: "term-1" });
		const invalidate = vi.spyOn(view.queryClient, "invalidateQueries").mockResolvedValue(undefined);
		try {
			await userEvent.click(screen.getByRole("button", { name: "Restore session" }));

			await waitFor(() =>
				expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/restore", {
					params: { path: { sessionId: "sess-1" } },
				}),
			);
			expect(invalidate).toHaveBeenCalledWith({ queryKey: ["workspaces"] });
		} finally {
			view.restore();
		}
	});

	it("offers restore when a merged session is terminated", () => {
		const view = renderPane({
			...worker,
			status: "merged",
			isTerminated: true,
			terminalHandleId: "term-1",
		});
		try {
			expect(screen.getByRole("button", { name: "Restore session" })).toBeInTheDocument();
		} finally {
			view.restore();
		}
	});

	it("preserves Restore controls after a cached attachment reports a fatal pane error", async () => {
		terminalState.value = "error";
		terminalError.value = "terminal handle missing";
		const terminated = {
			...worker,
			status: "terminated",
			terminalHandleId: "term-1",
		} satisfies WorkspaceSession;
		const view = renderCachedPane({ session: terminated, sessions: [terminated] });
		try {
			expect(await screen.findByRole("button", { name: "Restore session" })).toBeInTheDocument();
			expect(screen.getByTestId("xterm")).toBeInTheDocument();
			expect(screen.getByText("Terminal error: terminal handle missing")).toBeInTheDocument();
		} finally {
			view.restore();
		}
	});
});

describe("terminal output notifications", () => {
	it("badges a parked session even when its persisted inspector view is Browser", async () => {
		const sessionA = { ...worker, id: "sess-a", terminalHandleId: "handle-a" };
		const sessionB = { ...worker, id: "sess-b", terminalHandleId: "handle-b" };
		useUiStore.getState().setInspectorOpen(sessionA.id, true);
		useUiStore.getState().setInspectorView(sessionA.id, "browser");
		const view = renderCachedPane({ session: sessionA, sessions: [sessionA, sessionB] });
		try {
			await waitFor(() => expect(terminalOutputHandlers.get(sessionA.id)).toBeTypeOf("function"));
			view.show(sessionB);
			await waitFor(() =>
				expect(document.querySelector(`[data-terminal-cache-key^="session:${sessionA.id}:worker|"]`)).toHaveAttribute(
					"aria-hidden",
					"true",
				),
			);
			act(() => terminalOutputHandlers.get(sessionA.id)?.("https://example.com/background\n"));
			expect(useUiStore.getState().inspectorSessions[sessionA.id]?.browserUnseen).toBe(true);
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

describe("terminal link preview", () => {
	it.each(["http://localhost:3000/simple", "https://app.localhost:5173", "http://127.0.0.1:8080", "http://[::1]:4173"])(
		"mirrors worker loopback link %s into the session Browser preview",
		async (url) => {
			const view = renderPane(worker);
			try {
				expect(terminalLinkHandler).toBeTypeOf("function");
				act(() => terminalLinkHandler?.(url));

				await waitFor(() =>
					expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/preview", {
						params: { path: { sessionId: "sess-1" } },
						body: { url },
					}),
				);
			} finally {
				view.restore();
			}
		},
	);

	it("mirrors an external (non-loopback) terminal link into the Browser preview", async () => {
		const view = renderPane(worker);
		try {
			act(() => terminalLinkHandler?.("https://example.com/pull/42"));
			await waitFor(() =>
				expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/preview", {
					params: { path: { sessionId: "sess-1" } },
					body: { url: "https://example.com/pull/42" },
				}),
			);
		} finally {
			view.restore();
		}
	});

	it("does not mirror a non-web (mailto:) link", () => {
		const view = renderPane(worker);
		try {
			act(() => terminalLinkHandler?.("mailto:dev@example.com"));
			expect(postMock).not.toHaveBeenCalled();
		} finally {
			view.restore();
		}
	});

	it("does not POST without a selected session", () => {
		const view = renderPane();
		try {
			act(() => terminalLinkHandler?.("http://localhost:3000"));
			expect(postMock).not.toHaveBeenCalled();
		} finally {
			view.restore();
		}
	});

	it("does not mirror orchestrator links because orchestrators have no Browser inspector", () => {
		const view = renderPane(orchestrator);
		try {
			act(() => terminalLinkHandler?.("http://localhost:3000"));
			expect(postMock).not.toHaveBeenCalled();
		} finally {
			view.restore();
		}
	});

	it("does not mirror links for terminated workers because their Browser inspector is cleared", () => {
		const view = renderPane({ ...worker, status: "terminated" });
		try {
			act(() => terminalLinkHandler?.("http://localhost:3000"));
			expect(postMock).not.toHaveBeenCalled();
		} finally {
			view.restore();
		}
	});

	it("does not mirror links for merged workers whose session is terminated", () => {
		const view = renderPane({ ...worker, status: "merged", isTerminated: true });
		try {
			act(() => terminalLinkHandler?.("http://localhost:3000"));
			expect(postMock).not.toHaveBeenCalled();
		} finally {
			view.restore();
		}
	});

	it("does not invalidate workspace data when the preview endpoint returns an error", async () => {
		postMock.mockResolvedValueOnce({ error: { code: "INVALID_PREVIEW_URL" } });
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const view = renderPane(worker);
		const invalidate = vi.spyOn(view.queryClient, "invalidateQueries");
		try {
			act(() => terminalLinkHandler?.("http://localhost:3000"));
			await waitFor(() => expect(warning).toHaveBeenCalled());
			expect(invalidate).not.toHaveBeenCalled();
		} finally {
			warning.mockRestore();
			view.restore();
		}
	});

	it("handles a rejected preview request without an unhandled rejection", async () => {
		const error = new Error("daemon unavailable");
		postMock.mockRejectedValueOnce(error);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const view = renderPane(worker);
		const invalidate = vi.spyOn(view.queryClient, "invalidateQueries");
		try {
			act(() => terminalLinkHandler?.("http://localhost:3000"));
			await waitFor(() =>
				expect(warning).toHaveBeenCalledWith("Unable to open terminal link in Browser preview", error),
			);
			expect(invalidate).not.toHaveBeenCalled();
		} finally {
			warning.mockRestore();
			view.restore();
		}
	});
});
