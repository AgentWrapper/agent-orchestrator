import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBrowserView, type BrowserNavState } from "./useBrowserView";

type Listener = (state: BrowserNavState) => void;

function createSlot(rect: Partial<DOMRect> = {}) {
	const slot = document.createElement("div");
	document.body.appendChild(slot);
	slot.getBoundingClientRect = vi.fn(() => ({
		x: 12,
		y: 34,
		width: 320,
		height: 240,
		top: 34,
		right: 332,
		bottom: 274,
		left: 12,
		toJSON: () => ({}),
		...rect,
	}));
	return slot;
}

function setupBridge() {
	const listeners = new Set<Listener>();
	const bridge = {
		stateFor(viewId: string): BrowserNavState {
			return {
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			};
		},
		ensure: vi.fn(async (sessionId: string): Promise<BrowserNavState> => ({
			viewId: `42:${sessionId}`,
			url: "",
			title: "",
			canGoBack: false,
			canGoForward: false,
			isLoading: false,
		})),
		setBounds: vi.fn(),
		navigate: vi.fn(async ({ viewId }: { viewId: string }) => bridge.stateFor(viewId)),
		clear: vi.fn(async (viewId: string) => bridge.stateFor(viewId)),
		goBack: vi.fn(async (viewId: string) => bridge.stateFor(viewId)),
		goForward: vi.fn(async (viewId: string) => bridge.stateFor(viewId)),
		reload: vi.fn(async (viewId: string) => bridge.stateFor(viewId)),
		stop: vi.fn(async (viewId: string) => bridge.stateFor(viewId)),
		destroy: vi.fn(),
		setAnnotationMode: vi.fn(async () => undefined),
		onNavState: vi.fn((listener: Listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
		onAnnotationSubmit: vi.fn(() => () => undefined),
		onAnnotationCancel: vi.fn(() => () => undefined),
		emit(state: BrowserNavState) {
			listeners.forEach((listener) => listener(state));
		},
	};
	window.ao = { ...window.ao!, browser: bridge };
	return bridge;
}

describe("useBrowserView", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		document.body.replaceChildren();
	});

	it("ensures a scoped browser view and reports the measured slot bounds", async () => {
		const bridge = setupBridge();
		const slot = createSlot();
		const { result } = renderHook(() => useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false }));

		await waitFor(() => expect(bridge.ensure).toHaveBeenCalledWith("sess-1"));
		// Simulate the real IPC flow: after ensure, a navigate call sends a nav
		// state with a URL so the positioning effect considers the view visible.
		act(() =>
			bridge.emit({
				viewId: "42:sess-1",
				url: "http://localhost:3000/",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
		);
		act(() => result.current.slotRef(slot));

		await waitFor(() =>
			expect(bridge.setBounds).toHaveBeenCalledWith({
				viewId: "42:sess-1",
				rect: { x: 12, y: 34, width: 320, height: 240 },
				visible: true,
			}),
		);
		expect(result.current.viewId).toBe("42:sess-1");
	});

	it("clamps the native view to its resizable-panel column when the slot overspills", async () => {
		const bridge = setupBridge();
		// The slot is wider than its column (e.g. the `min-w-[280px]` wrapper on a
		// narrower inspector panel). The native overlay isn't clipped by DOM
		// overflow, so the reported bounds must be intersected with the column.
		const column = document.createElement("div");
		column.setAttribute("data-panel", "");
		column.getBoundingClientRect = vi.fn(() => ({
			x: 100,
			y: 0,
			width: 150,
			height: 600,
			top: 0,
			right: 250,
			bottom: 600,
			left: 100,
			toJSON: () => ({}),
		}));
		const slot = createSlot();
		column.appendChild(slot);
		document.body.appendChild(column);

		const { result } = renderHook(() => useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false }));
		await waitFor(() => expect(bridge.ensure).toHaveBeenCalledWith("sess-1"));
		act(() =>
			bridge.emit({
				viewId: "42:sess-1",
				url: "http://localhost:3000/",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
		);
		act(() => result.current.slotRef(slot));

		await waitFor(() =>
			expect(bridge.setBounds).toHaveBeenCalledWith({
				viewId: "42:sess-1",
				rect: { x: 100, y: 34, width: 150, height: 240 },
				visible: true,
			}),
		);
	});

	it("re-measures after a layout transition settles, catching a position-only shift", async () => {
		// A ResizeObserver fires on size changes only; entering pop-out / opening the
		// inspector moves the slot to a new x without resizing it, so the transition
		// itself must drive a settle re-measure or the native overlay keeps stale
		// (spilled) bounds. This is the regression behind the preview covering the
		// terminal until an unrelated window resize fixed it.
		vi.useFakeTimers();
		try {
			const bridge = setupBridge();
			const slot = createSlot();
			const { result, rerender } = renderHook(
				({ poppedOut }) => useBrowserView({ sessionId: "sess-1", active: true, poppedOut }),
				{ initialProps: { poppedOut: false } },
			);
			// ensure() resolves on a microtask; flush it without advancing timers.
			await act(async () => {
				await Promise.resolve();
			});
			// Simulate a real nav state with URL so the positioning effect shows the view.
			act(() =>
				bridge.emit({
					viewId: "42:sess-1",
					url: "http://localhost:3000/",
					title: "",
					canGoBack: false,
					canGoForward: false,
					isLoading: false,
				}),
			);
			act(() => result.current.slotRef(slot));
			// Flush the mount measure (immediate frame + settle timer).
			await act(async () => {
				vi.advanceTimersByTime(300);
			});
			expect(bridge.setBounds).toHaveBeenCalled();

			// Pop-out transition: the immediate frame captures the still-animating
			// geometry; the final position only lands once the panel has settled.
			act(() => rerender({ poppedOut: true }));
			await act(async () => {
				vi.advanceTimersByTime(20);
			});
			bridge.setBounds.mockClear();
			slot.getBoundingClientRect = vi.fn(() => ({
				x: 240,
				y: 34,
				width: 320,
				height: 240,
				top: 34,
				right: 560,
				bottom: 274,
				left: 240,
				toJSON: () => ({}),
			}));
			await act(async () => {
				vi.advanceTimersByTime(300);
			});
			expect(bridge.setBounds).toHaveBeenCalledWith(
				expect.objectContaining({ rect: expect.objectContaining({ x: 240, width: 320 }) }),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	// M12 (#293): unmounting a LIVE session still only hides its view — the page
	// stays warm so switching back is instant, and the main process now bounds the
	// number of hidden views with LRU eviction. What must never happen (and used to)
	// is a view surviving the session itself; see the terminated cases below.
	it("hides a live session's view when inactive and on unmount, keeping it warm", async () => {
		const bridge = setupBridge();
		const slot = createSlot();
		const { result, rerender, unmount } = renderHook(
			({ active }) => useBrowserView({ sessionId: "sess-1", active, poppedOut: false }),
			{ initialProps: { active: true } },
		);
		await waitFor(() => expect(result.current.viewId).toBe("42:sess-1"));
		act(() => result.current.slotRef(slot));

		rerender({ active: false });
		await waitFor(() =>
			expect(bridge.setBounds).toHaveBeenLastCalledWith({
				viewId: "42:sess-1",
				rect: { x: 0, y: 0, width: 0, height: 0 },
				visible: false,
			}),
		);

		unmount();
		expect(bridge.setBounds).toHaveBeenLastCalledWith({
			viewId: "42:sess-1",
			rect: { x: 0, y: 0, width: 0, height: 0 },
			visible: false,
		});
		expect(bridge.destroy).not.toHaveBeenCalled();
	});

	// M12 (#293): a terminated session's page has nothing left to show and nobody to
	// come back to it — it must be torn down, not parked hidden with its timers,
	// sockets and memory intact.
	it("destroys the view when the session is terminated", async () => {
		const bridge = setupBridge();
		const { rerender } = renderHook(
			({ terminated }) =>
				useBrowserView({
					sessionId: "sess-1",
					active: true,
					poppedOut: false,
					terminated,
					previewUrl: "http://localhost:5173/",
					previewRevision: 1,
				}),
			{ initialProps: { terminated: false } },
		);
		await waitFor(() => expect(bridge.navigate).toHaveBeenCalledTimes(1));

		rerender({ terminated: true });
		await waitFor(() => expect(bridge.destroy).toHaveBeenCalledWith("42:sess-1"));
	});

	// The teardown is async (clear, then destroy). If the route unmounts first, the
	// unmount path cleared viewIdRef and the pending destroy would no-op — the view
	// would outlive its session. Unmount must therefore destroy a terminated view.
	it("destroys a terminated session's view even when the route unmounts mid-teardown", async () => {
		const bridge = setupBridge();
		const { result, rerender, unmount } = renderHook(
			({ terminated }) => useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false, terminated }),
			{ initialProps: { terminated: false } },
		);
		await waitFor(() => expect(result.current.viewId).toBe("42:sess-1"));

		// Terminate and navigate away in the same tick, before clear() resolves.
		rerender({ terminated: true });
		unmount();

		expect(bridge.destroy).toHaveBeenCalledWith("42:sess-1");
		await waitFor(() => expect(bridge.destroy).toHaveBeenCalledTimes(1));
	});

	it("destroys an already-terminated session's view exactly once, mount through unmount", async () => {
		const bridge = setupBridge();
		const { unmount } = renderHook(() =>
			useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false, terminated: true }),
		);
		await waitFor(() => expect(bridge.destroy).toHaveBeenCalledWith("42:sess-1"));

		// Unmount must not double-destroy an already-torn-down view.
		unmount();
		expect(bridge.destroy).toHaveBeenCalledTimes(1);
	});

	// M14 (#293): navigation was fire-and-forget. normalizeBrowserURL, the scheme
	// allowlist and loadURL can all reject across IPC, but the hook never caught
	// them: navState.error stayed undefined (the panel showed nothing at all, as if
	// the address bar submit had been ignored) and each attempt raised an unhandled
	// promise rejection.
	it("converts a rejected navigation into a visible nav-state error", async () => {
		const bridge = setupBridge();
		bridge.navigate.mockRejectedValue(new Error("Unsupported browser URL scheme: javascript:"));
		const { result } = renderHook(() => useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false }));
		await waitFor(() => expect(result.current.viewId).toBe("42:sess-1"));

		await act(async () => {
			await result.current.navigate("javascript:alert(1)");
		});

		await waitFor(() => expect(result.current.navState.error).toMatch(/Unsupported browser URL scheme/i));
		expect(result.current.navState.isLoading).toBe(false);
	});

	it("does not leave a rejected navigation unhandled", async () => {
		const bridge = setupBridge();
		bridge.navigate.mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));
		const { result } = renderHook(() => useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false }));
		await waitFor(() => expect(result.current.viewId).toBe("42:sess-1"));

		// The panel calls this as `void navigate(url)`; the promise must resolve.
		await expect(result.current.navigate("http://localhost:9/")).resolves.toBeUndefined();
		await waitFor(() => expect(result.current.navState.error).toMatch(/ERR_CONNECTION_REFUSED/));
	});

	it("surfaces rejected back/forward/reload/stop controls too", async () => {
		const bridge = setupBridge();
		bridge.reload.mockRejectedValue(new Error("Object has been destroyed"));
		const { result } = renderHook(() => useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false }));
		await waitFor(() => expect(result.current.viewId).toBe("42:sess-1"));

		await expect(result.current.reload()).resolves.toBeUndefined();
		await waitFor(() => expect(result.current.navState.error).toMatch(/Object has been destroyed/));
	});

	it("clears a stale nav error once a navigation succeeds", async () => {
		const bridge = setupBridge();
		bridge.navigate.mockRejectedValueOnce(new Error("Unsupported browser URL"));
		const { result } = renderHook(() => useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false }));
		await waitFor(() => expect(result.current.viewId).toBe("42:sess-1"));

		await act(async () => {
			await result.current.navigate("wat://nope");
		});
		await waitFor(() => expect(result.current.navState.error).toBeTruthy());

		await act(async () => {
			await result.current.navigate("http://localhost:5173/");
		});
		await waitFor(() => expect(result.current.navState.error).toBeUndefined());
	});

	it("updates nav state only for the current view", async () => {
		const bridge = setupBridge();
		const { result } = renderHook(() => useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false }));
		await waitFor(() => expect(result.current.viewId).toBe("42:sess-1"));

		act(() =>
			bridge.emit({
				viewId: "other:sess-1",
				url: "https://ignored.test/",
				title: "Ignored",
				canGoBack: true,
				canGoForward: true,
				isLoading: true,
			}),
		);
		expect(result.current.navState.url).toBe("");

		act(() =>
			bridge.emit({
				viewId: "42:sess-1",
				url: "http://localhost:5173/",
				title: "Local app",
				canGoBack: false,
				canGoForward: true,
				isLoading: false,
			}),
		);
		expect(result.current.navState.url).toBe("http://localhost:5173/");
		expect(result.current.navState.title).toBe("Local app");
	});

	it("navigates on each preview revision, including a same-URL re-run, and ignores replays", async () => {
		const bridge = setupBridge();
		const { rerender } = renderHook(
			({ previewUrl, previewRevision }) =>
				useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false, previewUrl, previewRevision }),
			{ initialProps: { previewUrl: "http://localhost:5173/", previewRevision: 1 } },
		);

		await waitFor(() =>
			expect(bridge.navigate).toHaveBeenCalledWith({ viewId: "42:sess-1", url: "http://localhost:5173/" }),
		);
		expect(bridge.navigate).toHaveBeenCalledTimes(1);

		// CDC replays the session payload on an unrelated update (revision
		// unchanged) — the panel must not reload.
		rerender({ previewUrl: "http://localhost:5173/", previewRevision: 1 });
		expect(bridge.navigate).toHaveBeenCalledTimes(1);

		// Re-running `ao preview` with the SAME url bumps the revision and must
		// re-navigate (refresh) — the regression this issue fixes.
		rerender({ previewUrl: "http://localhost:5173/", previewRevision: 2 });
		await waitFor(() => expect(bridge.navigate).toHaveBeenCalledTimes(2));

		// A changed target with a fresh revision navigates to the new URL.
		rerender({ previewUrl: "file:///tmp/preview/index.html", previewRevision: 3 });
		await waitFor(() =>
			expect(bridge.navigate).toHaveBeenCalledWith({ viewId: "42:sess-1", url: "file:///tmp/preview/index.html" }),
		);
		expect(bridge.navigate).toHaveBeenCalledTimes(3);
	});

	it("navigates legacy preview URLs when the daemon omits preview revisions", async () => {
		const bridge = setupBridge();
		const { result, rerender } = renderHook(
			({ previewUrl }) => useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false, previewUrl }),
			{ initialProps: { previewUrl: undefined as string | undefined } },
		);
		await waitFor(() => expect(result.current.viewId).toBe("42:sess-1"));
		expect(bridge.navigate).not.toHaveBeenCalled();

		rerender({ previewUrl: "http://localhost:5173/" });
		await waitFor(() =>
			expect(bridge.navigate).toHaveBeenCalledWith({ viewId: "42:sess-1", url: "http://localhost:5173/" }),
		);
		expect(bridge.navigate).toHaveBeenCalledTimes(1);

		rerender({ previewUrl: "http://localhost:5173/" });
		expect(bridge.navigate).toHaveBeenCalledTimes(1);

		rerender({ previewUrl: "C:\\Users\\Lenovo\\Downloads\\sm5\\paper_explainer.html" });
		await waitFor(() =>
			expect(bridge.navigate).toHaveBeenCalledWith({
				viewId: "42:sess-1",
				url: "C:\\Users\\Lenovo\\Downloads\\sm5\\paper_explainer.html",
			}),
		);
		expect(bridge.navigate).toHaveBeenCalledTimes(2);
	});

	it("clears the view when the preview is reset (ao preview clear) and does not navigate", async () => {
		const bridge = setupBridge();
		const { rerender } = renderHook(
			({ previewUrl, previewRevision }) =>
				useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false, previewUrl, previewRevision }),
			{ initialProps: { previewUrl: "http://localhost:5173/" as string | undefined, previewRevision: 1 } },
		);
		await waitFor(() => expect(bridge.navigate).toHaveBeenCalledTimes(1));

		// `ao preview clear` empties previewUrl and bumps the revision.
		rerender({ previewUrl: undefined, previewRevision: 2 });
		await waitFor(() => expect(bridge.clear).toHaveBeenCalledWith("42:sess-1"));
		expect(bridge.navigate).toHaveBeenCalledTimes(1);
	});

	it("does not navigate or clear without a preview URL at revision zero", async () => {
		const bridge = setupBridge();
		const { result } = renderHook(() => useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false }));
		await waitFor(() => expect(result.current.viewId).toBe("42:sess-1"));
		expect(bridge.navigate).not.toHaveBeenCalled();
		expect(bridge.clear).not.toHaveBeenCalled();
	});

	it("clears the view when the session is terminated, even with an active preview URL", async () => {
		const bridge = setupBridge();
		const { rerender } = renderHook(
			({ terminated }) =>
				useBrowserView({
					sessionId: "sess-1",
					active: true,
					poppedOut: false,
					terminated,
					previewUrl: "http://localhost:5173/",
					previewRevision: 1,
				}),
			{ initialProps: { terminated: false } },
		);
		// The preview drives a navigate on mount.
		await waitFor(() => expect(bridge.navigate).toHaveBeenCalledTimes(1));

		// Terminate the session – the view must be cleared and no re-navigate.
		rerender({ terminated: true });
		await waitFor(() => expect(bridge.clear).toHaveBeenCalledWith("42:sess-1"));
		expect(bridge.navigate).toHaveBeenCalledTimes(1);
	});

	// #293: destroy() disabled annotation mode with a bare `void`, unlike the unmount
	// path's catching helper. Teardown and LRU eviction are exactly when the view is
	// already gone, so that IPC rejects ("Object has been destroyed") — unhandled.
	it("does not leak an unhandled rejection when destroy() disables annotation mode on a dead view", async () => {
		const bridge = setupBridge();
		const rejections: unknown[] = [];
		const onUnhandled = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const { result } = renderHook(() => useBrowserView({ sessionId: "sess-1", active: true, poppedOut: false }));
			await waitFor(() => expect(result.current.viewId).toBe("42:sess-1"));
			// A loaded page: annotation mode is only meaningful (and only stays on) for
			// a view that has a URL.
			act(() =>
				bridge.emit({
					viewId: "42:sess-1",
					url: "http://localhost:3000/",
					title: "",
					canGoBack: false,
					canGoForward: false,
					isLoading: false,
				}),
			);

			await act(async () => {
				await result.current.setAnnotationMode(true);
			});
			expect(result.current.annotationMode).toBe(true);

			// The view dies underneath us (destroyed page / evicted view). A plain
			// function, not a vi.fn: vitest observes a mock's returned promise to record
			// its settled result, which would itself handle the rejection and hide the
			// leak this test exists to catch.
			const disableCalls: Array<{ viewId: string; enabled: boolean }> = [];
			window.ao!.browser.setAnnotationMode = (payload: { viewId: string; enabled: boolean }) => {
				disableCalls.push(payload);
				return Promise.reject(new Error("Object has been destroyed"));
			};
			act(() => result.current.destroy());

			expect(disableCalls).toEqual([{ viewId: "42:sess-1", enabled: false }]);
			// Let any unhandled rejection reach the process hook.
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(rejections).toEqual([]);
			expect(bridge.destroy).toHaveBeenCalledWith("42:sess-1");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
