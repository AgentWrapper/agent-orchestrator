import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type UpdateChannel = "latest" | "nightly";

export interface UpdateSettings {
	enabled: boolean;
	channel: UpdateChannel;
	nightlyAck: boolean;
}

// Live state of a manual update check/download, streamed to the renderer so the
// Global Settings "Check for updates" / "Update" buttons can reflect progress.
export type UpdateState =
	"idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error" | "unsupported";

export interface UpdateStatus {
	state: UpdateState;
	version?: string;
	percent?: number;
	message?: string;
}

/** File holding the user's auto-update preferences under the ~/.ao state dir. */
export const UPDATE_SETTINGS_FILE_NAME = "update-settings.json";

const DEFAULTS: UpdateSettings = { enabled: false, channel: "latest", nightlyAck: false };

function coerce(raw: unknown): UpdateSettings {
	const o = (raw ?? {}) as Record<string, unknown>;
	return {
		enabled: o.enabled === true,
		channel: o.channel === "nightly" ? "nightly" : "latest",
		nightlyAck: o.nightlyAck === true,
	};
}

/** Read update settings, tolerating a missing or corrupt file (returns defaults). */
export async function readUpdateSettings(stateDir: string): Promise<UpdateSettings> {
	let raw: string;
	try {
		raw = await readFile(path.join(stateDir, UPDATE_SETTINGS_FILE_NAME), "utf8");
	} catch {
		return { ...DEFAULTS };
	}
	try {
		return coerce(JSON.parse(raw));
	} catch {
		return { ...DEFAULTS };
	}
}

/** Atomically write update settings (temp file + rename), mirroring app-state.ts. */
export async function writeUpdateSettings(stateDir: string, settings: UpdateSettings): Promise<void> {
	await mkdir(stateDir, { recursive: true, mode: 0o750 });
	const file = path.join(stateDir, UPDATE_SETTINGS_FILE_NAME);
	const data = `${JSON.stringify(coerce(settings), null, 2)}\n`;
	const tmp = path.join(stateDir, `.update-settings-${process.pid}-${Date.now()}.json`);
	await writeFile(tmp, data, { mode: 0o600 });
	await rename(tmp, file);
}
