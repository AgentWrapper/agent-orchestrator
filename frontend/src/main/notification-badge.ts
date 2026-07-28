import { app, BrowserWindow, nativeImage } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** File holding the last known notification badge count under the electron state dir. */
export const BADGE_COUNT_FILE_NAME = "badge-count.json";

interface BadgeCountFile {
	count: number;
}

let currentBadgeCount = 0;
let lastPersistedCount: number | null = null;

function coerceBadgeCount(raw: unknown): number {
	if (raw === null || raw === undefined) return 0;
	const value = typeof raw === "object" ? (raw as BadgeCountFile).count : raw;
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

async function readBadgeCountUnlocked(stateDir: string): Promise<number> {
	let raw: string;
	try {
		raw = await readFile(path.join(stateDir, BADGE_COUNT_FILE_NAME), "utf8");
	} catch {
		return 0;
	}
	try {
		return coerceBadgeCount(JSON.parse(raw));
	} catch {
		return 0;
	}
}

async function writeBadgeCountUnlocked(stateDir: string, count: number): Promise<void> {
	await mkdir(stateDir, { recursive: true, mode: 0o750 });
	const file = path.join(stateDir, BADGE_COUNT_FILE_NAME);
	const data = `${JSON.stringify({ count }, null, 2)}\n`;
	const tmp = path.join(stateDir, `.badge-count-${process.pid}-${Date.now()}.json`);
	await writeFile(tmp, data, { mode: 0o600 });
	await rename(tmp, file);
}

/** Read the persisted badge count, tolerating a missing or corrupt file. */
export async function readBadgeCount(stateDir: string): Promise<number> {
	return readBadgeCountUnlocked(stateDir);
}

/** Persist the badge count so it survives an app restart. */
export async function writeBadgeCount(stateDir: string, count: number): Promise<void> {
	const normalized = Math.max(0, Math.floor(count));
	if (normalized === lastPersistedCount) return;
	await writeBadgeCountUnlocked(stateDir, normalized);
	lastPersistedCount = normalized;
}

function createWindowsOverlayImage(count: number): Electron.NativeImage {
	const text = count > 99 ? "99+" : String(count);
	const fontSize = text.length > 2 ? 7 : 10;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="#ef4444"/><text x="8" y="12" text-anchor="middle" fill="white" font-size="${fontSize}" font-family="system-ui, -apple-system, sans-serif" font-weight="600">${text}</text></svg>`;
	const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	return nativeImage.createFromDataURL(url);
}

/**
 * Set the app's notification badge to the given count.
 * On macOS/Linux this updates the dock/taskbar badge; on Windows it overlays the
 * taskbar button. The count is clamped to a non-negative integer.
 */
export function setAppBadgeCount(count: number): void {
	const normalized = Math.max(0, Math.floor(count));
	currentBadgeCount = normalized;

	if (process.platform === "win32") {
		const win = BrowserWindow.getAllWindows()[0];
		if (win) {
			win.setOverlayIcon(normalized > 0 ? createWindowsOverlayImage(normalized) : null, "");
		}
		return;
	}

	app.setBadgeCount(normalized);
}

/** Clear the badge (equivalent to setting the count to zero). */
export function clearAppBadgeCount(): void {
	setAppBadgeCount(0);
}

/** The badge count last applied by this process (for tests and introspection). */
export function getCurrentBadgeCount(): number {
	return currentBadgeCount;
}
