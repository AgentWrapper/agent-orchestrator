// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

type UpdateSettings = {
	enabled: boolean;
	channel: "latest" | "nightly";
	nightlyAck: boolean;
};

type UpdateSettingsReader = ReturnType<typeof vi.fn<() => Promise<UpdateSettings>>>;
type UpdaterEventHandler = (...args: any[]) => void;

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

async function importAutoUpdater(
	settings: UpdateSettings | UpdateSettingsReader = { enabled: true, channel: "latest", nightlyAck: false },
) {
	vi.resetModules();
	const updaterEvents = new Map<string, UpdaterEventHandler>();
	const autoUpdater = createAutoUpdaterMock();
	autoUpdater.on.mockImplementation((event: string, handler: UpdaterEventHandler) => {
		updaterEvents.set(event, handler);
		return autoUpdater;
	});
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
	const readUpdateSettings = typeof settings === "function" ? settings : vi.fn(() => Promise.resolve(settings));
	vi.doMock("./update-settings", () => ({
		readUpdateSettings,
		writeUpdateSettings: vi.fn(() => Promise.resolve()),
		UPDATE_SETTINGS_FILE_NAME: "update-settings.json",
	}));
	const module = await import("./auto-updater");
	return { module, autoUpdater, dialog, BrowserWindow, updaterEvents, readUpdateSettings };
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

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("startAutoUpdates", () => {
	const stateDir = "/tmp/ao-state";

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("runs the automatic updater check immediately on launch", async () => {
		const { module, autoUpdater } = await importAutoUpdater();

		await module.startAutoUpdates(stateDir);

		expect(autoUpdater.autoDownload).toBe(true);
		expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
		expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
	});

	it("schedules the next automatic check only after the fixed 1-2 hour cadence", async () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const { module, autoUpdater } = await importAutoUpdater();

		await module.startAutoUpdates(stateDir);
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
		const { module, autoUpdater } = await importAutoUpdater({
			enabled: false,
			channel: "latest",
			nightlyAck: false,
		});

		await module.startAutoUpdates(stateDir);

		expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
		expect(setIntervalSpy).not.toHaveBeenCalled();
	});

	it("does not stack periodic timers across repeated startAutoUpdates calls", async () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const { module } = await importAutoUpdater();

		await module.startAutoUpdates(stateDir);
		await module.startAutoUpdates(stateDir);

		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
	});

	it("logs periodic check failures without UI and retries on later ticks", async () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { module, autoUpdater, dialog, BrowserWindow } = await importAutoUpdater();
		autoUpdater.checkForUpdates
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(undefined);

		await module.startAutoUpdates(stateDir);
		const { delay } = latestInterval(setIntervalSpy);

		await vi.advanceTimersByTimeAsync(delay);
		expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
		expect(consoleErrorSpy).toHaveBeenCalledWith("auto-update check failed:", expect.any(Error));
		expect(dialog.showMessageBox).not.toHaveBeenCalled();
		expect(BrowserWindow.getAllWindows).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(delay);
		expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
	});

	it("logs updater error events during automatic checks without broadcasting renderer errors", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { module, autoUpdater, BrowserWindow, updaterEvents } = await importAutoUpdater();
		const err = new Error("feed failed");
		autoUpdater.checkForUpdates.mockImplementationOnce(() => {
			updaterEvents.get("error")?.(err);
			return Promise.resolve();
		});

		await module.startAutoUpdates(stateDir);

		expect(consoleErrorSpy).toHaveBeenCalledWith("auto-update check failed:", err);
		expect(BrowserWindow.getAllWindows).not.toHaveBeenCalled();
		expect(module.getUpdateStatus()).toEqual({ state: "idle" });
	});

	it("restores the prior renderer status when an automatic check emits checking before an error", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { module, autoUpdater, updaterEvents } = await importAutoUpdater();
		const err = new Error("feed failed");

		await module.checkForUpdatesNow(stateDir);
		updaterEvents.get("update-available")?.({ version: "2.0.0" });
		expect(module.getUpdateStatus()).toEqual({ state: "available", version: "2.0.0" });

		autoUpdater.checkForUpdates.mockImplementationOnce(() => {
			updaterEvents.get("checking-for-update")?.();
			updaterEvents.get("error")?.(err);
			return Promise.resolve();
		});

		await module.startAutoUpdates(stateDir);

		expect(consoleErrorSpy).toHaveBeenCalledWith("auto-update check failed:", err);
		expect(module.getUpdateStatus()).toEqual({ state: "available", version: "2.0.0" });
	});

	it("restores the prior status when an automatic download fails after publishing progress", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const lateDownload = deferred();
		const { module, autoUpdater, updaterEvents } = await importAutoUpdater();
		const err = new Error("download failed");

		await module.checkForUpdatesNow(stateDir);
		updaterEvents.get("update-available")?.({ version: "2.0.0" });
		expect(module.getUpdateStatus()).toEqual({ state: "available", version: "2.0.0" });

		autoUpdater.checkForUpdates.mockImplementationOnce(() => {
			updaterEvents.get("checking-for-update")?.();
			updaterEvents.get("update-available")?.({ version: "2.1.0" });
			updaterEvents.get("download-progress")?.({ percent: 42 });
			return Promise.resolve({ downloadPromise: lateDownload.promise });
		});
		const startPromise = module.startAutoUpdates(stateDir);
		await Promise.resolve();
		await Promise.resolve();
		expect(module.getUpdateStatus()).toEqual({ state: "downloading", percent: 42 });

		updaterEvents.get("error")?.(err);
		lateDownload.resolve();
		await startPromise;

		expect(consoleErrorSpy).toHaveBeenCalledWith("auto-update check failed:", err);
		expect(module.getUpdateStatus()).toEqual({ state: "available", version: "2.0.0" });
	});

	it("restores a staged update when an automatic check emits checking before an error", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-19T12:00:00.000Z"));
		const stagedAt = Date.now();
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { module, autoUpdater, updaterEvents } = await importAutoUpdater();
		const err = new Error("feed failed");

		await module.checkForUpdatesNow(stateDir);
		updaterEvents.get("update-downloaded")?.({ version: "2.1.0" });
		expect(module.getUpdateStatus()).toEqual({
			state: "downloaded",
			version: "2.1.0",
			stagedAt,
			escalated: false,
		});

		autoUpdater.checkForUpdates.mockImplementationOnce(() => {
			updaterEvents.get("checking-for-update")?.();
			updaterEvents.get("error")?.(err);
			return Promise.resolve();
		});

		await module.startAutoUpdates(stateDir);

		expect(consoleErrorSpy).toHaveBeenCalledWith("auto-update check failed:", err);
		expect(module.getUpdateStatus()).toEqual({
			state: "downloaded",
			version: "2.1.0",
			stagedAt,
			escalated: false,
		});
	});

	it("does not overwrite a newer staged escalation when an automatic check fails", async () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const stagedAt = new Date("2026-07-17T12:00:00.000Z").getTime();
		vi.setSystemTime(stagedAt);
		const automaticCheck = deferred();
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { module, autoUpdater, updaterEvents } = await importAutoUpdater();
		const err = new Error("feed failed");

		await module.checkForUpdatesNow(stateDir);
		updaterEvents.get("update-downloaded")?.({ version: "2.1.0" });
		await Promise.resolve();
		await Promise.resolve();
		const { callback: runEscalation } = latestInterval(setIntervalSpy);

		autoUpdater.checkForUpdates.mockImplementationOnce(() => {
			updaterEvents.get("checking-for-update")?.();
			return automaticCheck.promise;
		});
		const startPromise = module.startAutoUpdates(stateDir);
		await Promise.resolve();
		await Promise.resolve();

		vi.setSystemTime(stagedAt + 49 * 60 * 60 * 1000);
		runEscalation();
		await Promise.resolve();
		await Promise.resolve();
		expect(module.getUpdateStatus()).toEqual({
			state: "downloaded",
			version: "2.1.0",
			stagedAt,
			escalated: true,
		});

		updaterEvents.get("error")?.(err);
		automaticCheck.resolve();
		await startPromise;

		expect(consoleErrorSpy).toHaveBeenCalledWith("auto-update check failed:", err);
		expect(module.getUpdateStatus()).toEqual({
			state: "downloaded",
			version: "2.1.0",
			stagedAt,
			escalated: true,
		});
	});

	it("restores an independent staged escalation after later automatic download progress fails", async () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const stagedAt = new Date("2026-07-17T12:00:00.000Z").getTime();
		vi.setSystemTime(stagedAt);
		const automaticDownload = deferred();
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { module, autoUpdater, updaterEvents } = await importAutoUpdater();
		const err = new Error("download failed");

		await module.checkForUpdatesNow(stateDir);
		updaterEvents.get("update-downloaded")?.({ version: "2.1.0" });
		await Promise.resolve();
		await Promise.resolve();
		const { callback: runEscalation } = latestInterval(setIntervalSpy);

		autoUpdater.checkForUpdates.mockImplementationOnce(() => {
			updaterEvents.get("checking-for-update")?.();
			return Promise.resolve({ downloadPromise: automaticDownload.promise });
		});
		const startPromise = module.startAutoUpdates(stateDir);
		await Promise.resolve();
		await Promise.resolve();

		vi.setSystemTime(stagedAt + 49 * 60 * 60 * 1000);
		runEscalation();
		await Promise.resolve();
		await Promise.resolve();
		updaterEvents.get("update-available")?.({ version: "2.2.0" });
		updaterEvents.get("download-progress")?.({ percent: 64 });
		expect(module.getUpdateStatus()).toEqual({ state: "downloading", percent: 64 });

		updaterEvents.get("error")?.(err);
		automaticDownload.resolve();
		await startPromise;

		expect(consoleErrorSpy).toHaveBeenCalledWith("auto-update check failed:", err);
		expect(module.getUpdateStatus()).toEqual({
			state: "downloaded",
			version: "2.1.0",
			stagedAt,
			escalated: true,
		});
	});

	it("keeps automatic download errors silent after checkForUpdates resolves", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const lateDownload = deferred();
		const { module, autoUpdater, BrowserWindow, updaterEvents } = await importAutoUpdater();
		const err = new Error("download failed");
		autoUpdater.checkForUpdates.mockResolvedValueOnce({ downloadPromise: lateDownload.promise });

		const startPromise = module.startAutoUpdates(stateDir);
		await Promise.resolve();
		await Promise.resolve();
		let startSettled = false;
		void startPromise.then(() => {
			startSettled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(startSettled).toBe(false);
		updaterEvents.get("error")?.(err);

		expect(consoleErrorSpy).toHaveBeenCalledWith("auto-update check failed:", err);
		expect(BrowserWindow.getAllWindows).not.toHaveBeenCalled();
		lateDownload.resolve();
		await startPromise;
	});

	it("keeps manual download errors visible when requested during an automatic check", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const automaticCheck = deferred();
		const { module, autoUpdater, updaterEvents } = await importAutoUpdater();
		const err = new Error("manual download failed");
		autoUpdater.checkForUpdates.mockReturnValueOnce(automaticCheck.promise);
		autoUpdater.downloadUpdate.mockImplementationOnce(() => {
			updaterEvents.get("error")?.(err);
			return Promise.resolve();
		});

		const startPromise = module.startAutoUpdates(stateDir);
		await Promise.resolve();
		await Promise.resolve();
		const downloadPromise = module.downloadUpdateNow();
		await Promise.resolve();
		await Promise.resolve();

		automaticCheck.resolve();
		await Promise.all([startPromise, downloadPromise]);

		expect(module.getUpdateStatus()).toEqual({ state: "error", message: "manual download failed" });
	});

	it("keeps manual updater error events visible to the renderer", async () => {
		const { module, BrowserWindow, updaterEvents } = await importAutoUpdater();
		const err = new Error("manual feed failed");

		await module.checkForUpdatesNow(stateDir);
		updaterEvents.get("error")?.(err);

		expect(BrowserWindow.getAllWindows).toHaveBeenCalled();
		expect(module.getUpdateStatus()).toEqual({ state: "error", message: "manual feed failed" });
	});

	it("logs settings failures during automatic checks and retries on later ticks", async () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const readUpdateSettings = vi
			.fn<() => Promise<UpdateSettings>>()
			.mockRejectedValueOnce(new Error("settings locked"))
			.mockResolvedValue({ enabled: true, channel: "latest", nightlyAck: false });
		const { module, autoUpdater } = await importAutoUpdater(readUpdateSettings);

		await expect(module.startAutoUpdates(stateDir)).resolves.toBeUndefined();
		expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
		expect(consoleErrorSpy).toHaveBeenCalledWith("auto-update check failed:", expect.any(Error));
		const { delay } = latestInterval(setIntervalSpy);

		await vi.advanceTimersByTimeAsync(delay);

		expect(readUpdateSettings).toHaveBeenCalledTimes(2);
		expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
	});

	it("restores automatic download behavior on every automatic retry after a manual check", async () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const { module, autoUpdater } = await importAutoUpdater();

		await module.startAutoUpdates(stateDir);
		const { delay } = latestInterval(setIntervalSpy);
		await module.checkForUpdatesNow(stateDir);
		expect(autoUpdater.autoDownload).toBe(false);

		await vi.advanceTimersByTimeAsync(delay);

		expect(autoUpdater.autoDownload).toBe(true);
		expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
	});

	it("waits for an in-flight manual check before a periodic automatic check restores autoDownload", async () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const manualCheck = deferred();
		const { module, autoUpdater } = await importAutoUpdater();
		autoUpdater.checkForUpdates
			.mockResolvedValueOnce(undefined)
			.mockReturnValueOnce(manualCheck.promise)
			.mockResolvedValueOnce(undefined);

		await module.startAutoUpdates(stateDir);
		const { delay } = latestInterval(setIntervalSpy);
		const manualPromise = module.checkForUpdatesNow(stateDir);
		await Promise.resolve();
		await Promise.resolve();
		expect(autoUpdater.autoDownload).toBe(false);
		expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(delay);
		expect(autoUpdater.autoDownload).toBe(false);
		expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);

		manualCheck.resolve();
		await manualPromise;
		await Promise.resolve();
		await Promise.resolve();

		expect(autoUpdater.autoDownload).toBe(true);
		expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
	});

	it("unrefs the periodic timer when the runtime supports it", async () => {
		const unref = vi.fn();
		const setIntervalStub = vi.fn((_callback: () => void, _delay?: number) => ({ unref }));
		vi.stubGlobal("setInterval", setIntervalStub);
		const { module } = await importAutoUpdater();

		await module.startAutoUpdates(stateDir);

		expect(unref).toHaveBeenCalledTimes(1);
	});
});
