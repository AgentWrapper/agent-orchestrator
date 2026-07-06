import { describe, expect, it, vi } from "vitest";
import {
	type BrowserNavState,
	clampBoundsToWindow,
	createBrowserViewHost,
	isAllowedBrowserURL,
	normalizeBrowserURL,
} from "./browser-view-host";

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown;

function setupHost() {
	let currentURL = "";
	const webContents = {
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
		on: () => undefined,
		reload: () => undefined,
		send: () => undefined,
		setWindowOpenHandler: () => undefined,
		stop: () => undefined,
		close: () => undefined,
	};
	const view = {
		webContents,
		setBounds: () => undefined,
		setVisible: () => undefined,
	};
	const handlers = new Map<string, InvokeHandler>();
	const sent: BrowserNavState[] = [];
	const host = createBrowserViewHost({
		mainWindow: {
			contentView: { addChildView: () => undefined, removeChildView: () => undefined },
			getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
			webContents: { id: 1, send: (_channel: string, state: BrowserNavState) => sent.push(state) },
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
	const invoke = (channel: string, ...args: unknown[]) =>
		handlers.get(channel)!({ sender: { id: 1 } }, ...args) as Promise<BrowserNavState>;
	return { host, invoke, webContents };
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
