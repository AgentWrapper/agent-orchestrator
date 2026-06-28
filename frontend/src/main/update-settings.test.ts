// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readUpdateSettings, writeUpdateSettings, UPDATE_SETTINGS_FILE_NAME } from "./update-settings";

describe("update-settings", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "ao-update-settings-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns safe defaults when no file exists", async () => {
		expect(await readUpdateSettings(dir)).toEqual({ enabled: false, channel: "latest", nightlyAck: false });
	});

	it("round-trips written settings", async () => {
		await writeUpdateSettings(dir, { enabled: true, channel: "nightly", nightlyAck: true });
		expect(await readUpdateSettings(dir)).toEqual({ enabled: true, channel: "nightly", nightlyAck: true });
	});

	it("falls back to defaults on garbage", async () => {
		await writeFile(path.join(dir, UPDATE_SETTINGS_FILE_NAME), "{not json", "utf8");
		expect(await readUpdateSettings(dir)).toEqual({ enabled: false, channel: "latest", nightlyAck: false });
	});

	it("coerces an unknown channel back to latest", async () => {
		await writeFile(
			path.join(dir, UPDATE_SETTINGS_FILE_NAME),
			JSON.stringify({ enabled: true, channel: "weird", nightlyAck: false }),
			"utf8",
		);
		expect((await readUpdateSettings(dir)).channel).toBe("latest");
	});

	it("atomic write leaves no temp file behind", async () => {
		await writeUpdateSettings(dir, { enabled: true, channel: "latest", nightlyAck: false });
		const entries = await readdir(dir);
		expect(entries).toEqual([UPDATE_SETTINGS_FILE_NAME]);
	});
});
