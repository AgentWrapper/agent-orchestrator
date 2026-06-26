import { autoUpdater } from "electron-updater";
import { readUpdateSettings } from "./update-settings";

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
