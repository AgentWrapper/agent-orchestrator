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
		expect(await readUpdateSettings(dir)).toEqual({
			enabled: false,
			channel: "latest",
			nightlyAck: false,
			feature: null,
		});
	});

	it("round-trips written settings", async () => {
		await writeUpdateSettings(dir, { enabled: true, channel: "nightly", nightlyAck: true, feature: null });
		expect(await readUpdateSettings(dir)).toEqual({
			enabled: true,
			channel: "nightly",
			nightlyAck: true,
			feature: null,
		});
	});

	it("falls back to defaults on garbage", async () => {
		await writeFile(path.join(dir, UPDATE_SETTINGS_FILE_NAME), "{not json", "utf8");
		expect(await readUpdateSettings(dir)).toEqual({
			enabled: false,
			channel: "latest",
			nightlyAck: false,
			feature: null,
		});
	});

	it("coerces an unknown channel back to latest", async () => {
		await writeFile(
			path.join(dir, UPDATE_SETTINGS_FILE_NAME),
			JSON.stringify({ enabled: true, channel: "weird", nightlyAck: false }),
			"utf8",
		);
		expect((await readUpdateSettings(dir)).channel).toBe("latest");
	});

	it("legacy file without feature key defaults feature to null", async () => {
		await writeFile(
			path.join(dir, UPDATE_SETTINGS_FILE_NAME),
			JSON.stringify({ enabled: true, channel: "nightly", nightlyAck: true }),
			"utf8",
		);
		const settings = await readUpdateSettings(dir);
		expect(settings.feature).toBeNull();
		// channel is preserved as-is
		expect(settings.channel).toBe("nightly");
	});

	it("round-trips nightly + feature pin without clobbering channel", async () => {
		await writeUpdateSettings(dir, { enabled: true, channel: "nightly", nightlyAck: true, feature: { pr: 2270 } });
		const settings = await readUpdateSettings(dir);
		expect(settings).toEqual({ enabled: true, channel: "nightly", nightlyAck: true, feature: { pr: 2270 } });
		// Sanity: channel must remain the home channel value, not a feature string.
		expect(settings.channel).toBe("nightly");
	});

	it("coerces a malformed feature value to null", async () => {
		await writeFile(
			path.join(dir, UPDATE_SETTINGS_FILE_NAME),
			JSON.stringify({ enabled: true, channel: "latest", nightlyAck: false, feature: { pr: "not-a-number" } }),
			"utf8",
		);
		expect((await readUpdateSettings(dir)).feature).toBeNull();
	});

	it("atomic write leaves no temp file behind", async () => {
		await writeUpdateSettings(dir, { enabled: true, channel: "latest", nightlyAck: false, feature: null });
		const entries = await readdir(dir);
		expect(entries).toEqual([UPDATE_SETTINGS_FILE_NAME]);
	});
});
