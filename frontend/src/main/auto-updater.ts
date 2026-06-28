import { autoUpdater } from "electron-updater";
import { app, BrowserWindow, dialog } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import {
	readUpdateSettings,
	writeUpdateSettings,
	UPDATE_SETTINGS_FILE_NAME,
	type UpdateChannel,
	type UpdateStatus,
} from "./update-settings";

// configureFeed sets the update channel on electron-updater. The repo/owner
// are loaded automatically from app-update.yml (written by forge.config.ts's
// postPackage hook into the app's Resources dir at build time). No runtime env
// or setFeedURL call is needed; electron-updater reads the bundled yml on first
// checkForUpdates.
function configureFeed(channel: UpdateChannel): void {
	autoUpdater.channel = channel; // "latest" | "nightly"
	// Nightly builds ship as GitHub *prereleases*. With allowPrerelease false
	// (the default) electron-updater only inspects the latest NON-prerelease
	// release and looks for nightly-mac.yml there, which 404s. Enable prerelease
	// scanning on the nightly channel only; stable must never pull prereleases.
	autoUpdater.allowPrerelease = channel === "nightly";
	autoUpdater.allowDowngrade = true; // permits a nightly -> stable channel switch
}

let lastStatus: UpdateStatus = { state: "idle" };
let eventsWired = false;

// broadcast pushes the latest update status to every renderer window so the
// Global Settings Updates section can reflect check/download progress live.
function broadcast(status: UpdateStatus): void {
	lastStatus = status;
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) win.webContents.send("updates:status", status);
	}
}

// wireUpdaterEvents registers electron-updater listeners once and forwards each
// to the renderer as an UpdateStatus. Idempotent: safe to call on every entry
// point (launch auto-check and manual check).
function wireUpdaterEvents(): void {
	if (eventsWired) return;
	eventsWired = true;
	autoUpdater.on("checking-for-update", () => broadcast({ state: "checking" }));
	autoUpdater.on("update-available", (info) => broadcast({ state: "available", version: info?.version }));
	autoUpdater.on("update-not-available", () => broadcast({ state: "not-available" }));
	autoUpdater.on("download-progress", (p) =>
		broadcast({ state: "downloading", percent: Math.max(0, Math.min(100, Math.round(p?.percent ?? 0))) }),
	);
	autoUpdater.on("update-downloaded", (info) => broadcast({ state: "downloaded", version: info?.version }));
	autoUpdater.on("error", (err) => {
		// Never crash on update failure (offline, unsigned macOS, etc.).
		broadcast({ state: "error", message: err?.message ?? String(err) });
	});
}

export function getUpdateStatus(): UpdateStatus {
	return lastStatus;
}

// startAutoUpdates configures electron-updater from the user's ~/.ao settings.
// It is a thin shell: all policy (channel, opt-in) comes from update-settings.
// Caller guards on app.isPackaged.
export async function startAutoUpdates(stateDir: string): Promise<void> {
	const settings = await readUpdateSettings(stateDir);
	if (!settings.enabled) return;

	wireUpdaterEvents();
	configureFeed(settings.channel);
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;

	try {
		await autoUpdater.checkForUpdates();
	} catch (err) {
		console.error("auto-update check failed:", err);
	}
}

// checkForUpdatesNow runs a manual update check regardless of the auto-update
// opt-in, so a user who never enabled auto-updates can still pull the latest
// build from Settings. It does NOT auto-download — the user clicks Update — and
// reports progress via the broadcast status. Updates only work in the packaged,
// signed app; in dev electron-updater has no feed, so surface that plainly.
export async function checkForUpdatesNow(stateDir: string): Promise<void> {
	wireUpdaterEvents();
	if (!app.isPackaged) {
		broadcast({ state: "unsupported", message: "Updates are only available in the installed app." });
		return;
	}
	const settings = await readUpdateSettings(stateDir);
	configureFeed(settings.channel);
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = true;
	broadcast({ state: "checking" });
	try {
		await autoUpdater.checkForUpdates();
	} catch (err) {
		broadcast({ state: "error", message: (err as Error)?.message ?? "Update check failed" });
	}
}

// downloadUpdateNow starts downloading the update found by checkForUpdatesNow.
export async function downloadUpdateNow(): Promise<void> {
	wireUpdaterEvents();
	if (!app.isPackaged) {
		broadcast({ state: "unsupported", message: "Updates are only available in the installed app." });
		return;
	}
	try {
		await autoUpdater.downloadUpdate();
	} catch (err) {
		broadcast({ state: "error", message: (err as Error)?.message ?? "Download failed" });
	}
}

// quitAndInstallUpdate installs a downloaded update and relaunches. isSilent
// false keeps the installer UI on Windows; isForceRunAfter relaunches the app.
export function quitAndInstallUpdate(): void {
	if (!app.isPackaged) return;
	autoUpdater.quitAndInstall(false, true);
}

// ensureUpdatePrefs prompts once (first run, before any settings file exists)
// for auto-update opt-in + channel, with a nightly instability disclaimer.
export async function ensureUpdatePrefs(stateDir: string): Promise<void> {
	if (existsSync(path.join(stateDir, UPDATE_SETTINGS_FILE_NAME))) return;

	const optIn = await dialog.showMessageBox({
		type: "question",
		buttons: ["Enable auto-updates", "Not now"],
		defaultId: 0,
		cancelId: 1,
		message: "Keep Agent Orchestrator up to date automatically?",
		detail: "You can change this later in Settings.",
	});
	if (optIn.response !== 0) {
		await writeUpdateSettings(stateDir, { enabled: false, channel: "latest", nightlyAck: false });
		return;
	}

	const chan = await dialog.showMessageBox({
		type: "question",
		buttons: ["Stable", "Nightly"],
		defaultId: 0,
		cancelId: 0,
		message: "Which update channel?",
		detail: "Stable is released and tested. Nightly is the newest daily build.",
	});
	if (chan.response !== 1) {
		await writeUpdateSettings(stateDir, { enabled: true, channel: "latest", nightlyAck: false });
		return;
	}

	const ack = await dialog.showMessageBox({
		type: "warning",
		buttons: ["I understand, use Nightly", "Use Stable instead"],
		defaultId: 1,
		cancelId: 1,
		message: "Nightly builds can be unstable",
		detail: "Nightly is built every day and may be broken or lose data. Only use it if you are comfortable with that.",
	});
	await writeUpdateSettings(
		stateDir,
		ack.response === 0
			? { enabled: true, channel: "nightly", nightlyAck: true }
			: { enabled: true, channel: "latest", nightlyAck: false },
	);
}
