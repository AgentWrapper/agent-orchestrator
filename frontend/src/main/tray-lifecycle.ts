import type { BrowserWindow, IpcMainEvent } from "electron";
import type { TrayController } from "./tray";
import { TRAY_OPEN_SESSION_CHANNEL, type TrayAttentionState, type TrayOpenSessionTarget } from "../shared/tray";

export function isTrayEnabled(platform: NodeJS.Platform, isPackaged: boolean, appVersion: string): boolean {
	return platform === "darwin" && (!isPackaged || appVersion.includes("-nightly."));
}

export type TrayLifecycleDeps = {
	getWindow: () => BrowserWindow | null;
	getTrayController: () => TrayController | null;
	focusWindow: () => void;
};

export type TrayLifecycle = {
	openSession(target: TrayOpenSessionTarget): void;
	handleSetAttentionState(event: IpcMainEvent, state: TrayAttentionState): void;
	handleRendererReady(event: IpcMainEvent): void;
	clearPendingTarget(): void;
	clear(): void;
	dispose(): void;
};

export function createTrayLifecycle(deps: TrayLifecycleDeps): TrayLifecycle {
	let pendingTarget: TrayOpenSessionTarget | null = null;

	function isFromMainWindow(event: IpcMainEvent): boolean {
		const window = deps.getWindow();
		return window !== null && event.sender === window.webContents;
	}

	function clearPendingTarget(): void {
		pendingTarget = null;
	}

	return {
		openSession(target) {
			const contents = deps.getWindow()?.webContents;
			deps.focusWindow();
			if (contents && !contents.isLoading()) {
				contents.send(TRAY_OPEN_SESSION_CHANNEL, target);
				return;
			}
			pendingTarget = target;
		},
		handleSetAttentionState(event, state) {
			const tray = deps.getTrayController();
			if (!tray || !isFromMainWindow(event)) return;
			tray.setState(state);
		},
		handleRendererReady(event) {
			if (!isFromMainWindow(event)) return;
			const target = pendingTarget;
			pendingTarget = null;
			if (target) deps.getWindow()?.webContents.send(TRAY_OPEN_SESSION_CHANNEL, target);
		},
		clear() {
			clearPendingTarget();
			deps.getTrayController()?.clear();
		},
		clearPendingTarget,
		dispose() {
			deps.getTrayController()?.dispose();
		},
	};
}
