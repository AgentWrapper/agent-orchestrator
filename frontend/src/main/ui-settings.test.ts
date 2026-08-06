// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	coerceUiSettings,
	readUiSettings,
	writeUiSettings,
	UI_SETTINGS_FILE_NAME,
	DEFAULT_UI_SETTINGS,
} from "./ui-settings";

describe("ui-settings", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "ao-ui-settings-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns safe defaults when no file exists", async () => {
		expect(await readUiSettings(dir)).toEqual(DEFAULT_UI_SETTINGS);
	});

	it("round-trips written locale", async () => {
		await writeUiSettings(dir, { locale: "zh-CN" });
		expect(await readUiSettings(dir)).toEqual({ locale: "zh-CN" });
		await writeUiSettings(dir, { locale: "en" });
		expect(await readUiSettings(dir)).toEqual({ locale: "en" });
	});

	it("falls back to defaults on garbage", async () => {
		await writeFile(path.join(dir, UI_SETTINGS_FILE_NAME), "{not json", "utf8");
		expect(await readUiSettings(dir)).toEqual(DEFAULT_UI_SETTINGS);
	});

	it("coerces unknown locale to en and accepts supported locales", () => {
		expect(coerceUiSettings({ locale: "xx" })).toEqual({ locale: "en" });
		expect(coerceUiSettings({ locale: "zh" })).toEqual({ locale: "en" });
		expect(coerceUiSettings({})).toEqual({ locale: "en" });
		expect(coerceUiSettings(null)).toEqual({ locale: "en" });
		expect(coerceUiSettings({ locale: "zh-CN" })).toEqual({ locale: "zh-CN" });
		expect(coerceUiSettings({ locale: "fr" })).toEqual({ locale: "fr" });
		expect(coerceUiSettings({ locale: "pt-BR" })).toEqual({ locale: "pt-BR" });
	});

	it("atomic write leaves no temp file behind", async () => {
		await writeUiSettings(dir, { locale: "zh-CN" });
		const entries = await readdir(dir);
		expect(entries).toEqual([UI_SETTINGS_FILE_NAME]);
	});
});
