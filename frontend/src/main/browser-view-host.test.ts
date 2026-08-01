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

function setupHost(agentBrowserRuntime?: import("./agent-browser-runtime").AgentBrowserRuntime) {
	let currentURL = "";
	let displayHandler: DisplayHandler | null = null;
	const webContentsListeners = new Map<string, (...args: never[]) => void>();
	const debuggerListeners = new Map<string, (...args: never[]) => void>();
	let debuggerAttached = false;
	const debuggerSendCommand = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
		if (method === "Page.navigate" && typeof params?.url === "string") currentURL = params.url;
		return {};
	});
	const setPermissionCheckHandler = vi.fn();
	const setPermissionRequestHandler = vi.fn();
	const webContents = {
		id: 99,
		mainFrame: { frameToken: "preview-frame" },
		canGoBack: () => false,
		canGoForward: () => false,
		capturePage: vi.fn(async () => ({
			isEmpty: () => false,
			toJPEG: () => Buffer.from("snapshot"),
			toPNG: () => Buffer.from("png-snapshot"),
			getSize: () => ({ width: 640, height: 480 }),
		})),
		debugger: {
			attach: vi.fn(() => {
				debuggerAttached = true;
			}),
			detach: vi.fn(() => {
				debuggerAttached = false;
			}),
			isAttached: () => debuggerAttached,
			on: (event: string, listener: (...args: never[]) => void) => debuggerListeners.set(event, listener),
			sendCommand: debuggerSendCommand,
		},
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
		close: vi.fn(),
		session: {
			setPermissionCheckHandler,
			setPermissionRequestHandler,
		},
	};
	const view = {
		webContents,
		setBounds: vi.fn(),
		setVisible: vi.fn(),
	};
	const runtime =
		agentBrowserRuntime ??
		({
			runAction: vi.fn(async (_sessionId, action, args, provider) => {
				if (action === "open") {
					await provider.listTargets()[0]?.debugger.sendCommand("Page.navigate", { url: args.url });
					return {};
				}
				if (action === "snapshot") return { snapshot: "(empty accessibility snapshot)", refs: {} };
				if (action === "tab-new") {
					await provider.createTarget(typeof args.url === "string" ? args.url : "about:blank");
					return {};
				}
				if (action === "tab-select") {
					await provider.activateTarget(String(args.tabId));
					return {};
				}
				if (action === "tab-close") {
					await provider.closeTarget(String(args.tabId));
					return {};
				}
				if (action === "get") return { value: currentURL };
				if (action === "console" || action === "errors") return { messages: [] };
				return {};
			}),
			screenshot: vi.fn(async () => ({
				data: Buffer.from("png-snapshot").toString("base64"),
				width: 640,
				height: 480,
				untrustedExternalContent: true as const,
			})),
			closeSession: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		} as unknown as import("./agent-browser-runtime").AgentBrowserRuntime);
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
		agentBrowserRuntime: runtime,
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
		setPermissionCheckHandler,
		setPermissionRequestHandler,
		shellFocus,
		shellSend,
		view,
		webContents,
		webContentsListeners,
		debuggerListeners,
		debuggerSendCommand,
	};
}

function setupTabHost() {
	const constructorOptions: Array<{ webPreferences: { partition?: string } }> = [];
	const handlers = new Map<string, InvokeHandler>();
	const sent: Array<{ channel: string; payload: unknown }> = [];
	const views: Array<{
		webContents: {
			id: number;
			getURL: () => string;
			loadURL: ReturnType<typeof vi.fn>;
			openWindow: (url: string) => void;
			close: ReturnType<typeof vi.fn>;
		};
		setBounds: ReturnType<typeof vi.fn>;
		setVisible: ReturnType<typeof vi.fn>;
	}> = [];
	let nextID = 100;
	const makeView = () => {
		let currentURL = "";
		let windowOpenHandler:
			| ((details: { url: string }) => {
					action: string;
					createWindow?: () => { loadURL: (url: string) => Promise<void> };
			  })
			| undefined;
		const listeners = new Map<string, (...args: never[]) => void>();
		let debuggerAttached = false;
		const webContents = {
			id: nextID++,
			mainFrame: {},
			canGoBack: () => false,
			canGoForward: () => false,
			capturePage: vi.fn(async () => ({
				isEmpty: () => false,
				toJPEG: () => Buffer.from("snapshot"),
				toPNG: () => Buffer.from("snapshot"),
				getSize: () => ({ width: 640, height: 480 }),
			})),
			clearHistory: () => undefined,
			debugger: {
				attach: () => {
					debuggerAttached = true;
				},
				detach: () => {
					debuggerAttached = false;
				},
				isAttached: () => debuggerAttached,
				on: () => undefined,
				sendCommand: async (method: string, params?: Record<string, unknown>) => {
					if (method === "Page.navigate" && typeof params?.url === "string") currentURL = params.url;
					return {};
				},
			},
			getTitle: () => (currentURL ? `Title ${currentURL}` : ""),
			getURL: () => currentURL,
			goBack: () => undefined,
			goForward: () => undefined,
			isLoading: () => false,
			loadURL: vi.fn(async (url: string) => {
				currentURL = url;
			}),
			on: (event: string, listener: (...args: never[]) => void) => listeners.set(event, listener),
			reload: () => undefined,
			send: () => undefined,
			setWindowOpenHandler: (
				handler: (details: { url: string }) => {
					action: string;
					createWindow?: () => { loadURL: (url: string) => Promise<void> };
				},
			) => {
				windowOpenHandler = handler;
			},
			stop: () => undefined,
			close: vi.fn(),
			openWindow: (url: string) => {
				const result = windowOpenHandler?.({ url });
				if (result?.action === "allow") {
					void result.createWindow?.().loadURL(url);
				}
			},
		};
		const view = { webContents, setBounds: vi.fn(), setVisible: vi.fn() };
		views.push(view);
		return view;
	};
	const activeTargets = new Map<string, string>();
	const runtime = {
		runAction: vi.fn(async (sessionId, action, args, provider) => {
			const targets = () => provider.listTargets();
			const active = () =>
				targets().find((target: { id: string }) => target.id === activeTargets.get(sessionId)) ?? targets()[0];
			if (action === "open") {
				await active()?.debugger.sendCommand("Page.navigate", { url: args.url });
				return {};
			}
			if (action === "snapshot") return { snapshot: '- button "Open" [ref=e1]', refs: {} };
			if (action === "tab-new") {
				const created = await provider.createTarget(typeof args.url === "string" ? args.url : "about:blank");
				activeTargets.set(sessionId, created.id);
				return {};
			}
			if (action === "tab-select") {
				await provider.activateTarget(String(args.tabId));
				activeTargets.set(sessionId, String(args.tabId));
				return {};
			}
			if (action === "tab-close") {
				await provider.closeTarget(String(args.tabId));
				activeTargets.set(sessionId, targets().at(-1)?.id ?? "");
				return {};
			}
			if (action === "get") return { value: active()?.url ?? "" };
			return {};
		}),
		screenshot: vi.fn(async () => ({ data: "", width: 0, height: 0, untrustedExternalContent: true as const })),
		closeSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => undefined),
	} as unknown as import("./agent-browser-runtime").AgentBrowserRuntime;
	const host = createBrowserViewHost({
		mainWindow: {
			contentView: { addChildView: () => undefined, removeChildView: () => undefined },
			getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
			webContents: {
				id: 1,
				focus: () => undefined,
				send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
			},
		} as never,
		ipcMain: {
			handle: (channel: string, fn: InvokeHandler) => handlers.set(channel, fn),
			on: () => undefined,
			removeHandler: () => undefined,
			off: () => undefined,
		} as never,
		shell: { openExternal: async () => undefined },
		WebContentsView: function (options: { webPreferences: { partition?: string } }) {
			constructorOptions.push(options);
			return makeView();
		} as never,
		annotatePreloadPath: "/preload.js",
		rendererOrigin: "http://localhost:5173",
		agentBrowserRuntime: runtime,
	});
	const invoke = (channel: string, ...args: unknown[]) =>
		handlers.get(channel)!({ sender: { id: 1 } }, ...args) as Promise<unknown>;
	return { constructorOptions, host, invoke, sent, views };
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
		expect(normalizeBrowserURL("example.com/path?q=1").href).toBe("https://example.com/path?q=1");
		expect(normalizeBrowserURL("192.168.1.5:8080").href).toBe("https://192.168.1.5:8080/");
	});

	it("routes non-URL input to a web search", () => {
		expect(normalizeBrowserURL("hi").href).toBe("https://www.google.com/search?q=hi");
		expect(normalizeBrowserURL("how do i center a div").href).toBe(
			"https://www.google.com/search?q=how%20do%20i%20center%20a%20div",
		);
		// A dot-less token with a trailing colon is text, not a scheme, once it
		// carries whitespace, so it still searches rather than throwing on new URL().
		expect(normalizeBrowserURL("time: now").href).toBe("https://www.google.com/search?q=time%3A%20now");
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

describe("agent browser runtime", () => {
	it("routes the native adapter through only the current session targets", async () => {
		const runAction = vi.fn(async (_sessionId, _action, _args, provider) => ({
			snapshot: provider.listTargets().map((target: { id: string }) => target.id).join(","),
		}));
		const runtime = {
			runAction,
			closeSession: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		} as unknown as import("./agent-browser-runtime").AgentBrowserRuntime;
		const { host } = setupHost(runtime);

		const result = await host.execute("sess-1", "snapshot", { interactive: true });

		expect(runAction).toHaveBeenCalledWith(
			"sess-1",
			"snapshot",
			{ interactive: true },
			expect.objectContaining({ listTargets: expect.any(Function) }),
			undefined,
		);
		expect(result).toMatchObject({ text: "t1" });
	});

	it("denies browser-partition permissions by default", async () => {
		const { host, setPermissionCheckHandler, setPermissionRequestHandler } = setupHost();
		await host.execute("sess-1", "tabs");

		expect(setPermissionCheckHandler).toHaveBeenCalledWith(expect.any(Function));
		expect(setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
		const callback = vi.fn();
		setPermissionRequestHandler.mock.calls[0][0]({}, "camera", callback);
		expect(callback).toHaveBeenCalledWith(false);
	});

	it("rejects local files and implicit searches from agent-originated navigation", async () => {
		const { host, webContents } = setupHost();

		await expect(host.execute("sess-1", "open", { url: "file:///tmp/secret" })).rejects.toMatchObject({
			code: "BROWSER_URL_FORBIDDEN",
		});
		await expect(host.execute("sess-1", "open", { url: "search these words" })).rejects.toMatchObject({
			code: "INVALID_URL",
		});
		expect(webContents.loadURL).not.toHaveBeenCalled();
	});

	it("destroys a headless session target through the daemon lifecycle command", async () => {
		const { host, webContents } = setupHost();
		await host.execute("sess-1", "tabs");

		await expect(host.execute("sess-1", "__destroy-session")).resolves.toEqual({ destroyed: true });
		expect(webContents.close).toHaveBeenCalledTimes(1);
		await expect(host.execute("sess-1", "__destroy-session")).resolves.toEqual({ destroyed: false });
	});

	it("caps session tabs", async () => {
		const { host } = setupHost();
		await host.execute("sess-1", "tabs");
		for (let i = 1; i < 16; i += 1) {
			await host.execute("sess-1", "tab-new");
		}
		await expect(host.execute("sess-1", "tab-new")).rejects.toMatchObject({ code: "BROWSER_TAB_LIMIT" });
	});

	it("creates one hidden target per session and reuses it when the panel mounts", async () => {
		const { debuggerSendCommand, host, invoke } = setupHost();
		await host.execute("sess-1", "open", { url: "http://localhost:4173" });

		const state = await invoke("browser:ensure", "sess-1");

		expect(state.viewId).toBe("0:sess-1");
		expect(debuggerSendCommand).toHaveBeenCalledWith("Page.navigate", { url: "http://localhost:4173/" });
	});


	it("reports agent activity only while a browser command is executing", async () => {
		let resolveSnapshot: (value: Record<string, unknown>) => void = () => undefined;
		const runAction = vi.fn(
			() =>
				new Promise<Record<string, unknown>>((resolve) => {
					resolveSnapshot = resolve;
				}),
		);
		const runtime = {
			runAction,
			closeSession: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		} as unknown as import("./agent-browser-runtime").AgentBrowserRuntime;
		const { host, sent } = setupHost(runtime);

		const pendingSnapshot = host.execute("sess-1", "snapshot");
		await vi.waitFor(() =>
			expect(sent).toContainEqual({
				channel: "browser:agentActivity",
				payload: {
					viewId: "0:sess-1",
					active: true,
					action: "snapshot",
				},
			}),
		);
		await vi.waitFor(() => expect(runAction).toHaveBeenCalled());

		resolveSnapshot({ snapshot: "(empty accessibility snapshot)" });
		await pendingSnapshot;

		expect(
			sent
				.filter(({ channel }) => channel === "browser:agentActivity")
				.map(({ payload }) => payload),
		).toEqual([
			{ viewId: "0:sess-1", active: true, action: "snapshot" },
			{ viewId: "0:sess-1", active: false, action: "snapshot" },
		]);
	});

	it("keeps stable logical tab IDs, separate targets, and the selected tab active", async () => {
		const { host, views } = setupTabHost();
		await host.execute("sess-1", "open", { url: "http://localhost:3000" });
		await host.execute("sess-1", "snapshot");
		const created = (await host.execute("sess-1", "tab-new", {
			url: "http://localhost:4173",
		})) as { id: string };
		expect(views[0].setBounds).toHaveBeenCalledWith({
			x: -10_000,
			y: -10_000,
			width: 1280,
			height: 720,
		});

		const listed = (await host.execute("sess-1", "tabs")) as {
			activeTabId: string;
			tabs: Array<{ id: string; url: string; active: boolean }>;
		};
		expect(created.id).toBe("t2");
		expect(listed.activeTabId).toBe("t2");
		expect(listed.tabs).toEqual([
			expect.objectContaining({ id: "t1", url: "http://localhost:3000/", active: false }),
			expect.objectContaining({ id: "t2", url: "http://localhost:4173/", active: true }),
		]);
		expect(views).toHaveLength(2);

		await host.execute("sess-1", "tab-select", { tabId: "t1" });
		const current = (await host.execute("sess-1", "get", { property: "url" })) as { value: string };
		expect(current.value).toBe("http://localhost:3000/");
		expect(views[1].setVisible).toHaveBeenLastCalledWith(false);
		await expect(host.execute("sess-1", "click", { ref: "e1" })).resolves.toBeDefined();
		await host.execute("sess-1", "tab-close", { tabId: "t2" });
		const replacement = (await host.execute("sess-1", "tab-new")) as { id: string };
		expect(replacement.id).toBe("t3");
	});

	it("shares one ephemeral profile across a worker's tabs and isolates other workers", async () => {
		const { constructorOptions, host } = setupTabHost();
		await host.execute("sess-1", "tabs");
		await host.execute("sess-1", "tab-new");
		await host.execute("sess-2", "tabs");

		const firstPartition = constructorOptions[0].webPreferences.partition;
		expect(firstPartition).toMatch(/^ao-browser-/);
		expect(firstPartition).not.toMatch(/^persist:/);
		expect(constructorOptions[1].webPreferences.partition).toBe(firstPartition);
		expect(constructorOptions[2].webPreferences.partition).not.toBe(firstPartition);

		host.destroy("0:sess-1");
		await host.execute("sess-1", "tabs");
		expect(constructorOptions[3].webPreferences.partition).not.toBe(firstPartition);
	});

	it("captures allowed popups as new tabs and protects the final tab", async () => {
		const { host, views } = setupTabHost();
		await host.execute("sess-1", "open", { url: "http://localhost:3000" });

		views[0].webContents.openWindow("http://localhost:3000/popup");
		await Promise.resolve();

		const listed = (await host.execute("sess-1", "tabs")) as {
			activeTabId: string;
			tabs: Array<{ id: string; url: string }>;
		};
		expect(listed.activeTabId).toBe("t2");
		expect(listed.tabs[1]).toEqual(
			expect.objectContaining({ id: "t2", url: "http://localhost:3000/popup" }),
		);

		await host.execute("sess-1", "tab-close");
		await expect(host.execute("sess-1", "tab-close")).rejects.toMatchObject({
			code: "CANNOT_CLOSE_LAST_TAB",
		});
	});

	it("exposes owned tab state and manual tab actions to the renderer", async () => {
		const { invoke, sent, views } = setupTabHost();
		const ensured = (await invoke("browser:ensure", "sess-1")) as BrowserNavState;

		views[0].webContents.openWindow("http://localhost:3000/popup");
		await vi.waitFor(async () => {
			const state = (await invoke("browser:getTabs", ensured.viewId)) as {
				activeTabId: string;
				tabs: Array<{ id: string }>;
			};
			expect(state.tabs).toHaveLength(2);
			expect(state.activeTabId).toBe("t2");
		});
		expect(sent).toContainEqual({
			channel: "browser:tabsState",
			payload: expect.objectContaining({
				viewId: ensured.viewId,
				change: { kind: "popup", tabId: "t2" },
			}),
		});

		const selected = (await invoke("browser:selectTab", {
			viewId: ensured.viewId,
			tabId: "t1",
		})) as { activeTabId: string };
		expect(selected.activeTabId).toBe("t1");

		const closed = (await invoke("browser:closeTab", {
			viewId: ensured.viewId,
			tabId: "t2",
		})) as { tabs: Array<{ id: string }> };
		expect(closed.tabs.map((tab) => tab.id)).toEqual(["t1"]);
		expect(views[1].webContents.close).toHaveBeenCalled();
	});
});

describe("agent browser network capture", () => {
	it("is opt-in and exposes only sanitized request metadata", async () => {
		const { debuggerListeners, debuggerSendCommand, host } = setupHost();
		const emitDebuggerMessage = (method: string, params: Record<string, unknown>) =>
			debuggerListeners.get("message")?.({} as never, method as never, params as never);

		emitDebuggerMessage("Network.requestWillBeSent", {
			requestId: "before-start",
			request: { method: "GET", url: "https://example.test/unobserved" },
		});
		expect(await host.execute("sess-1", "network-list")).toMatchObject({
			active: false,
			requestCount: 0,
			requests: [],
		});

		expect(await host.execute("sess-1", "network-start", { durationSeconds: 30 })).toMatchObject({
			active: true,
			metadataOnly: true,
			tabId: "t1",
			requestCount: 0,
			maxEntries: 200,
		});
		expect(debuggerSendCommand).toHaveBeenCalledWith("Network.enable");

		emitDebuggerMessage("Network.requestWillBeSent", {
			requestId: "request-1",
			timestamp: 12,
			wallTime: 1_750_000_000,
			type: "XHR",
			request: {
				method: "POST",
				url: "https://user:password@api.example.test/items?token=secret&page=2#private",
				postData: "must-not-be-stored",
				headers: {
					Authorization: "Bearer very-secret",
					Cookie: "session=very-secret",
					"Content-Type": "application/json",
					Origin: "https://app.example.test",
				},
			},
		});
		emitDebuggerMessage("Network.responseReceived", {
			requestId: "request-1",
			response: {
				status: 401,
				statusText: "Unauthorized",
				mimeType: "application/json",
				headers: {
					"Set-Cookie": "session=server-secret",
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "https://app.example.test",
				},
			},
		});
		emitDebuggerMessage("Network.loadingFinished", { requestId: "request-1", timestamp: 12.125 });

		const result = (await host.execute("sess-1", "network-list")) as {
			requestCount: number;
			requests: Array<Record<string, unknown>>;
		};
		expect(result.requestCount).toBe(1);
		expect(result.requests[0]).toMatchObject({
			id: "n1",
			method: "POST",
			resourceType: "xhr",
			status: 401,
			durationMs: 125,
			requestHeaders: {
				"content-type": "application/json",
				origin: "https://app.example.test",
			},
			responseHeaders: {
				"content-type": "application/json",
				"access-control-allow-origin": "https://app.example.test",
			},
		});
		expect(JSON.stringify(result)).not.toContain("very-secret");
		expect(JSON.stringify(result)).not.toContain("must-not-be-stored");
		expect(JSON.stringify(result)).not.toContain("password");
		expect(result.requests[0]?.url).toContain("token=%5Bredacted%5D");
		expect(result.requests[0]).not.toHaveProperty("protocolRequestId");
		expect(result.requests[0]).not.toHaveProperty("startedMonotonic");

		expect(await host.execute("sess-1", "network-stop")).toMatchObject({
			active: false,
			stopReason: "stopped",
			requestCount: 1,
		});
		expect(debuggerSendCommand).toHaveBeenCalledWith("Network.disable");
	});

	it("retains only the newest 200 requests and validates the capture duration", async () => {
		const { debuggerListeners, host } = setupHost();
		await expect(host.execute("sess-1", "network-start", { durationSeconds: 0 })).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
		});
		await expect(host.execute("sess-1", "network-start", { durationSeconds: 301 })).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
		});

		await host.execute("sess-1", "network-start", { durationSeconds: 30 });
		const emitDebuggerMessage = debuggerListeners.get("message")!;
		for (let index = 0; index < 205; index++) {
			emitDebuggerMessage(
				{} as never,
				"Network.requestWillBeSent" as never,
				{
					requestId: `request-${index}`,
					request: {
						method: "GET",
						url: `https://api.example.test/items?index=${index}`,
					},
				} as never,
			);
		}

		const result = (await host.execute("sess-1", "network-list")) as {
			requestCount: number;
			requests: Array<{ id: string }>;
		};
		expect(result.requestCount).toBe(200);
		expect(result.requests[0]?.id).toBe("n6");
		expect(result.requests.at(-1)?.id).toBe("n205");
		await host.execute("sess-1", "network-stop");
	});

	it("expires automatically without enabling status or list checks", async () => {
		vi.useFakeTimers();
		try {
			const { debuggerSendCommand, host } = setupHost();
			expect(await host.execute("sess-1", "network-status")).toMatchObject({ active: false });
			expect(debuggerSendCommand).not.toHaveBeenCalledWith("Network.enable");

			await host.execute("sess-1", "network-start", { durationSeconds: 1 });
			await vi.advanceTimersByTimeAsync(1_000);

			expect(await host.execute("sess-1", "network-status")).toMatchObject({
				active: false,
				stopReason: "expired",
			});
			expect(debuggerSendCommand).toHaveBeenCalledWith("Network.disable");
		} finally {
			vi.useRealTimers();
		}
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
