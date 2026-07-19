import { autoUpdater } from "electron-updater";
import { app, BrowserWindow, dialog } from "electron";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	readUpdateSettings,
	writeUpdateSettings,
	UPDATE_SETTINGS_FILE_NAME,
	type UpdateChannel,
	type UpdateStatus,
} from "./update-settings";
import { evaluateEscalation } from "./escalation-evaluator";

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

// Staged-update tracking for the escalation evaluator: set on update-downloaded,
// re-evaluated every 30 minutes while the update sits uninstalled. stateDir is
// captured from whichever entry point wired the events (both receive it).
let stagedVersion: string | undefined;
let stagedAtMs: number | undefined;
let stagedEscalated = false;
let escalationTimer: ReturnType<typeof setInterval> | undefined;
let escalationStateDir: string | undefined;

// broadcast pushes the latest update status to every renderer window so the
// Global Settings Updates section can reflect check/download progress live.
function broadcast(status: UpdateStatus): void {
	lastStatus = status;
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) win.webContents.send("updates:status", status);
	}
}

// --- Read-only release-feed helpers (packaged app only; every failure is silent).
// These regex-parse flat keys out of electron-builder yml files on purpose: no
// yaml dependency, and a parse miss just means "no info", never an error state
// (see issue #2270 for why this path must not broadcast errors).

/** Owner/repo from the bundled app-update.yml; undefined in dev or on any failure. */
async function readAppUpdateYml(): Promise<{ owner: string; repo: string } | undefined> {
	if (!app.isPackaged) return undefined;
	try {
		const yml = await readFile(path.join(process.resourcesPath, "app-update.yml"), "utf8");
		const owner = /^owner:\s*(.+)$/m.exec(yml)?.[1]?.trim();
		const repo = /^repo:\s*(.+)$/m.exec(yml)?.[1]?.trim();
		return owner && repo ? { owner, repo } : undefined;
	} catch {
		return undefined;
	}
}

/** Platform suffix matching the feed.mjs naming convention. */
function platformSuffix(): string {
	if (process.platform === "darwin") return "-mac";
	if (process.platform === "linux") return "-linux";
	return "";
}

/** Latest stable version via GitHub's /releases/latest redirect; undefined on any failure. */
async function fetchLatestStableVersion(owner: string, repo: string): Promise<string | undefined> {
	const url = `https://github.com/${owner}/${repo}/releases/latest/download/latest${platformSuffix()}.yml`;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
		if (!res.ok) return undefined;
		return /^version:\s*(.+)$/m.exec(await res.text())?.[1]?.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** important flag on the staged nightly's release yml; false when absent, 404, or any failure. */
async function fetchNightlyImportant(owner: string, repo: string, version: string): Promise<boolean> {
	const url = `https://github.com/${owner}/${repo}/releases/download/v${version}/nightly${platformSuffix()}.yml`;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
		if (!res.ok) return false;
		return /^important:\s*true\s*$/m.test(await res.text());
	} catch {
		return false;
	}
}

// stagedDownloadedStatus rebuilds the enriched downloaded status from module
// state, so transient check states can restore the row without recomputing.
function stagedDownloadedStatus(): UpdateStatus {
	return { state: "downloaded", version: stagedVersion, stagedAt: stagedAtMs, escalated: stagedEscalated };
}

// runEscalationCheck re-reads settings and feeds, then rebroadcasts the
// downloaded status with a fresh escalated flag. The timer is keyed on a build
// being staged (stagedAtMs set), NOT on lastStatus: a manual re-check flips
// lastStatus through checking/available while the build stays staged, and that
// must not kill the loop. Never broadcasts an error state: every failure
// degrades to escalated staying put.
async function runEscalationCheck(): Promise<void> {
	if (stagedAtMs === undefined) {
		stopEscalationTimer();
		return;
	}
	if (escalationStateDir === undefined) return;
	// A newer build is being pulled; let its progress own the status stream.
	if (lastStatus.state === "downloading") return;
	try {
		const settings = await readUpdateSettings(escalationStateDir);
		let important = false;
		let latestStableVersion: string | undefined;
		const coords = await readAppUpdateYml();
		if (coords && settings.channel === "nightly") {
			// stagedVersion is only needed by the important-flag fetch; the
			// latest-channel 48h rule (and the behind-stable check) work without it.
			[latestStableVersion, important] = await Promise.all([
				fetchLatestStableVersion(coords.owner, coords.repo),
				stagedVersion !== undefined
					? fetchNightlyImportant(coords.owner, coords.repo, stagedVersion)
					: Promise.resolve(false),
			]);
		}
		stagedEscalated = evaluateEscalation({
			channel: settings.channel,
			stagedAt: stagedAtMs,
			now: Date.now(),
			important,
			runningVersion: app.getVersion(),
			latestStableVersion,
		});
		broadcast(stagedDownloadedStatus());
	} catch (err) {
		console.debug("escalation check skipped:", err);
	}
}

function stopEscalationTimer(): void {
	if (escalationTimer !== undefined) {
		clearInterval(escalationTimer);
		escalationTimer = undefined;
	}
}

// wireUpdaterEvents registers electron-updater listeners once and forwards each
// to the renderer as an UpdateStatus. Idempotent: safe to call on every entry
// point (launch auto-check and manual check).
function wireUpdaterEvents(): void {
	if (eventsWired) return;
	eventsWired = true;
	// With a build staged, "checking" briefly hides the sidebar restart row; that
	// is acceptable and self-healing: the available / not-available handlers below
	// restore the enriched downloaded status right after.
	autoUpdater.on("checking-for-update", () => broadcast({ state: "checking" }));
	autoUpdater.on("update-available", (info) => {
		// A manual re-check reports the already-staged build as merely "available"
		// (autoDownload is off on that path). It is still in cache and installs on
		// quit, so keep the richer downloaded status instead of hiding the row.
		if (stagedAtMs !== undefined && info?.version === stagedVersion) {
			broadcast(stagedDownloadedStatus());
			return;
		}
		broadcast({ state: "available", version: info?.version });
	});
	autoUpdater.on("update-not-available", () => {
		broadcast({ state: "not-available" });
		// The staged build outlives a "nothing newer" answer (e.g. after a channel
		// switch); follow up so the restart row returns.
		if (stagedAtMs !== undefined) broadcast(stagedDownloadedStatus());
	});
	autoUpdater.on("download-progress", (p) =>
		broadcast({ state: "downloading", percent: Math.max(0, Math.min(100, Math.round(p?.percent ?? 0))) }),
	);
	autoUpdater.on("update-downloaded", (info) => {
		stagedVersion = info?.version;
		stagedAtMs = Date.now();
		stagedEscalated = false;
		broadcast(stagedDownloadedStatus());
		// Evaluate now (nightly can escalate immediately), then every 30 minutes
		// while the update sits uninstalled. unref so the timer never holds the
		// process open on quit.
		void runEscalationCheck();
		stopEscalationTimer();
		escalationTimer = setInterval(() => void runEscalationCheck(), 30 * 60 * 1000);
		escalationTimer.unref?.();
	});
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

	escalationStateDir = stateDir;
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
	escalationStateDir = stateDir;
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
