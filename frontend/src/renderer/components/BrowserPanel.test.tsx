import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel, BrowserPanelView, useBrowserAnnotationQueue } from "./BrowserPanel";
import { useBrowserView, type BrowserNavState } from "../hooks/useBrowserView";
import { i18n } from "../i18n";
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

	it("switches interactive controls and annotation status live without changing browser data", async () => {
		const rawURL = "http://localhost:5173/用户路径?模式=预览";
		const rawError = "net::ERR_CONNECTION_REFUSED（原始详情）";
		hookState.navState = {
			viewId: "42:sess-1",
			url: rawURL,
			title: "用户页面标题",
			canGoBack: true,
			canGoForward: true,
			isLoading: false,
			error: rawError,
		};
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);

		expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Browser URL" })).toHaveValue(rawURL);
		expect(screen.getByText(rawError)).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Annotate page" }));
		expect(screen.getByText("Pick element")).toBeInTheDocument();

		await act(async () => i18n.changeLanguage("zh-CN"));

		expect(screen.getByRole("button", { name: "后退" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "取消批注" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "弹出浏览器" })).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "浏览器地址" })).toHaveValue(rawURL);
		expect(screen.getByText("选择元素")).toBeInTheDocument();
		expect(screen.getByText(rawError)).toBeInTheDocument();
		expect(hookState.navState.title).toBe("用户页面标题");
	});

	it("switches empty and browser-error labels while preserving the raw navigation detail", async () => {
		hookState.navState = { ...hookState.navState, error: "Connection refused" };
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);

		expect(screen.getByText("Enter a URL or click one in the terminal.")).toBeInTheDocument();
		expect(screen.getByText("Browser error")).toBeInTheDocument();
		expect(screen.getByText("Connection refused")).toBeInTheDocument();

		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("输入地址，或点击终端中的链接。")).toBeInTheDocument();
		expect(screen.getByText("浏览器错误")).toBeInTheDocument();
		expect(screen.getByText("Connection refused")).toBeInTheDocument();
	});

	it("retranslates a known browser navigation error without remounting", async () => {
		hookState.navState = { ...hookState.navState, url: "http://localhost:5173", error: "BROWSER_URL_UNSUPPORTED" };
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);

		expect(screen.getByText("This browser URL is not supported.")).toBeInTheDocument();
		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("不支持此浏览器地址。")).toBeInTheDocument();
		expect(screen.queryByText("BROWSER_URL_UNSUPPORTED")).not.toBeInTheDocument();
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

	it("keeps annotation mode available while the session is working", () => {
		hookState.navState = { ...hookState.navState, url: "http://localhost:5173/" };
		render(
			<BrowserPanel
				active
				onTogglePopOut={() => undefined}
				poppedOut={false}
				session={{ ...session, status: "working" }}
			/>,
		);

		expect(screen.getByRole("button", { name: /annotate/i })).toBeEnabled();
		expect(screen.getByText("Agent working")).toBeInTheDocument();
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

	it("retranslates an application annotation fallback while preserving the queued user request", async () => {
		postMock.mockResolvedValue({ error: {} });
		hookState.navState = { ...hookState.navState, url: "http://localhost:5173/" };
		render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);
		const rawInstruction = "把按钮文字改成 保持原样。";

		act(() => {
			annotationSubmitListeners.forEach((listener) => listener(annotationPayload(rawInstruction)));
		});

		expect(await screen.findByText("Unable to send annotation.")).toBeInTheDocument();
		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("无法发送批注。")).toBeInTheDocument();
		expect(screen.queryByText("Unable to send annotation.")).not.toBeInTheDocument();
		expect((postMock.mock.calls[0][1].body as { message: string }).message).toContain(rawInstruction);
	});

	it("localizes static preview labels while leaving preview values and commands unchanged", async () => {
		const originalAO = window.ao;
		window.ao = undefined;
		hookState.navState = {
			...hookState.navState,
			url: "http://localhost:5173/原始路径",
			title: "原始浏览器标题",
		};

		try {
			render(<BrowserPanel active onTogglePopOut={() => undefined} poppedOut={false} session={session} />);
			expect(screen.getByText("AO Preview")).toBeInTheDocument();
			expect(screen.getByText("Demo app preview")).toBeInTheDocument();
			expect(screen.getByText("12 passing")).toBeInTheDocument();
			expect(screen.getByText("ready")).toBeInTheDocument();
			expect(screen.getByText("42 ms")).toBeInTheDocument();

			await act(async () => i18n.changeLanguage("zh-CN"));

			expect(screen.getByText("AO 预览")).toBeInTheDocument();
			expect(screen.getByText("演示应用预览")).toBeInTheDocument();
			expect(screen.getByText("已加载")).toBeInTheDocument();
			expect(screen.getByText("路由")).toBeInTheDocument();
			expect(screen.getByText("构建")).toBeInTheDocument();
			expect(screen.getByText("延迟")).toBeInTheDocument();
			expect(screen.getByText("http://localhost:5173/原始路径")).toBeInTheDocument();
			expect(screen.getByText("12 项通过")).toBeInTheDocument();
			expect(screen.getByText("就绪")).toBeInTheDocument();
			expect(screen.getByText("42 毫秒")).toBeInTheDocument();
			expect(screen.getByText("$ npm run dev -- --host 127.0.0.1")).toBeInTheDocument();
			expect(screen.getByText("ready in 418 ms")).toBeInTheDocument();
			expect(screen.getByText("Local: http://localhost:5173/")).toBeInTheDocument();
			expect(hookState.navState.title).toBe("原始浏览器标题");
		} finally {
			window.ao = originalAO;
		}
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
