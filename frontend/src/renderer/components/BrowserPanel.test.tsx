import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel, BrowserPanelView, useBrowserAnnotationQueue } from "./BrowserPanel";
import { useBrowserView, type BrowserNavState } from "../hooks/useBrowserView";
import type { WorkspaceSession } from "../types/workspace";
import type { BrowserAnnotationCancelPayload, BrowserAnnotationSubmitPayload } from "../../shared/browser-annotations";

const postMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api-client", () => ({
	apiClient: { POST: postMock },
	apiErrorMessage: (error: unknown, fallback = "Request failed") =>
		typeof error === "object" && error !== null && "message" in error
			? String((error as { message: unknown }).message)
			: fallback,
}));

const hookState = vi.hoisted(() => ({
	navigate: vi.fn(),
	goBack: vi.fn(),
	goForward: vi.fn(),
	reload: vi.fn(),
	stop: vi.fn(),
	setAnnotationMode: vi.fn(),
	previewUrl: undefined as string | undefined,
	navState: {
		viewId: "42:sess-1",
		url: "",
		title: "",
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
	} as BrowserNavState,
}));

vi.mock("../hooks/useBrowserView", () => ({
	useBrowserView: (options: { previewUrl?: string }) => {
		hookState.previewUrl = options.previewUrl;
		return {
			viewId: "42:sess-1",
			navState: hookState.navState,
			slotRef: vi.fn(),
			navigate: hookState.navigate,
			goBack: hookState.goBack,
			goForward: hookState.goForward,
			reload: hookState.reload,
			stop: hookState.stop,
			annotationMode: false,
			setAnnotationMode: hookState.setAnnotationMode,
		};
	},
}));

const session: WorkspaceSession = {
	id: "sess-1",
	workspaceId: "ws-1",
	workspaceName: "my-app",
	title: "do the thing",
	provider: "claude-code",
	kind: "worker",
	branch: "feat/ns",
	status: "needs_input",
	updatedAt: "2026-06-15T00:00:00Z",
	prs: [],
};

function annotationPayload(instruction: string): BrowserAnnotationSubmitPayload {
	return {
		viewId: "42:sess-1",
		instruction,
		context: {
			url: "http://localhost:5173/",
			tag: "button",
			classes: [],
			selector: "button",
			rect: { x: 0, y: 0, width: 80, height: 30 },
			nearbyText: [],
			computedStyle: {},
		},
	};
}

function PersistentBrowserPanelView({
	currentSession,
	visible,
}: {
	currentSession: WorkspaceSession;
	visible: boolean;
}) {
	const browserView = useBrowserView({
		sessionId: currentSession.id,
		active: true,
		poppedOut: false,
		previewUrl: currentSession.previewUrl,
		previewRevision: currentSession.previewRevision,
	});
	const annotationQueue = useBrowserAnnotationQueue({
		sessionId: currentSession.id,
		navUrl: browserView.navState.url,
	});
	if (!visible) return null;
	return (
		<BrowserPanelView
			active
			annotationQueue={annotationQueue}
			browserView={browserView}
			onTogglePopOut={() => undefined}
			poppedOut={false}
			session={currentSession}
		/>
	);
}

describe("BrowserPanel", () => {
	const annotationSubmitListeners = new Set<(payload: BrowserAnnotationSubmitPayload) => void>();
	const annotationCancelListeners = new Set<(payload: BrowserAnnotationCancelPayload) => void>();

	beforeEach(() => {
		hookState.navigate.mockReset();
		hookState.goBack.mockReset();
		hookState.goForward.mockReset();
		hookState.reload.mockReset();
		hookState.stop.mockReset();
		hookState.setAnnotationMode.mockReset();
		hookState.setAnnotationMode.mockResolvedValue(undefined);
		postMock.mockReset();
		postMock.mockResolvedValue({ data: {} });
		annotationSubmitListeners.clear();
		annotationCancelListeners.clear();
		window.ao!.browser.onAnnotationSubmit = vi.fn((listener: (payload: BrowserAnnotationSubmitPayload) => void) => {
			annotationSubmitListeners.add(listener);
			return () => {
				annotationSubmitListeners.delete(listener);
			};
		});
		window.ao!.browser.onAnnotationCancel = vi.fn((listener: (payload: BrowserAnnotationCancelPayload) => void) => {
			annotationCancelListeners.add(listener);
			return () => {
				annotationCancelListeners.delete(listener);
			};
		});
		hookState.previewUrl = undefined;
		hookState.navState = {
			viewId: "42:sess-1",
			url: "",
			title: "",
			canGoBack: false,
			canGoForward: false,
			isLoading: false,
		};
	});

	it("navigates to the entered URL on submit", async () => {
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);
		const input = screen.getByRole("textbox", { name: /browser url/i });

		await userEvent.clear(input);
		await userEvent.type(input, "localhost:5173{Enter}");

		expect(hookState.navigate).toHaveBeenCalledWith("localhost:5173");
	});

	it("threads the session preview URL into the browser view (which drives navigation)", () => {
		render(
			<BrowserPanel
				active
				onTogglePopOut={() => undefined}
				poppedOut={false}
				session={{ ...session, previewUrl: "file:///tmp/preview/index.html" }}
			/>,
		);

		expect(hookState.previewUrl).toBe("file:///tmp/preview/index.html");
	});

	it("binds navigation controls to nav state", async () => {
		hookState.navState = {
			viewId: "42:sess-1",
			url: "http://localhost:5173/",
			title: "Local app",
			canGoBack: true,
			canGoForward: false,
			isLoading: true,
		};
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);

		await userEvent.click(screen.getByRole("button", { name: /back/i }));
		await userEvent.click(screen.getByRole("button", { name: /stop/i }));

		expect(hookState.goBack).toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /forward/i })).toBeDisabled();
		expect(hookState.stop).toHaveBeenCalled();
	});

	it("shows empty and error states", () => {
		hookState.navState = { ...hookState.navState, error: "Connection refused" };
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);

		expect(screen.getByText("Enter a URL or click one in the terminal.")).toBeInTheDocument();
		expect(screen.getByText("Connection refused")).toBeInTheDocument();
	});

	it("toggles pop-out mode", async () => {
		const onTogglePopOut = vi.fn();
		render(<BrowserPanel active onTogglePopOut={onTogglePopOut} poppedOut={false} session={session} />);

		await userEvent.click(screen.getByRole("button", { name: /pop out/i }));

		expect(onTogglePopOut).toHaveBeenCalledWith(true);
	});

	it("enables annotation mode from the toolbar when a page is loaded", async () => {
		hookState.navState = { ...hookState.navState, url: "http://localhost:5173/" };
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);

		await userEvent.click(screen.getByRole("button", { name: /annotate/i }));

		expect(hookState.setAnnotationMode).toHaveBeenCalledWith(true);
	});

	it("shows the working indicator only for active agent activity", () => {
		hookState.navState = { ...hookState.navState, url: "http://localhost:5173/" };
		const first = render(
			<BrowserPanel
				active
				onTogglePopOut={() => undefined}
				poppedOut={false}
				session={{
					...session,
					status: "idle",
					activity: { state: "active", lastActivityAt: "2026-06-15T00:00:00Z" },
				}}
			/>,
		);

		expect(screen.getByRole("button", { name: /annotate/i })).toBeEnabled();
		expect(screen.getByText("Agent working")).toBeInTheDocument();

		first.unmount();
		render(
			<BrowserPanel
				active
				onTogglePopOut={() => undefined}
				poppedOut={false}
				session={{
					...session,
					status: "working",
					activity: { state: "idle", lastActivityAt: "2026-06-15T00:00:00Z" },
				}}
			/>,
		);

		expect(screen.getByRole("button", { name: /annotate/i })).toBeEnabled();
		expect(screen.queryByText("Agent working")).not.toBeInTheDocument();
	});

	it("disables annotation mode when no page is loaded", () => {
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);

		expect(screen.getByRole("button", { name: /annotate/i })).toBeDisabled();
	});

	it("sends submitted annotation instructions to the session agent", async () => {
		hookState.navState = { ...hookState.navState, url: "http://localhost:5173/" };
		render(
			<BrowserPanel
				active
				onTogglePopOut={() => undefined}
				poppedOut={false}
				session={{ ...session, status: "idle" }}
			/>,
		);

		act(() => {
			annotationSubmitListeners.forEach((listener) =>
				listener({
					viewId: "42:sess-1",
					instruction: "Make this button blue.",
					context: {
						url: "http://localhost:5173/",
						title: "Preview",
						tag: "button",
						id: "save",
						classes: ["primary"],
						selector: "button#save",
						rect: { x: 16, y: 24, width: 140, height: 36 },
						visibleText: "Save changes",
						nearbyText: ["Profile settings"],
						computedStyle: {},
					},
				}),
			);
		});

		expect(await screen.findByText("Sent")).toBeInTheDocument();
		expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/send", {
			params: { path: { sessionId: "sess-1" } },
			body: {
				message: expect.stringContaining("Make this button blue."),
			},
		});
		const body = postMock.mock.calls[0][1].body as { message: string };
		expect(body.message).toContain("button#save");
		expect(body.message.length).toBeLessThanOrEqual(4096);
	});

	it("sends a follow-up annotation without waiting for an activity-state cycle", async () => {
		hookState.navState = { ...hookState.navState, url: "http://localhost:5173/" };
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);

		act(() => {
			annotationSubmitListeners.forEach((listener) => listener(annotationPayload("Make this button blue.")));
		});
		expect(await screen.findByText("Sent")).toBeInTheDocument();
		expect(postMock).toHaveBeenCalledTimes(1);

		act(() => {
			annotationSubmitListeners.forEach((listener) => listener(annotationPayload("Make this button green.")));
		});

		expect(await screen.findByText("Sent")).toBeInTheDocument();
		expect(postMock).toHaveBeenCalledTimes(2);
		expect((postMock.mock.calls[1][1].body as { message: string }).message).toContain("Make this button green.");
	});

	it("serializes annotations in order exactly once while status remains working", async () => {
		let resolveFirstPost: (value: unknown) => void = () => undefined;
		let resolveSecondPost: (value: unknown) => void = () => undefined;
		postMock
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveFirstPost = resolve;
				}),
			)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveSecondPost = resolve;
				}),
			)
			.mockResolvedValueOnce({ data: {} });
		hookState.navState = { ...hookState.navState, url: "http://localhost:5173/" };
		render(
			<BrowserPanel
				active
				onTogglePopOut={() => undefined}
				poppedOut={false}
				session={{ ...session, status: "working" }}
			/>,
		);
		const instructions = ["Make this button blue.", "Make this heading shorter.", "Reduce the card padding."];

		act(() => {
			annotationSubmitListeners.forEach((listener) => {
				instructions.forEach((instruction) => listener(annotationPayload(instruction)));
			});
		});

		expect(postMock).toHaveBeenCalledTimes(1);
		await act(async () => {
			resolveFirstPost({ data: {} });
		});
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
		expect(postMock).toHaveBeenCalledTimes(2);
		await act(async () => {
			resolveSecondPost({ data: {} });
		});
		expect(await screen.findByText("Sent")).toBeInTheDocument();
		expect(postMock).toHaveBeenCalledTimes(3);
		expect(
			postMock.mock.calls.map(
				(call) => (call[1].body as { message: string }).message.match(/Change request:\n(.+)/)?.[1],
			),
		).toEqual(instructions);
	});

	it("preserves queued annotations while the BrowserPanelView is unmounted", async () => {
		let resolvePost: (value: unknown) => void = () => undefined;
		postMock
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolvePost = resolve;
				}),
			)
			.mockResolvedValueOnce({ data: {} });
		hookState.navState = { ...hookState.navState, url: "http://localhost:5173/" };
		const { rerender } = render(<PersistentBrowserPanelView currentSession={session} visible />);

		act(() => {
			annotationSubmitListeners.forEach((listener) => {
				listener(annotationPayload("Make this button blue."));
				listener(annotationPayload("Make this heading shorter."));
			});
		});
		expect(postMock).toHaveBeenCalledTimes(1);

		rerender(<PersistentBrowserPanelView currentSession={session} visible={false} />);
		expect(postMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			resolvePost({ data: {} });
		});
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
		expect(postMock).toHaveBeenCalledTimes(2);
		expect((postMock.mock.calls[0][1].body as { message: string }).message).toContain("Make this button blue.");
		expect((postMock.mock.calls[1][1].body as { message: string }).message).toContain("Make this heading shorter.");

		rerender(<PersistentBrowserPanelView currentSession={session} visible />);
		expect(await screen.findByText("Sent")).toBeInTheDocument();
		expect((postMock.mock.calls[1][1].body as { message: string }).message).toContain("Make this heading shorter.");
	});

	it("continues queued delivery across activity status changes", async () => {
		let resolvePost: (value: unknown) => void = () => undefined;
		postMock
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolvePost = resolve;
				}),
			)
			.mockResolvedValueOnce({ data: {} });
		hookState.navState = { ...hookState.navState, url: "http://localhost:5173/" };
		const { rerender } = render(
			<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />,
		);
		const payload = {
			viewId: "42:sess-1",
			instruction: "Make this button yellow.",
			context: {
				url: "http://localhost:5173/",
				tag: "button",
				classes: [],
				selector: "button",
				rect: { x: 0, y: 0, width: 80, height: 30 },
				nearbyText: [],
				computedStyle: {},
			},
		};

		act(() => {
			annotationSubmitListeners.forEach((listener) => {
				listener(payload);
				listener({ ...payload, instruction: "Make this button blue." });
			});
		});
		rerender(
			<BrowserPanel
				active
				onTogglePopOut={() => undefined}
				poppedOut={false}
				session={{ ...session, status: "working" }}
			/>,
		);
		await act(async () => {
			resolvePost({ data: {} });
		});
		rerender(
			<BrowserPanel
				active
				onTogglePopOut={() => undefined}
				poppedOut={false}
				session={{ ...session, status: "idle" }}
			/>,
		);
		expect(await screen.findByText("Sent")).toBeInTheDocument();
		expect(postMock).toHaveBeenCalledTimes(2);
	});

	it("sends submitted annotations while the session status is working", async () => {
		hookState.navState = { ...hookState.navState, url: "http://localhost:5173/" };
		render(
			<BrowserPanel
				active
				onTogglePopOut={() => undefined}
				poppedOut={false}
				session={{ ...session, status: "working" }}
			/>,
		);

		act(() => {
			annotationSubmitListeners.forEach((listener) =>
				listener({
					viewId: "42:sess-1",
					instruction: "Move this card higher.",
					context: {
						url: "http://localhost:5173/",
						tag: "section",
						classes: [],
						selector: "section",
						rect: { x: 0, y: 0, width: 320, height: 180 },
						nearbyText: [],
						computedStyle: {},
					},
				}),
			);
		});

		expect(await screen.findByText("Sent")).toBeInTheDocument();
		expect(postMock).toHaveBeenCalledTimes(1);
	});

	it("shows annotation send errors", async () => {
		postMock.mockResolvedValue({ error: { message: "AO daemon is not ready." } });
		hookState.navState = { ...hookState.navState, url: "http://localhost:5173/" };
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);

		act(() => {
			annotationSubmitListeners.forEach((listener) =>
				listener({
					viewId: "42:sess-1",
					instruction: "Make this button blue.",
					context: {
						url: "http://localhost:5173/",
						tag: "button",
						classes: [],
						selector: "button",
						rect: { x: 0, y: 0, width: 80, height: 30 },
						nearbyText: [],
						computedStyle: {},
					},
				}),
			);
		});

		expect(await screen.findByText("AO daemon is not ready.")).toBeInTheDocument();
	});

	it("keeps a failed annotation queued so the user can retry it", async () => {
		postMock
			.mockResolvedValueOnce({ error: { message: "AO daemon is not ready." } })
			.mockResolvedValueOnce({ data: {} });
		hookState.navState = { ...hookState.navState, url: "http://localhost:5173/" };
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);
		const payload = annotationPayload("Keep my original annotation request.");

		act(() => {
			annotationSubmitListeners.forEach((listener) =>
				listener({
					...payload,
					context: {
						...payload.context,
						selector: "button#save",
					},
				}),
			);
		});

		expect(await screen.findByText("AO daemon is not ready.")).toBeInTheDocument();
		expect(postMock).toHaveBeenCalledTimes(1);

		await userEvent.click(screen.getByRole("button", { name: /retry annotation/i }));

		expect(await screen.findByText("Sent")).toBeInTheDocument();
		expect(postMock).toHaveBeenCalledTimes(2);
		const retryBody = postMock.mock.calls[1][1].body as { message: string };
		expect(retryBody.message).toContain("Keep my original annotation request.");
		expect(retryBody.message).toContain("button#save");
	});

	it("clears picking state when the page cancels annotation mode", async () => {
		hookState.navState = { ...hookState.navState, url: "http://localhost:5173/" };
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);

		await userEvent.click(screen.getByRole("button", { name: /annotate/i }));
		expect(screen.getByText("Pick element")).toBeInTheDocument();

		act(() => {
			annotationCancelListeners.forEach((listener) => listener({ viewId: "42:sess-1", reason: "escape" }));
		});

		expect(screen.queryByText("Pick element")).not.toBeInTheDocument();
	});
});
