import type { AoBridge } from "../../shared/bridge-types";
import { createTauriBridge } from "./tauri-bridge";

export type { FeatureBuild } from "../../shared/bridge-types";

// Fallback implementation of the namespaces that have no dedicated backing
// yet under both the browser (no window.ao) and Tauri (Rust commands land in
// later milestones) runtimes. Exported so tauri-bridge.ts can reuse it without
// duplicating the stub behavior.
export const browserFallback: AoBridge["browser"] = {
	ensure: async (sessionId: string) => ({
		viewId: `preview:${sessionId}`,
		url: "",
		title: "",
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
	}),
	setBounds: () => undefined,
	navigate: async ({ viewId, url }) => ({
		viewId,
		url,
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
	capture: async () => "",
	requestMirror: async () => false,
	setAnnotationMode: async () => undefined,
	onNavState: () => () => undefined,
	onAnnotationSubmit: () => () => undefined,
	onAnnotationCancel: () => () => undefined,
};

export const updatesFallback: AoBridge["updates"] = {
	getStatus: async () => ({ state: "idle" }),
	check: async () => undefined,
	returnHome: async () => undefined,
	download: async () => undefined,
	install: async () => undefined,
	onStatus: () => () => undefined,
};

export const featureBuildsFallback: AoBridge["featureBuilds"] = {
	list: async () => [],
	getActive: async () => null,
};

// Exported so components that need Tauri-only behavior (e.g. WindowTitlebar's
// custom window-control buttons, needed because Tauri's `decorations: false`
// draws no native min/max/close chrome, unlike Electron's Window Controls
// Overlay) can branch on runtime without re-deriving this check.
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const aoBridge: AoBridge = isTauri
	? createTauriBridge()
	: (window.ao ??
		({
			app: {
				getVersion: async () => "0.0.0-preview",
				chooseDirectory: async () => null,
				openExternal: async (url: string) => {
					window.open(url, "_blank", "noopener,noreferrer");
				},
				scanImportFolder: async ({ path }) => ({ path, repos: [] }),
				onNewSessionShortcut: () => () => undefined,
				onKeyboardShortcutsHelp: () => () => undefined,
				onNewShellTerminalShortcut: () => () => undefined,
				onOpenSettingsShortcut: () => () => undefined,
				onPreviousSessionShortcut: () => () => undefined,
				onNextSessionShortcut: () => () => undefined,
				onFocusTerminalShortcut: () => () => undefined,
			},
			terminal: {
				saveDroppedFile: async () => "",
			},
			window: {
				setOverlay: async () => undefined,
				isFullScreen: async () => false,
				onFullScreen: () => () => undefined,
			},
			theme: {
				set: async () => undefined,
			},
			menu: {
				action: async () => undefined,
				notifyShellFocus: () => undefined,
			},
			clipboard: {
				writeText: async (text: string) => {
					if (navigator.clipboard?.writeText) {
						await navigator.clipboard.writeText(text);
					}
				},
				readText: async () => (navigator.clipboard?.readText ? navigator.clipboard.readText() : ""),
			},
			daemon: {
				getStatus: async () => ({
					state: "stopped",
					message: "The native Tauri bridge is not available in browser preview.",
				}),
				start: async () => ({ state: "starting" }),
				stop: async () => ({ state: "stopped" }),
				restart: async () => ({ state: "starting" }),
				onStatus: () => () => undefined,
			},
			telemetry: {
				getBootstrap: async () => null,
			},
			browser: browserFallback,
			notifications: {
				show: async () => undefined,
				onClick: () => () => undefined,
			},
			appState: {
				getMigration: async () => ({ status: "pending" }),
				setMigration: async () => undefined,
			},
			updateSettings: {
				get: async () => ({ enabled: false, channel: "latest", nightlyAck: false, feature: null }),
				set: async () => undefined,
				hasDecision: async () => true,
			},
			keybindings: {
				get: async () => ({}),
				set: async (overrides) => overrides,
				setRecording: async () => undefined,
			},
			updates: updatesFallback,
			featureBuilds: featureBuildsFallback,
		} satisfies AoBridge));
