import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, initializeRendererI18n } from "../i18n";
import type { TerminalTarget } from "../types/terminal";
import type { WorkspaceSession } from "../types/workspace";
import { TerminalPane, providerScrollsByKeyboard } from "./TerminalPane";

const postMock = vi.fn();
let terminalLinkHandler: ((uri: string) => void) | undefined;
let terminalInitErrorHandler: ((error: unknown) => void) | undefined;
const terminalSession = vi.hoisted(() => ({
	state: "idle" as "idle" | "connecting" | "attached" | "reattaching" | "exited" | "error",
	error: undefined as string | undefined,
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { POST: (...args: unknown[]) => postMock(...args) },
	apiErrorMessage: (error: unknown, fallback: string) => {
		const code = (error as { code?: string } | null)?.code;
		return code === "AGENT_BINARY_NOT_FOUND" ? i18n.t("errors.codes.AGENT_BINARY_NOT_FOUND") : fallback;
	},
	apiErrorSnapshot: (error: unknown) => {
		const code = (error as { code?: string } | null)?.code;
		return code ? { code } : {};
	},
	safeExternalErrorMessage: (error: unknown) => (error instanceof Error ? error.message : undefined),
}));

vi.mock("./XtermTerminal", () => ({
	XtermTerminal: (props: {
		ariaLabel: string;
		onError?: (error: unknown) => void;
		onLinkOpen?: (uri: string) => void;
	}) => {
		terminalLinkHandler = props.onLinkOpen;
		terminalInitErrorHandler = props.onError;
		return <div aria-label={props.ariaLabel} data-testid="xterm" role="application" />;
	},
}));

vi.mock("../hooks/useTerminalSession", () => ({
	useTerminalSession: () => ({
		attach: vi.fn(),
		state: terminalSession.state,
		error: terminalSession.error,
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

beforeEach(() => {
	postMock.mockReset();
	postMock.mockResolvedValue({ data: {} });
	terminalLinkHandler = undefined;
	terminalInitErrorHandler = undefined;
	terminalSession.state = "idle";
	terminalSession.error = undefined;
});

function renderPane(session?: WorkspaceSession, terminalTarget?: TerminalTarget) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const previousAO = window.ao;
	window.ao = {} as typeof window.ao;
	const result = render(
		<QueryClientProvider client={queryClient}>
			<TerminalPane daemonReady fontSize={12} session={session} terminalTarget={terminalTarget} theme="dark" />
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

	it("localizes the empty state and terminal accessible name without changing the product name", async () => {
		await initializeRendererI18n("zh-CN");
		const view = renderPane();
		try {
			expect(screen.getByRole("application", { name: "会话终端" })).toBeInTheDocument();
			expect(screen.getByText("Agent Orchestrator")).toBeInTheDocument();
			expect(screen.getByText("尚未选择会话。请选择一个工作智能体以连接其终端。")).toBeInTheDocument();
		} finally {
			view.restore();
		}
	});
});

describe("TerminalPane localized terminal state", () => {
	it("localizes a terminal error while preserving its raw mux detail", async () => {
		await initializeRendererI18n("zh-CN");
		terminalSession.state = "error";
		terminalSession.error = "raw mux detail: no such pane";
		const view = renderPane({ ...worker, terminalHandleId: "handle-1" });
		try {
			expect(screen.getByText("终端错误：raw mux detail: no such pane")).toBeInTheDocument();
		} finally {
			view.restore();
		}
	});

	it("localizes the terminated-session restore control", async () => {
		await initializeRendererI18n("zh-CN");
		terminalSession.state = "exited";
		const view = renderPane({ ...worker, status: "terminated", terminalHandleId: "handle-1" });
		try {
			expect(screen.getByText("终端已结束")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "恢复会话" })).toBeInTheDocument();
			expect(screen.getByText(/恢复会话以连接实时终端/)).toBeInTheDocument();
		} finally {
			view.restore();
		}
	});

	it("relocalizes a restore API error after it occurs without remounting", async () => {
		terminalSession.state = "exited";
		postMock.mockResolvedValueOnce({
			error: {
				error: "Bad Request",
				code: "AGENT_BINARY_NOT_FOUND",
				message: "agent binary not found on PATH",
			},
		});
		const view = renderPane({ ...worker, status: "terminated", terminalHandleId: "handle-1" });
		try {
			await userEvent.click(screen.getByRole("button", { name: "Restore session" }));
			expect(await screen.findByText("The selected agent is not installed")).toBeInTheDocument();

			await act(async () => initializeRendererI18n("zh-CN"));
			expect(screen.getByText("未安装所选智能体")).toBeInTheDocument();
			expect(screen.queryByText("The selected agent is not installed")).not.toBeInTheDocument();
		} finally {
			view.restore();
		}
	});

	it("localizes reviewer-ended guidance without offering session restore", async () => {
		await initializeRendererI18n("zh-CN");
		terminalSession.state = "exited";
		const view = renderPane(worker, { kind: "reviewer", handleId: "review-handle", harness: "codex" });
		try {
			expect(screen.getByText(/此审查终端已结束/)).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "恢复会话" })).not.toBeInTheDocument();
		} finally {
			view.restore();
		}
	});

	it("localizes the xterm initialization failure", async () => {
		await initializeRendererI18n("zh-CN");
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const view = renderPane({ ...worker, terminalHandleId: "handle-1" });
		try {
			act(() => terminalInitErrorHandler?.(new Error("raw gpu detail")));
			expect(screen.getByText(/此 GPU\/驱动程序上的终端初始化失败/)).toBeInTheDocument();
		} finally {
			consoleError.mockRestore();
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

	it("does not mirror an external terminal link into the Browser preview", () => {
		const view = renderPane(worker);
		try {
			act(() => terminalLinkHandler?.("https://example.com"));
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
