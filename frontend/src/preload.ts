import { contextBridge, ipcRenderer } from "electron";
import {
	KEYBOARD_SHORTCUTS_HELP_CHANNEL,
	NEW_SESSION_SHORTCUT_CHANNEL,
	NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL,
} from "./shared/shortcuts";
import type { BrowserNavState, BrowserRect } from "./main/browser-view-host";
import type { DaemonStatus } from "./shared/daemon-status";
import type { TelemetryBootstrap } from "./shared/telemetry";
import type { MigrationState } from "./main/app-state";
import type { UpdateSettings, UpdateStatus } from "./main/update-settings";
import type { UpdateCheckOptions } from "./main/auto-updater";
import type { FeatureBuild } from "./main/feature-builds";
import type {
	BrowserAnnotationCancelPayload,
	BrowserAnnotationModeInput,
	BrowserAnnotationSubmitPayload,
} from "./shared/browser-annotations";

export type BrowserBoundsInput = {
	viewId: string;
	rect: BrowserRect;
	visible: boolean;
	parked?: boolean;
};

export type BrowserNavigateInput = {
	viewId: string;
	url: string;
};

export type ImportFolderMode = "project" | "workspace";

export type ImportRepoScan = {
	name: string;
	path: string;
	relativePath: string;
	branch: string;
	remote: string;
	hasRemote: boolean;
	status?: "ok" | "error";
	reason?: string;
};

export type ImportFolderScan = {
	path: string;
	repos: ImportRepoScan[];
};

const api = {
	app: {
		getVersion: () => ipcRenderer.invoke("app:getVersion") as Promise<string>,
		chooseDirectory: (title?: string) => ipcRenderer.invoke("app:chooseDirectory", title) as Promise<string | null>,
		openExternal: (url: string) => ipcRenderer.invoke("app:openExternal", url) as Promise<void>,
		scanImportFolder: (input: { path: string; mode: ImportFolderMode }) =>
			ipcRenderer.invoke("app:scanImportFolder", input) as Promise<ImportFolderScan>,
		// Fired by the main process when the app-level new-session shortcut
		// (⌘N / Ctrl+Shift+N) is pressed in any web contents.
		onNewSessionShortcut: (listener: () => void) => {
			const wrapped = () => listener();
			ipcRenderer.on(NEW_SESSION_SHORTCUT_CHANNEL, wrapped);
			return () => {
				ipcRenderer.off(NEW_SESSION_SHORTCUT_CHANNEL, wrapped);
			};
		},
		onKeyboardShortcutsHelp: (listener: () => void) => {
			const wrapped = () => listener();
			ipcRenderer.on(KEYBOARD_SHORTCUTS_HELP_CHANNEL, wrapped);
			return () => {
				ipcRenderer.off(KEYBOARD_SHORTCUTS_HELP_CHANNEL, wrapped);
			};
		},
		// Fired by the main process when Ctrl+` is pressed in any web contents,
		// including while focus is inside a terminal pane.
		onNewShellTerminalShortcut: (listener: () => void) => {
			const wrapped = () => listener();
			ipcRenderer.on(NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL, wrapped);
			return () => {
				ipcRenderer.off(NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL, wrapped);
			};
		},
	},
	terminal: {
		saveDroppedFile: (input: { name: string; bytes: Uint8Array }) =>
			ipcRenderer.invoke("terminal:saveDroppedFile", input) as Promise<string>,
	},
	window: {
		setOverlay: (overlay: { color: string; symbolColor: string }) =>
			ipcRenderer.invoke("window:setOverlay", overlay) as Promise<void>,
	},
	theme: {
		// Propagate the app's theme preference to Electron's nativeTheme so embedded
		// WebContentsView previews (which follow prefers-color-scheme) stay in sync
		// with the shell. "system" lets both follow the OS.
		set: (preference: "light" | "dark" | "system") => ipcRenderer.invoke("theme:set", preference) as Promise<void>,
	},
	menu: {
		action: (action: string) => ipcRenderer.invoke("menu:action", action) as Promise<void>,
		notifyShellFocus: () => ipcRenderer.send("shell:focus"),
	},
	clipboard: {
		writeText: (text: string) => ipcRenderer.invoke("clipboard:writeText", text) as Promise<void>,
		readText: () => ipcRenderer.invoke("clipboard:readText") as Promise<string>,
	},
	daemon: {
		getStatus: () => ipcRenderer.invoke("daemon:getStatus") as Promise<DaemonStatus>,
		start: () => ipcRenderer.invoke("daemon:start") as Promise<DaemonStatus>,
		stop: () => ipcRenderer.invoke("daemon:stop") as Promise<DaemonStatus>,
		onStatus: (listener: (status: DaemonStatus) => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, status: DaemonStatus) => listener(status);
			ipcRenderer.on("daemon:status", wrapped);
			return () => {
				ipcRenderer.off("daemon:status", wrapped);
			};
		},
	},
	telemetry: {
		getBootstrap: () => ipcRenderer.invoke("telemetry:getBootstrap") as Promise<TelemetryBootstrap | null>,
	},
	browser: {
		ensure: (sessionId: string) => ipcRenderer.invoke("browser:ensure", sessionId) as Promise<BrowserNavState>,
		setBounds: (input: BrowserBoundsInput) => ipcRenderer.send("browser:setBounds", input),
		navigate: (input: BrowserNavigateInput) =>
			ipcRenderer.invoke("browser:navigate", input) as Promise<BrowserNavState>,
		clear: (viewId: string) => ipcRenderer.invoke("browser:clear", viewId) as Promise<BrowserNavState>,
		capture: (viewId: string) => ipcRenderer.invoke("browser:capture", viewId) as Promise<string>,
		requestMirror: (viewId: string) => ipcRenderer.invoke("browser:requestMirror", viewId) as Promise<boolean>,
		goBack: (viewId: string) => ipcRenderer.invoke("browser:goBack", viewId) as Promise<BrowserNavState>,
		goForward: (viewId: string) => ipcRenderer.invoke("browser:goForward", viewId) as Promise<BrowserNavState>,
		reload: (viewId: string) => ipcRenderer.invoke("browser:reload", viewId) as Promise<BrowserNavState>,
		stop: (viewId: string) => ipcRenderer.invoke("browser:stop", viewId) as Promise<BrowserNavState>,
		destroy: (viewId: string) => ipcRenderer.send("browser:destroy", viewId),
		setAnnotationMode: (input: BrowserAnnotationModeInput) =>
			ipcRenderer.invoke("browser:annotation:setMode", input) as Promise<void>,
		onNavState: (listener: (state: BrowserNavState) => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, state: BrowserNavState) => listener(state);
			ipcRenderer.on("browser:navState", wrapped);
			return () => {
				ipcRenderer.off("browser:navState", wrapped);
			};
		},
		onAnnotationSubmit: (listener: (payload: BrowserAnnotationSubmitPayload) => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, payload: BrowserAnnotationSubmitPayload) => listener(payload);
			ipcRenderer.on("browser:annotation:submitted", wrapped);
			return () => {
				ipcRenderer.off("browser:annotation:submitted", wrapped);
			};
		},
		onAnnotationCancel: (listener: (payload: BrowserAnnotationCancelPayload) => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, payload: BrowserAnnotationCancelPayload) => listener(payload);
			ipcRenderer.on("browser:annotation:canceled", wrapped);
			return () => {
				ipcRenderer.off("browser:annotation:canceled", wrapped);
			};
		},
	},
	notifications: {
		show: (notification: { id: string; title: string; body?: string }) =>
			ipcRenderer.invoke("notifications:show", notification) as Promise<void>,
		onClick: (listener: (id: string) => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, id: string) => listener(id);
			ipcRenderer.on("notifications:click", wrapped);
			return () => {
				ipcRenderer.off("notifications:click", wrapped);
			};
		},
	},
	appState: {
		getMigration: () => ipcRenderer.invoke("appState:getMigration") as Promise<MigrationState>,
		setMigration: (migration: MigrationState) =>
			ipcRenderer.invoke("appState:setMigration", migration) as Promise<void>,
	},
	updateSettings: {
		get: () => ipcRenderer.invoke("updateSettings:get") as Promise<UpdateSettings>,
		set: (settings: UpdateSettings) => ipcRenderer.invoke("updateSettings:set", settings) as Promise<void>,
	},
	updates: {
		getStatus: () => ipcRenderer.invoke("updates:getStatus") as Promise<UpdateStatus>,
		check: (options?: UpdateCheckOptions) => ipcRenderer.invoke("updates:check", options) as Promise<void>,
		download: (requestId?: string) => ipcRenderer.invoke("updates:download", requestId) as Promise<void>,
		install: () => ipcRenderer.invoke("updates:install") as Promise<void>,
		onStatus: (listener: (status: UpdateStatus) => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => listener(status);
			ipcRenderer.on("updates:status", wrapped);
			return () => {
				ipcRenderer.off("updates:status", wrapped);
			};
		},
	},
	featureBuilds: {
		list: () => ipcRenderer.invoke("featureBuilds:list") as Promise<FeatureBuild[]>,
		getActive: () => ipcRenderer.invoke("featureBuilds:getActive") as Promise<{ pr: number } | null>,
	},
};

contextBridge.exposeInMainWorld("ao", api);

export type AoBridge = typeof api;
