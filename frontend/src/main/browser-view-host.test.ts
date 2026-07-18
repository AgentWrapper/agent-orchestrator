import { describe, expect, it, vi } from "vitest";
import {
	type BrowserNavState,
	clampBoundsToWindow,
	createBrowserViewHost,
	isAllowedBrowserURL,
	normalizeBrowserURL,
	scaleBoundsForZoom,
} from "./browser-view-host";
import { NEW_SESSION_SHORTCUT_CHANNEL } from "../shared/shortcuts";

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown;
type EventHandler = (event: { sender: { id: number; getZoomFactor?: () => number } }, ...args: unknown[]) => unknown;

type DisplayHandler = (request: unknown, callback: (streams: { video?: unknown }) => void) => void;

function setupHost() {
	let currentURL = "";
	let displayHandler: DisplayHandler | null = null;
	const webContentsListeners = new Map<string, (...args: never[]) => void>();
	const webContents = {
		id: 99,
		mainFrame: { frameToken: "preview-frame" },
		canGoBack: () => false,
		canGoForward: () => false,
		capturePage: vi.fn(async () => ({
			isEmpty: () => false,
			toJPEG: () => Buffer.from("snapshot"),
		})),
		clearHistory: () => undefined,
		getTitle: () => "",
		getURL: () => currentURL,
		goBack: () => undefined,
		goForward: () => undefined,
		isLoading: () => false,
		loadURL: vi.fn(async (url: string) => {
			currentURL = url;
		}),
		on: (event: string, listener: (...args: never[]) => void) => {
			webContentsListeners.set(event, listener);
		},
		reload: () => undefined,
		send: vi.fn(),
		setWindowOpenHandler: () => undefined,
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
	const shellFocus = vi.fn();
	const shellSend = vi.fn((channel: string, payload?: unknown) => sent.push({ channel, payload }));
	const host = createBrowserViewHost({
		mainWindow: {
			contentView: { addChildView: () => undefined, removeChildView: () => undefined },
			getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
			webContents: {
				id: 1,
				focus: shellFocus,
				send: shellSend,
				session: {
					setDisplayMediaRequestHandler: (handler: DisplayHandler | null) => {
						displayHandler = handler;
					},
				},
			},
		} as never,
		ipcMain: {
			handle: (channel: string, fn: InvokeHandler) => handlers.set(channel, fn),
			on: (channel: string, fn: EventHandler) => eventHandlers.set(channel, fn),
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
	const rendererFrame = { processId: 5, routingId: 7 };
	const invoke = (channel: string, ...args: unknown[]) =>
		handlers.get(channel)!({ sender: { id: 1 }, senderFrame: rendererFrame }, ...args) as Promise<BrowserNavState>;
	const emit = (channel: string, zoomFactor: number, ...args: unknown[]) =>
		eventHandlers.get(channel)!({ sender: { id: 1, getZoomFactor: () => zoomFactor } }, ...args);
	const send = (channel: string, senderId: number, ...args: unknown[]) =>
		eventHandlers.get(channel)!({ sender: { id: senderId } }, ...args);
	const emitBeforeInput = (input: {
		key: string;
		control?: boolean;
		meta?: boolean;
		shift?: boolean;
		alt?: boolean;
		type?: string;
		isAutoRepeat?: boolean;
	}) => {
		const event = { preventDefault: vi.fn() };
		webContentsListeners.get("before-input-event")?.(
			event as never,
			{
				control: false,
				meta: false,
				shift: false,
				alt: false,
				type: "keyDown",
				...input,
			} as never,
		);
		return event;
	};
	return {
		emit,
		emitBeforeInput,
		getDisplayHandler: () => displayHandler,
		host,
		invoke,
		rendererFrame,
		send,
		sent,
		shellFocus,
		shellSend,
		view,
		webContents,
	};
}

describe("new-session shortcut forwarding", () => {
	it("focuses the shell before forwarding a matching preview chord", async () => {
		const { emitBeforeInput, invoke, shellFocus, shellSend } = setupHost();
		await invoke("browser:ensure", "sess-1");
		shellFocus.mockClear();
		shellSend.mockClear();

		const event = emitBeforeInput({ key: "N", control: true, shift: true });

		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(shellFocus).toHaveBeenCalledTimes(1);
		expect(shellSend).toHaveBeenCalledWith(NEW_SESSION_SHORTCUT_CHANNEL);
		expect(shellFocus.mock.invocationCallOrder[0]).toBeLessThan(shellSend.mock.invocationCallOrder[0]);
	});

	it("does not focus or forward auto-repeat and non-matching preview input", async () => {
		const { emitBeforeInput, invoke, shellFocus, shellSend } = setupHost();
		await invoke("browser:ensure", "sess-1");
		shellFocus.mockClear();
		shellSend.mockClear();

		emitBeforeInput({ key: "N", control: true, shift: true, isAutoRepeat: true });
		emitBeforeInput({ key: "N", control: true });

		expect(shellFocus).not.toHaveBeenCalled();
		expect(shellSend).not.toHaveBeenCalledWith(NEW_SESSION_SHORTCUT_CHANNEL);
	});
});

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

describe("browser:capture", () => {
	it("returns the current page as a data URL", async () => {
		const { invoke } = setupHost();
		await invoke("browser:ensure", "sess-1");

		const snapshot = await invoke("browser:capture", "1:sess-1");

		expect(snapshot).toBe(`data:image/jpeg;base64,${Buffer.from("snapshot").toString("base64")}`);
	});

	it("returns an empty string for an unknown view", async () => {
		const { invoke } = setupHost();

		const snapshot = await invoke("browser:capture", "1:missing");

		expect(snapshot).toBe("");
	});
});

describe("browser:requestMirror", () => {
	it("grants the display-media request from the frame that armed the mirror", async () => {
		const { getDisplayHandler, invoke, rendererFrame, webContents } = setupHost();
		await invoke("browser:ensure", "sess-1");

		const granted = await invoke("browser:requestMirror", "1:sess-1");
		expect(granted).toBe(true);

		const streams: Array<{ video?: unknown }> = [];
		getDisplayHandler()!({ frame: rendererFrame }, (result) => streams.push(result));
		expect(streams).toEqual([{ video: webContents.mainFrame }]);
	});

	it("denies display-media requests from a different frame", async () => {
		const { getDisplayHandler, invoke } = setupHost();
		await invoke("browser:ensure", "sess-1");
		await invoke("browser:requestMirror", "1:sess-1");

		const streams: Array<{ video?: unknown }> = [];
		getDisplayHandler()!({ frame: { processId: 9, routingId: 3 } }, (result) => streams.push(result));
		expect(streams).toEqual([{}]);
	});

	it("denies display-media requests with no pending mirror", async () => {
		const { getDisplayHandler, invoke, rendererFrame } = setupHost();
		await invoke("browser:ensure", "sess-1");

		const streams: Array<{ video?: unknown }> = [];
		getDisplayHandler()!({ frame: rendererFrame }, (result) => streams.push(result));
		expect(streams).toEqual([{}]);
	});

	it("rejects mirror requests for views the renderer does not own", async () => {
		const { invoke } = setupHost();
		await invoke("browser:ensure", "sess-1");

		const granted = await invoke("browser:requestMirror", "7:sess-1");
		expect(granted).toBe(false);
	});

	it("expires a mirror grant that is never consumed", async () => {
		vi.useFakeTimers();
		try {
			const { getDisplayHandler, invoke, rendererFrame } = setupHost();
			await invoke("browser:ensure", "sess-1");
			await invoke("browser:requestMirror", "1:sess-1");

			vi.advanceTimersByTime(6000);

			const streams: Array<{ video?: unknown }> = [];
			getDisplayHandler()!({ frame: rendererFrame }, (result) => streams.push(result));
			expect(streams).toEqual([{}]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("denies capture of views the renderer does not own", async () => {
		const { invoke } = setupHost();
		await invoke("browser:ensure", "sess-1");

		const snapshot = await invoke("browser:capture", "7:sess-1");
		expect(snapshot).toBe("");
	});
});

describe("browser:setBounds parked", () => {
	it("moves the view offscreen at full size while keeping it visible", async () => {
		const { emit, invoke, view } = setupHost();
		await invoke("browser:ensure", "sess-1");

		emit("browser:setBounds", 1, {
			viewId: "1:sess-1",
			rect: { x: 12, y: 34, width: 320, height: 240 },
			visible: true,
			parked: true,
		});

		expect(view.setBounds).toHaveBeenLastCalledWith({ x: -10_000, y: 0, width: 320, height: 240 });
		expect(view.setVisible).toHaveBeenLastCalledWith(true);
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

describe("getLastFocusedPanelContents", () => {
	// Mock that captures each panel's "focus" listener so the test can fire it.
	function setup() {
		let focusListener: (() => void) | undefined;
		const webContents = {
			canGoBack: () => false,
			canGoForward: () => false,
			clearHistory: () => undefined,
			getTitle: () => "",
			getURL: () => "",
			goBack: () => undefined,
			goForward: () => undefined,
			isLoading: () => false,
			loadURL: async () => undefined,
			reload: () => undefined,
			send: () => undefined,
			setWindowOpenHandler: () => undefined,
			stop: () => undefined,
			close: () => undefined,
			isDestroyed: () => false,
			on: (event: string, listener: () => void) => {
				if (event === "focus") focusListener = listener;
			},
		};
		const view = { webContents, setBounds: () => undefined, setVisible: () => undefined };
		const handlers = new Map<string, InvokeHandler>();
		const record = (channel: string, fn: InvokeHandler) => handlers.set(channel, fn);
		const host = createBrowserViewHost({
			mainWindow: {
				contentView: { addChildView: () => undefined, removeChildView: () => undefined },
				getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
				webContents: { id: 1, send: () => undefined },
			} as never,
			ipcMain: { handle: record, on: record, removeHandler: () => undefined, off: () => undefined } as never,
			shell: { openExternal: async () => undefined },
			WebContentsView: function () {
				return view;
			} as never,
			annotatePreloadPath: "/preload.js",
			rendererOrigin: "http://localhost:5173",
		});
		const call = (channel: string, ...args: unknown[]) =>
			handlers.get(channel)!({ sender: { id: 1, getZoomFactor: () => 1 } }, ...args);
		return { host, call, webContents, focus: () => focusListener?.() };
	}

	it("is null until a panel is focused", async () => {
		const { host, call } = setup();
		await call("browser:ensure", "s");
		expect(host.getLastFocusedPanelContents()).toBeNull();
	});

	it("tracks the focused panel, then clears on hide and destroy", async () => {
		const { host, call, webContents, focus } = setup();
		await call("browser:ensure", "s");

		focus();
		expect(host.getLastFocusedPanelContents()).toBe(webContents);

		call("browser:setBounds", { viewId: "1:s", rect: { x: 0, y: 0, width: 10, height: 10 }, visible: false });
		expect(host.getLastFocusedPanelContents()).toBeNull();

		focus();
		expect(host.getLastFocusedPanelContents()).toBe(webContents);

		call("browser:destroy", "1:s");
		expect(host.getLastFocusedPanelContents()).toBeNull();
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
