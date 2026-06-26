import { autoUpdater } from "electron-updater";
import { dialog } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { readUpdateSettings, writeUpdateSettings, UPDATE_SETTINGS_FILE_NAME } from "./update-settings";

// Default release repo, mirroring backend cli.releaseRepo. Override via env for
// fork test builds (AO_RELEASE_REPO=owner/repo).
const DEFAULT_RELEASE_REPO = "AgentWrapper/agent-orchestrator";

function repo(): { owner: string; name: string } {
	const [owner, name] = (process.env.AO_RELEASE_REPO || DEFAULT_RELEASE_REPO).split("/");
	if (owner && name) return { owner, name };
	const [defOwner, defName] = DEFAULT_RELEASE_REPO.split("/");
	return { owner: defOwner, name: defName };
}

// startAutoUpdates configures electron-updater from the user's ~/.ao settings.
// It is a thin shell: all policy (channel, opt-in) comes from update-settings.
// Caller guards on app.isPackaged.
export async function startAutoUpdates(stateDir: string): Promise<void> {
	const settings = await readUpdateSettings(stateDir);
	if (!settings.enabled) return;

	const { owner, name } = repo();
	autoUpdater.setFeedURL({ provider: "github", owner, repo: name });
	autoUpdater.channel = settings.channel; // "latest" | "nightly"
	autoUpdater.allowDowngrade = true; // permits a nightly -> stable channel switch
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;

	autoUpdater.on("error", (err) => {
		// Never crash on update failure (offline, unsigned macOS, etc.).
		console.error("auto-update error:", err?.message ?? err);
	});

	try {
		await autoUpdater.checkForUpdates();
	} catch (err) {
		console.error("auto-update check failed:", err);
	}
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
