/**
 * Path helpers for durable AO state. All project/session/settings data lives
 * under ~/.ao (or AO_DATA_DIR / AO_RUN_FILE overrides) — never inside the
 * desktop install directory. Reinstalling the app binary must leave this tree
 * intact and reopen it on the next launch.
 */

function joinPath(...segments: string[]): string {
	return segments.map((segment) => segment.replace(/[/\\]+$/, "")).join("/");
}

/** Canonical state home (parent of running.json and app-state.json). */
export function defaultStateDir(homeDir: string): string {
	return joinPath(homeDir, ".ao");
}

/**
 * SQLite + worktrees directory. Explicit AO_DATA_DIR wins; otherwise ~/.ao/data.
 * Independent of where the desktop app is installed.
 */
export function resolveDataDir(
	homeDir: string,
	env: Record<string, string | undefined> = {},
): string {
	const override = env.AO_DATA_DIR?.trim();
	if (override) return override;
	return joinPath(defaultStateDir(homeDir), "data");
}

/**
 * Electron Chromium userData. Packaged app: ~/.ao/electron. Dev: ~/.ao/dev/electron.
 * Not the install path; not OS Application Support / AppData defaults.
 */
export function resolveElectronUserDataPath(homeDir: string, isPackaged: boolean): string {
	return isPackaged
		? joinPath(defaultStateDir(homeDir), "electron")
		: joinPath(defaultStateDir(homeDir), "dev", "electron");
}

/**
 * True when dataDir is under the state home (or is an explicit override path
 * outside the install dir). Used to assert reinstall-safe layout in tests.
 */
export function isOutsideInstallDir(dataDir: string, installDir: string): boolean {
	const data = dataDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const install = installDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	if (!data || !install) return true;
	return data !== install && !data.startsWith(install + "/");
}
