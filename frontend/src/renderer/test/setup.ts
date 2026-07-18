import "@testing-library/jest-dom/vitest";

// Guard: src/main/** tests run in the Node.js environment (no DOM). vitest still
// routes setupFiles here, so only install the DOM stubs when a DOM exists.
// ponytail: single guard; node env has no DOM to stub.
if (typeof window !== "undefined") {
	class ResizeObserverStub {
		observe() {}
		unobserve() {}
		disconnect() {}
	}

	Object.defineProperty(window, "ResizeObserver", {
		configurable: true,
		writable: true,
		value: ResizeObserverStub,
	});

	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			addListener: () => undefined,
			removeListener: () => undefined,
			dispatchEvent: () => false,
		}),
	});

	const localStorageStub = (() => {
		const values = new Map<string, string>();
		return {
			clear: () => values.clear(),
			getItem: (key: string) => values.get(key) ?? null,
			removeItem: (key: string) => values.delete(key),
			setItem: (key: string, value: string) => values.set(key, value),
		};
	})();

	Object.defineProperty(window, "localStorage", {
		configurable: true,
		writable: true,
		value: localStorageStub,
	});

	HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as typeof HTMLCanvasElement.prototype.getContext;

	Element.prototype.hasPointerCapture = (() => false) as typeof Element.prototype.hasPointerCapture;
	Element.prototype.setPointerCapture = (() => undefined) as typeof Element.prototype.setPointerCapture;
	Element.prototype.releasePointerCapture = (() => undefined) as typeof Element.prototype.releasePointerCapture;
	Element.prototype.scrollIntoView = (() => undefined) as typeof Element.prototype.scrollIntoView;

	window.ao = {
		app: {
			getVersion: async () => "0.0.0-test",
			chooseDirectory: async () => null,
			openExternal: async () => undefined,
			scanImportFolder: async ({ path }: { path: string }) => ({ path, repos: [] }),
			onNewSessionShortcut: () => () => undefined,
		},
		terminal: {
			saveDroppedFile: async () => "",
		},
		window: {
			setOverlay: async () => undefined,
		},
		menu: {
			action: async () => undefined,
			notifyShellFocus: () => undefined,
		},
		clipboard: {
			writeText: async () => undefined,
			readText: async () => "",
		},
		daemon: {
			getStatus: async () => ({ state: "stopped" }),
			start: async () => ({ state: "starting" }),
			stop: async () => ({ state: "stopped" }),
			onStatus: () => () => undefined,
		},
		telemetry: {
			getBootstrap: async () => null,
		},
		browser: {
			ensure: async (sessionId: string) => ({
				viewId: `test:${sessionId}`,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			setBounds: () => undefined,
			capture: async () => "",
			requestMirror: async () => false,
			navigate: async ({ viewId }: { viewId: string }) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			clear: async (viewId: string) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			goBack: async (viewId: string) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			goForward: async (viewId: string) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			reload: async (viewId: string) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			stop: async (viewId: string) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			destroy: () => undefined,
			setAnnotationMode: async () => undefined,
			onNavState: () => () => undefined,
			onAnnotationSubmit: () => () => undefined,
			onAnnotationCancel: () => () => undefined,
		},
		notifications: {
			show: async () => undefined,
			onClick: () => () => undefined,
		},
		appState: {
			getMigration: async () => ({ status: "pending" }),
			setMigration: async () => undefined,
		},
		updateSettings: {
			get: async () => ({ enabled: false, channel: "latest", nightlyAck: false }),
			set: async () => undefined,
		},
		updates: {
			getStatus: async () => ({ state: "idle" }),
			check: async () => undefined,
			download: async () => undefined,
			install: async () => undefined,
			onStatus: () => () => undefined,
		},
	};
} // end if (typeof window !== "undefined")
