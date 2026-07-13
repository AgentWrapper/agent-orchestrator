import { describe, expect, it, vi } from "vitest";
import {
	type BrowserNavState,
	clampBoundsToWindow,
	createBrowserViewHost,
	DEFAULT_MAX_BROWSER_VIEWS,
	isAllowedBrowserURL,
	normalizeBrowserURL,
	scaleBoundsForZoom,
} from "./browser-view-host";

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown;
type EventHandler = (event: { sender: { id: number; getZoomFactor?: () => number } }, ...args: unknown[]) => unknown;

type ContentsEventHandler = (...args: unknown[]) => unknown;
type WindowOpenHandler = (details: { url: string }) => unknown;

function setupHost(overrides: { openExternal?: (url: string) => Promise<void> } = {}) {
	let currentURL = "";
	// Handlers the host wires onto the view's own webContents (did-fail-load, …)
	// and the window-open handler, so tests can drive them like Chromium would.
	const contentsEvents = new Map<string, ContentsEventHandler[]>();
	let windowOpenHandler: WindowOpenHandler | null = null;
	const webContents = {
		id: 99,
		canGoBack: () => false,
		canGoForward: () => false,
		clearHistory: () => undefined,
		getTitle: () => "",
		getURL: () => currentURL,
		goBack: () => undefined,
		goForward: () => undefined,
		isLoading: () => false,
		loadURL: vi.fn(async (url: string) => {
			currentURL = url;
		}),
		on: (event: string, handler: ContentsEventHandler) => {
			contentsEvents.set(event, [...(contentsEvents.get(event) ?? []), handler]);
		},
		reload: () => undefined,
		send: vi.fn(),
		setWindowOpenHandler: (handler: WindowOpenHandler) => {
			windowOpenHandler = handler;
		},
		stop: () => undefined,
		close: () => undefined,
	};
	const view = {
		webContents,
		setBounds: vi.fn(),
		setVisible: vi.fn(),
	};
	const handlers = new Map<string, InvokeHandler>();
	const eventHandlers = new Map<string, EventHandler>();
	const sent: Array<{ channel: string; payload: unknown }> = [];
	const host = createBrowserViewHost({
		mainWindow: {
			contentView: { addChildView: () => undefined, removeChildView: () => undefined },
			getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
			webContents: { id: 1, send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
		} as never,
		ipcMain: {
			handle: (channel: string, fn: InvokeHandler) => handlers.set(channel, fn),
			on: (channel: string, fn: EventHandler) => eventHandlers.set(channel, fn),
			removeHandler: () => undefined,
			off: () => undefined,
		} as never,
		shell: { openExternal: overrides.openExternal ?? (async () => undefined) },
		WebContentsView: function () {
			return view;
		} as never,
		annotatePreloadPath: "/preload.js",
		rendererOrigin: "http://localhost:5173",
	});
	const invoke = (channel: string, ...args: unknown[]) =>
		handlers.get(channel)!({ sender: { id: 1 } }, ...args) as Promise<BrowserNavState>;
	const emit = (channel: string, zoomFactor: number, ...args: unknown[]) =>
		eventHandlers.get(channel)!({ sender: { id: 1, getZoomFactor: () => zoomFactor } }, ...args);
	const send = (channel: string, senderId: number, ...args: unknown[]) =>
		eventHandlers.get(channel)!({ sender: { id: senderId } }, ...args);
	/** Fire an event on the view's own webContents, as Chromium would. */
	const emitContents = (event: string, ...args: unknown[]) => {
		for (const handler of contentsEvents.get(event) ?? []) handler(...args);
	};
	const openWindow = (url: string) => windowOpenHandler?.({ url });
	return { emit, emitContents, host, invoke, openWindow, send, sent, view, webContents };
}

describe("normalizeBrowserURL", () => {
	it("defaults localhost-style inputs to http", () => {
		expect(normalizeBrowserURL("localhost:5173").href).toBe("http://localhost:5173/");
		expect(normalizeBrowserURL("127.0.0.1:3000").href).toBe("http://127.0.0.1:3000/");
		expect(normalizeBrowserURL("[::1]:4173").href).toBe("http://[::1]:4173/");
	});

	it("defaults ordinary bare hosts to https", () => {
		expect(normalizeBrowserURL("example.com").href).toBe("https://example.com/");
	});

	it("allows file:// preview targets without mangling the scheme", () => {
		expect(normalizeBrowserURL("file:///tmp/preview/index.html").href).toBe("file:///tmp/preview/index.html");
		expect(normalizeBrowserURL("file:///C:/tmp/index.html").protocol).toBe("file:");
	});

	it("converts absolute local file paths to file URLs", () => {
		expect(normalizeBrowserURL("C:\\Users\\Lenovo\\Downloads\\sm5\\paper_explainer.html").href).toBe(
			"file:///C:/Users/Lenovo/Downloads/sm5/paper_explainer.html",
		);
		expect(normalizeBrowserURL("C:/Users/Lenovo/My File.html").href).toBe("file:///C:/Users/Lenovo/My%20File.html");
		expect(normalizeBrowserURL("/tmp/preview/index.html").href).toBe("file:///tmp/preview/index.html");
	});

	it("rejects privileged or unsupported schemes", () => {
		expect(() => normalizeBrowserURL("app://renderer/index.html")).toThrow(/unsupported/i);
		expect(() => normalizeBrowserURL("javascript:alert(1)")).toThrow(/unsupported/i);
	});
});

describe("isAllowedBrowserURL", () => {
	it("allows file:// even when a renderer origin is set", () => {
		expect(isAllowedBrowserURL("file:///tmp/preview/index.html", "http://localhost:5173")).toBe(true);
	});

	it("still blocks the renderer's own http origin", () => {
		expect(isAllowedBrowserURL("http://localhost:5173/", "http://localhost:5173")).toBe(false);
	});
});

describe("browser:clear", () => {
	it("loads about:blank and reports it as an empty url (cleared state)", async () => {
		const { invoke, webContents } = setupHost();
		await invoke("browser:ensure", "sess-1");
		await invoke("browser:navigate", { viewId: "1:sess-1", url: "http://localhost:3000/" });

		const state = await invoke("browser:clear", "1:sess-1");

		expect(webContents.loadURL).toHaveBeenLastCalledWith("about:blank");
		expect(state.url).toBe("");
	});
});

// M14 (#293): the navigate/clear handlers let normalization, scheme validation and
// loadURL rejections escape across IPC. The renderer's fire-and-forget call then
// raised an unhandled rejection and the panel never learned anything failed. The
// host now converts every navigation failure into a pushed nav state carrying the
// error.
describe("browser:navigate failures", () => {
	it("reports an unsupported scheme as nav-state error instead of rejecting", async () => {
		const { invoke, sent } = setupHost();
		await invoke("browser:ensure", "sess-1");

		const state = await invoke("browser:navigate", { viewId: "1:sess-1", url: "javascript:alert(1)" });

		expect(state.error).toMatch(/Unsupported browser URL scheme/i);
		expect(sent).toContainEqual({
			channel: "browser:navState",
			payload: expect.objectContaining({ viewId: "1:sess-1", error: expect.stringMatching(/Unsupported/i) }),
		});
	});

	it("reports a failed loadURL as nav-state error", async () => {
		const { invoke, webContents } = setupHost();
		await invoke("browser:ensure", "sess-1");
		webContents.loadURL.mockRejectedValueOnce(new Error("net::ERR_CONNECTION_REFUSED"));

		const state = await invoke("browser:navigate", { viewId: "1:sess-1", url: "http://localhost:9/" });

		expect(state.error).toMatch(/ERR_CONNECTION_REFUSED/);
	});

	it("treats an aborted load as a non-error (redirects and user stops abort loadURL)", async () => {
		const { invoke, webContents } = setupHost();
		await invoke("browser:ensure", "sess-1");
		webContents.loadURL.mockRejectedValueOnce(new Error("net::ERR_ABORTED (-3) loading 'http://localhost:3000/'"));

		const state = await invoke("browser:navigate", { viewId: "1:sess-1", url: "http://localhost:3000/" });

		expect(state.error).toBeUndefined();
	});

	// M14 follow-up (#293): loadURL's rejection path suppressed ERR_ABORTED, but the
	// did-fail-load EVENT path published it. Chromium fires did-fail-load with -3 /
	// ERR_ABORTED for stopped, redirected and superseded navigations — typing a
	// second URL while the first loads then painted a visible "ERR_ABORTED" error.
	it("ignores an aborted did-fail-load (superseded navigation) instead of painting it as an error", async () => {
		const { emitContents, invoke, sent } = setupHost();
		await invoke("browser:ensure", "sess-1");
		await invoke("browser:navigate", { viewId: "1:sess-1", url: "http://localhost:3000/" });

		emitContents("did-fail-load", {}, -3, "ERR_ABORTED", "http://localhost:3000/", true);

		const states = sent.filter((message) => message.channel === "browser:navState");
		expect((states.at(-1)?.payload as BrowserNavState).error).toBeUndefined();
	});

	it("still reports a genuine did-fail-load as a nav-state error", async () => {
		const { emitContents, invoke, sent } = setupHost();
		await invoke("browser:ensure", "sess-1");

		emitContents("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "http://nope.invalid/", true);

		const states = sent.filter((message) => message.channel === "browser:navState");
		expect(states.at(-1)?.payload).toEqual(
			expect.objectContaining({ error: expect.stringMatching(/ERR_NAME_NOT_RESOLVED/) }),
		);
	});

	// M14 claims every navigation promise is observed; shell.openExternal was
	// fire-and-forget and rejects (unhandled) when the OS has no handler for the URL.
	it("surfaces a failed external open instead of rejecting unhandled", async () => {
		const openExternal = vi.fn(async () => {
			throw new Error("No application is registered for this URL");
		});
		const { invoke, openWindow, sent } = setupHost({ openExternal });
		await invoke("browser:ensure", "sess-1");

		openWindow("https://example.com/popup");
		await vi.waitFor(() => {
			const states = sent.filter((message) => message.channel === "browser:navState");
			expect(states.at(-1)?.payload).toEqual(
				expect.objectContaining({ error: expect.stringMatching(/No application is registered/) }),
			);
		});
		expect(openExternal).toHaveBeenCalledWith("https://example.com/popup");
	});

	it("reports a failed clear as nav-state error instead of rejecting", async () => {
		const { invoke, webContents } = setupHost();
		await invoke("browser:ensure", "sess-1");
		webContents.loadURL.mockRejectedValueOnce(new Error("Object has been destroyed"));

		const state = await invoke("browser:clear", "1:sess-1");

		expect(state.error).toMatch(/Object has been destroyed/);
	});

	it("reports a throwing back/forward/reload/stop control as nav-state error", async () => {
		const { invoke, webContents } = setupHost();
		await invoke("browser:ensure", "sess-1");
		webContents.reload = () => {
			throw new Error("Object has been destroyed");
		};

		const state = await invoke("browser:reload", "1:sess-1");

		expect(state.error).toMatch(/Object has been destroyed/);
	});
});

describe("browser:setBounds", () => {
	it("converts page-zoomed renderer slot bounds before positioning the native view", async () => {
		const { emit, invoke, view } = setupHost();
		await invoke("browser:ensure", "sess-1");

		emit("browser:setBounds", 1.25, {
			viewId: "1:sess-1",
			rect: { x: 100, y: 20, width: 320, height: 240 },
			visible: true,
		});

		expect(view.setBounds).toHaveBeenLastCalledWith({ x: 125, y: 25, width: 400, height: 300 });
		expect(view.setVisible).toHaveBeenLastCalledWith(true);
	});
});

describe("browser annotation IPC", () => {
	it("routes renderer mode changes to the matching preview webContents", async () => {
		const { invoke, webContents } = setupHost();
		await invoke("browser:ensure", "sess-1");

		await invoke("browser:annotation:setMode", { viewId: "1:sess-1", enabled: true });

		expect(webContents.send).toHaveBeenCalledWith("browser:annotation:setMode", { enabled: true });
	});

	it("ignores annotation mode changes for views owned by a different renderer", async () => {
		const { invoke, webContents } = setupHost();
		await invoke("browser:ensure", "sess-1");

		await invoke("browser:annotation:setMode", { viewId: "2:sess-1", enabled: true });

		expect(webContents.send).not.toHaveBeenCalledWith("browser:annotation:setMode", { enabled: true });
	});

	it("forwards preview annotation submissions to the renderer-owned view", async () => {
		const { invoke, send, sent } = setupHost();
		await invoke("browser:ensure", "sess-1");

		send("browser:annotation:submit", 99, {
			instruction: "Make this button blue.",
			context: {
				url: "http://localhost:5173/",
				tag: "button",
				classes: [],
				selector: "button",
				rect: { x: 0, y: 0, width: 80, height: 30 },
				computedStyle: {},
			},
		});

		expect(sent).toContainEqual({
			channel: "browser:annotation:submitted",
			payload: expect.objectContaining({
				viewId: "1:sess-1",
				instruction: "Make this button blue.",
				context: expect.objectContaining({ selector: "button" }),
			}),
		});
	});

	it("ignores preview annotation events after the view is destroyed", async () => {
		const { host, invoke, send, sent } = setupHost();
		await invoke("browser:ensure", "sess-1");

		host.destroy("1:sess-1");
		send("browser:annotation:cancel", 99, { reason: "escape" });

		expect(sent.some((entry) => entry.channel === "browser:annotation:canceled")).toBe(false);
	});
});

// M12 (#293): every visited session used to leave a hidden WebContentsView behind
// forever — each one a live page with its own memory, timers, sockets and network
// activity. A long-running dashboard walking N sessions accumulated N pages. The
// host now bounds the map and evicts least-recently-used views.
function setupBoundedHost(maxViews: number) {
	const handlers = new Map<string, InvokeHandler>();
	const views: Array<{ id: number; closed: boolean; removed: boolean }> = [];
	let nextWebContentsId = 100;
	const removeChildView = vi.fn((view: { webContents: { id: number } }) => {
		views.find((entry) => entry.id === view.webContents.id)!.removed = true;
	});
	const host = createBrowserViewHost({
		mainWindow: {
			contentView: { addChildView: () => undefined, removeChildView },
			getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
			webContents: { id: 1, send: () => undefined },
		} as never,
		ipcMain: {
			handle: (channel: string, fn: InvokeHandler) => handlers.set(channel, fn),
			on: (channel: string, fn: InvokeHandler) => handlers.set(channel, fn),
			removeHandler: () => undefined,
			off: () => undefined,
		} as never,
		shell: { openExternal: async () => undefined },
		WebContentsView: function () {
			const id = nextWebContentsId++;
			const record = { id, closed: false, removed: false };
			views.push(record);
			return {
				webContents: {
					id,
					canGoBack: () => false,
					canGoForward: () => false,
					clearHistory: () => undefined,
					getTitle: () => "",
					getURL: () => "",
					goBack: () => undefined,
					goForward: () => undefined,
					isLoading: () => false,
					loadURL: async () => undefined,
					on: () => undefined,
					reload: () => undefined,
					send: () => undefined,
					setWindowOpenHandler: () => undefined,
					stop: () => undefined,
					close: () => {
						record.closed = true;
					},
				},
				setBounds: () => undefined,
				setVisible: () => undefined,
			};
		} as never,
		annotatePreloadPath: "/preload.js",
		rendererOrigin: "http://localhost:5173",
		maxViews,
	});
	const invoke = (channel: string, ...args: unknown[]) =>
		handlers.get(channel)!({ sender: { id: 1 } }, ...args) as Promise<BrowserNavState>;
	return { host, invoke, views };
}

describe("browser view lifetime", () => {
	it("evicts the least-recently-used view once the cap is exceeded", async () => {
		const { invoke, views } = setupBoundedHost(2);

		await invoke("browser:ensure", "sess-1");
		await invoke("browser:ensure", "sess-2");
		expect(views.map((view) => view.closed)).toEqual([false, false]);

		// A third session must not simply pile up: the oldest hidden page is destroyed.
		await invoke("browser:ensure", "sess-3");
		expect(views).toHaveLength(3);
		expect(views[0].closed).toBe(true);
		expect(views[0].removed).toBe(true);
		expect(views[1].closed).toBe(false);
		expect(views[2].closed).toBe(false);
	});

	it("keeps a re-visited view alive by refreshing its recency", async () => {
		const { invoke, views } = setupBoundedHost(2);

		await invoke("browser:ensure", "sess-1");
		await invoke("browser:ensure", "sess-2");
		// Re-visiting sess-1 makes sess-2 the least recently used.
		await invoke("browser:ensure", "sess-1");
		await invoke("browser:ensure", "sess-3");

		expect(views[0].closed).toBe(false); // sess-1: recently used
		expect(views[1].closed).toBe(true); // sess-2: evicted
		expect(views[2].closed).toBe(false); // sess-3: new
	});

	it("bounds the map even without an explicit cap", async () => {
		const { invoke, views } = setupBoundedHost(DEFAULT_MAX_BROWSER_VIEWS);
		for (let i = 0; i < DEFAULT_MAX_BROWSER_VIEWS + 3; i += 1) {
			await invoke("browser:ensure", `sess-${i}`);
		}
		expect(views.filter((view) => !view.closed)).toHaveLength(DEFAULT_MAX_BROWSER_VIEWS);
	});
});

describe("dispose after the window is destroyed", () => {
	it("does not touch contentView/views once the window reports destroyed", async () => {
		const handlers = new Map<string, InvokeHandler>();
		const view = {
			webContents: {
				canGoBack: () => false,
				canGoForward: () => false,
				clearHistory: () => undefined,
				getTitle: () => "",
				getURL: () => "",
				goBack: () => undefined,
				goForward: () => undefined,
				isLoading: () => false,
				loadURL: async () => undefined,
				on: () => undefined,
				reload: () => undefined,
				send: () => undefined,
				setWindowOpenHandler: () => undefined,
				stop: () => undefined,
				// Real Electron throws "Object has been destroyed" here after close.
				close: vi.fn(() => {
					throw new Error("Object has been destroyed");
				}),
			},
			setBounds: () => undefined,
			setVisible: () => undefined,
		};
		let destroyed = false;
		const removeChildView = vi.fn(() => {
			throw new Error("Object has been destroyed");
		});
		const host = createBrowserViewHost({
			mainWindow: {
				contentView: { addChildView: () => undefined, removeChildView },
				getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
				webContents: { id: 1, send: () => undefined },
				isDestroyed: () => destroyed,
			} as never,
			ipcMain: {
				handle: (channel: string, fn: InvokeHandler) => handlers.set(channel, fn),
				on: () => undefined,
				removeHandler: () => undefined,
				off: () => undefined,
			} as never,
			shell: { openExternal: async () => undefined },
			WebContentsView: function () {
				return view;
			} as never,
			annotatePreloadPath: "/preload.js",
			rendererOrigin: "http://localhost:5173",
		});
		await (handlers.get("browser:ensure")!({ sender: { id: 1 } }, "sess-1") as Promise<unknown>);

		destroyed = true; // window "closed" fired

		expect(() => host.dispose()).not.toThrow();
		expect(removeChildView).not.toHaveBeenCalled();
		expect(view.webContents.close).not.toHaveBeenCalled();
	});
});

describe("clampBoundsToWindow", () => {
	it("rounds and clamps bounds to the window content area", () => {
		expect(
			clampBoundsToWindow({ x: -10.4, y: 20.6, width: 900.2, height: 700.8 }, { width: 800, height: 600 }),
		).toEqual({ x: 0, y: 21, width: 800, height: 579 });
	});

	it("returns a zero-sized rectangle when the slot is outside the window", () => {
		expect(clampBoundsToWindow({ x: 900, y: 10, width: 100, height: 100 }, { width: 800, height: 600 })).toEqual({
			x: 800,
			y: 10,
			width: 0,
			height: 100,
		});
	});
});

describe("scaleBoundsForZoom", () => {
	it("converts renderer CSS-pixel bounds into Electron view bounds", () => {
		expect(scaleBoundsForZoom({ x: 100, y: 20, width: 320, height: 240 }, 1.25)).toEqual({
			x: 125,
			y: 25,
			width: 400,
			height: 300,
		});
	});

	it("ignores invalid zoom factors", () => {
		const rect = { x: 100, y: 20, width: 320, height: 240 };

		expect(scaleBoundsForZoom(rect, 1)).toBe(rect);
		expect(scaleBoundsForZoom(rect, 0)).toBe(rect);
		expect(scaleBoundsForZoom(rect, Number.NaN)).toBe(rect);
	});
});
