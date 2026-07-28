import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const electronMocks = vi.hoisted(() => ({
	setBadgeCountMock: vi.fn(),
	setOverlayIconMock: vi.fn(),
	createFromDataURLMock: vi.fn((url: string) => ({ url })),
	getAllWindowsMock: vi.fn(() => [] as Array<{ setOverlayIcon: ReturnType<typeof vi.fn> }>),
}));

vi.mock("electron", () => ({
	app: { setBadgeCount: electronMocks.setBadgeCountMock },
	BrowserWindow: { getAllWindows: electronMocks.getAllWindowsMock },
	nativeImage: { createFromDataURL: electronMocks.createFromDataURLMock },
}));

import {
	BADGE_COUNT_FILE_NAME,
	clearAppBadgeCount,
	getCurrentBadgeCount,
	readBadgeCount,
	setAppBadgeCount,
	writeBadgeCount,
} from "./notification-badge";

let stateDir: string;

beforeEach(async () => {
	stateDir = await mkdtemp(path.join(os.tmpdir(), "ao-badge-test-"));
	electronMocks.setBadgeCountMock.mockClear();
	electronMocks.setOverlayIconMock.mockClear();
	electronMocks.createFromDataURLMock.mockClear();
	electronMocks.getAllWindowsMock.mockClear().mockReturnValue([]);
});

afterEach(async () => {
	await rm(stateDir, { recursive: true, force: true });
});

describe("readBadgeCount", () => {
	it("returns the persisted count", async () => {
		await writeBadgeCount(stateDir, 5);
		await expect(readBadgeCount(stateDir)).resolves.toBe(5);
	});

	it("returns 0 when the file is missing", async () => {
		await expect(readBadgeCount(stateDir)).resolves.toBe(0);
	});

	it("returns 0 for corrupt JSON", async () => {
		await writeFile(path.join(stateDir, BADGE_COUNT_FILE_NAME), "not json");
		await expect(readBadgeCount(stateDir)).resolves.toBe(0);
	});

	it("returns 0 for negative counts", async () => {
		await writeFile(path.join(stateDir, BADGE_COUNT_FILE_NAME), JSON.stringify({ count: -3 }));
		await expect(readBadgeCount(stateDir)).resolves.toBe(0);
	});
});

describe("writeBadgeCount", () => {
	it("persists a non-negative count", async () => {
		await writeBadgeCount(stateDir, 3);

		const raw = await readFile(path.join(stateDir, BADGE_COUNT_FILE_NAME), "utf8");
		expect(JSON.parse(raw)).toEqual({ count: 3 });
	});

	it("clamps negative counts to zero", async () => {
		await writeBadgeCount(stateDir, -2);

		const raw = await readFile(path.join(stateDir, BADGE_COUNT_FILE_NAME), "utf8");
		expect(JSON.parse(raw)).toEqual({ count: 0 });
	});

	it("skips writing when the count has not changed", async () => {
		await writeBadgeCount(stateDir, 4);
		const first = await stat(path.join(stateDir, BADGE_COUNT_FILE_NAME));
		await new Promise((r) => setTimeout(r, 20));
		await writeBadgeCount(stateDir, 4);
		const second = await stat(path.join(stateDir, BADGE_COUNT_FILE_NAME));

		expect(second.mtimeMs).toBe(first.mtimeMs);
	});
});

describe("setAppBadgeCount", () => {
	it("sets the dock badge count on macOS/Linux", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		setAppBadgeCount(4);

		expect(electronMocks.setBadgeCountMock).toHaveBeenCalledWith(4);
		expect(getCurrentBadgeCount()).toBe(4);
	});

	it("clamps fractional counts", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		setAppBadgeCount(2.7);

		expect(electronMocks.setBadgeCountMock).toHaveBeenCalledWith(2);
	});

	it("clears the badge when count is zero", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		setAppBadgeCount(5);
		clearAppBadgeCount();

		expect(electronMocks.setBadgeCountMock).toHaveBeenLastCalledWith(0);
		expect(getCurrentBadgeCount()).toBe(0);
	});

	it("overlays the taskbar icon on Windows", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		const win = { setOverlayIcon: electronMocks.setOverlayIconMock };
		electronMocks.getAllWindowsMock.mockReturnValue([win]);

		setAppBadgeCount(3);

		expect(electronMocks.setOverlayIconMock).toHaveBeenCalledTimes(1);
		expect(electronMocks.createFromDataURLMock).toHaveBeenCalledTimes(1);
		expect(electronMocks.setBadgeCountMock).not.toHaveBeenCalled();
	});

	it("clears the Windows overlay when count is zero", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		const win = { setOverlayIcon: electronMocks.setOverlayIconMock };
		electronMocks.getAllWindowsMock.mockReturnValue([win]);

		setAppBadgeCount(0);

		expect(electronMocks.setOverlayIconMock).toHaveBeenCalledWith(null, "");
	});
});

describe("BADGE_COUNT_FILE_NAME", () => {
	it("exposes the expected file name", () => {
		expect(BADGE_COUNT_FILE_NAME).toBe("badge-count.json");
	});
});
