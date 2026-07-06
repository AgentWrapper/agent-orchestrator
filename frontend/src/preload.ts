import { contextBridge, ipcRenderer } from "electron";
import type { BrowserNavState, BrowserRect } from "./main/browser-view-host";
import type { DaemonStatus } from "./shared/daemon-status";
import type { TelemetryBootstrap } from "./shared/telemetry";
import type { MigrationState } from "./main/app-state";
import type { UpdateSettings, UpdateStatus } from "./main/update-settings";

export type BrowserBoundsInput = {
	viewId: string;
	rect: BrowserRect;
	visible: boolean;
};

export type BrowserNavigateInput = {
	viewId: string;
	url: string;
};

const api = {
	app: {
		getVersion: () => ipcRenderer.invoke("app:getVersion") as Promise<string>,
		chooseDirectory: () => ipcRenderer.invoke("app:chooseDirectory") as Promise<string | null>,
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
		goBack: (viewId: string) => ipcRenderer.invoke("browser:goBack", viewId) as Promise<BrowserNavState>,
		goForward: (viewId: string) => ipcRenderer.invoke("browser:goForward", viewId) as Promise<BrowserNavState>,
		reload: (viewId: string) => ipcRenderer.invoke("browser:reload", viewId) as Promise<BrowserNavState>,
		stop: (viewId: string) => ipcRenderer.invoke("browser:stop", viewId) as Promise<BrowserNavState>,
		destroy: (viewId: string) => ipcRenderer.send("browser:destroy", viewId),
		onNavState: (listener: (state: BrowserNavState) => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, state: BrowserNavState) => listener(state);
			ipcRenderer.on("browser:navState", wrapped);
			return () => {
				ipcRenderer.off("browser:navState", wrapped);
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
		check: () => ipcRenderer.invoke("updates:check") as Promise<void>,
		download: () => ipcRenderer.invoke("updates:download") as Promise<void>,
		install: () => ipcRenderer.invoke("updates:install") as Promise<void>,
		onStatus: (listener: (status: UpdateStatus) => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => listener(status);
			ipcRenderer.on("updates:status", wrapped);
			return () => {
				ipcRenderer.off("updates:status", wrapped);
			};
		},
	},
};

contextBridge.exposeInMainWorld("ao", api);

export type AoBridge = typeof api;
