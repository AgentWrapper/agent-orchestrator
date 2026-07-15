// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeUpdateSettings } from "./update-settings";

type AutoUpdaterMock = {
	on: ReturnType<typeof vi.fn>;
	checkForUpdates: ReturnType<typeof vi.fn>;
	downloadUpdate: ReturnType<typeof vi.fn>;
	quitAndInstall: ReturnType<typeof vi.fn>;
	channel: string;
	allowPrerelease: boolean;
	allowDowngrade: boolean;
	autoDownload: boolean;
	autoInstallOnAppQuit: boolean;
};

function createAutoUpdaterMock(): AutoUpdaterMock {
	return {
		on: vi.fn(),
		checkForUpdates: vi.fn(() => Promise.resolve()),
		downloadUpdate: vi.fn(() => Promise.resolve()),
		quitAndInstall: vi.fn(),
		channel: "",
		allowPrerelease: false,
		allowDowngrade: false,
		autoDownload: false,
		autoInstallOnAppQuit: false,
	};
}

async function importAutoUpdater() {
	vi.resetModules();
	const autoUpdater = createAutoUpdaterMock();
	const dialog = {
		showMessageBox: vi.fn(),
	};
	const BrowserWindow = {
		getAllWindows: vi.fn(() => []),
	};
	vi.doMock("electron-updater", () => ({ autoUpdater }));
	vi.doMock("electron", () => ({
		app: {
			isPackaged: true,
			getVersion: () => "1.0.0",
		},
		BrowserWindow,
		dialog,
	}));
	const module = await import("./auto-updater");
	return { module, autoUpdater, dialog, BrowserWindow };
}

function latestInterval(setIntervalSpy: ReturnType<typeof vi.spyOn>): {
	callback: () => void;
	delay: number;
	timer: ReturnType<typeof setInterval>;
} {
	const calls = setIntervalSpy.mock.calls;
	expect(calls.length).toBeGreaterThan(0);
	const [callback, delay] = calls.at(-1) ?? [];
	expect(typeof callback).toBe("function");
	expect(typeof delay).toBe("number");
	const results = setIntervalSpy.mock.results;
	const timer = results.at(-1)?.value as ReturnType<typeof setInterval>;
	return { callback: callback as () => void, delay: delay as number, timer };
}

describe("startAutoUpdates", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "ao-auto-updater-"));
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.resetModules();
		await rm(dir, { recursive: true, force: true });
	});

	it("runs the automatic updater check immediately on launch", async () => {
		await writeUpdateSettings(dir, { enabled: true, channel: "latest", nightlyAck: false });
		const { module, autoUpdater } = await importAutoUpdater();

		await module.startAutoUpdates(dir);

		expect(autoUpdater.autoDownload).toBe(true);
		expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
		expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
	});

	it("schedules the next automatic check only after the fixed 1-2 hour cadence", async () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		await writeUpdateSettings(dir, { enabled: true, channel: "latest", nightlyAck: false });
		const { module, autoUpdater } = await importAutoUpdater();

		await module.startAutoUpdates(dir);
		const { delay } = latestInterval(setIntervalSpy);

		expect(delay).toBeGreaterThanOrEqual(60 * 60 * 1000);
		expect(delay).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
		await vi.advanceTimersByTimeAsync(delay - 1);
		expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
	});

	it("schedules nothing when automatic updates are disabled", async () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		await writeUpdateSettings(dir, { enabled: false, channel: "latest", nightlyAck: false });
		const { module, autoUpdater } = await importAutoUpdater();

		await module.startAutoUpdates(dir);

		expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
		expect(setIntervalSpy).not.toHaveBeenCalled();
	});

	it("does not stack periodic timers across repeated startAutoUpdates calls", async () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		await writeUpdateSettings(dir, { enabled: true, channel: "latest", nightlyAck: false });
		const { module } = await importAutoUpdater();

		await module.startAutoUpdates(dir);
		await module.startAutoUpdates(dir);

		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
	});

	it("logs periodic check failures without UI and retries on later ticks", async () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await writeUpdateSettings(dir, { enabled: true, channel: "latest", nightlyAck: false });
		const { module, autoUpdater, dialog, BrowserWindow } = await importAutoUpdater();
		autoUpdater.checkForUpdates
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(undefined);

		await module.startAutoUpdates(dir);
		const { delay } = latestInterval(setIntervalSpy);

		await vi.advanceTimersByTimeAsync(delay);
		expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
		expect(consoleErrorSpy).toHaveBeenCalledWith("auto-update check failed:", expect.any(Error));
		expect(dialog.showMessageBox).not.toHaveBeenCalled();
		expect(BrowserWindow.getAllWindows).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(delay);
		expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
	});

	it("restores automatic download behavior on every automatic retry after a manual check", async () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		await writeUpdateSettings(dir, { enabled: true, channel: "latest", nightlyAck: false });
		const { module, autoUpdater } = await importAutoUpdater();

		await module.startAutoUpdates(dir);
		const { delay } = latestInterval(setIntervalSpy);
		await module.checkForUpdatesNow(dir);
		expect(autoUpdater.autoDownload).toBe(false);

		await vi.advanceTimersByTimeAsync(delay);

		expect(autoUpdater.autoDownload).toBe(true);
		expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
	});

	it("unrefs the periodic timer when the runtime supports it", async () => {
		const unref = vi.fn();
		const setIntervalStub = vi.fn((_callback: () => void, _delay?: number) => ({ unref }));
		vi.stubGlobal("setInterval", setIntervalStub);
		await writeUpdateSettings(dir, { enabled: true, channel: "latest", nightlyAck: false });
		const { module } = await importAutoUpdater();

		await module.startAutoUpdates(dir);

		expect(unref).toHaveBeenCalledTimes(1);
	});
});
