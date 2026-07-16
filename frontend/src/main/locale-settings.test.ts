// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import {
	LOCALE_SETTINGS_FILE_NAME,
	readLocalePreference,
	writeLocalePreference,
} from "./locale-settings";

describe("locale settings", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(os.tmpdir(), "ao-locale-settings-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it.each([undefined, "not-json", JSON.stringify({ preference: "bad" })])(
		"defaults missing or invalid state to system",
		async (raw) => {
			if (raw !== undefined) {
				await writeFile(join(dir, LOCALE_SETTINGS_FILE_NAME), raw);
			}

			await expect(readLocalePreference(dir)).resolves.toBe("system");
		},
	);

	it("round-trips a valid preference", async () => {
		await writeLocalePreference(dir, "zh-CN");

		await expect(readLocalePreference(dir)).resolves.toBe("zh-CN");
		const raw = JSON.parse(await readFile(join(dir, LOCALE_SETTINGS_FILE_NAME), "utf8"));
		expect(raw).toEqual({ preference: "zh-CN" });
	});

	it("creates the settings directory and file with restrictive modes", async () => {
		const nestedDir = join(dir, "nested", "settings");

		await writeLocalePreference(nestedDir, "en");

		expect((await stat(nestedDir)).mode & 0o777).toBe(0o750);
		expect((await stat(join(nestedDir, LOCALE_SETTINGS_FILE_NAME))).mode & 0o777).toBe(0o600);
	});

	it("leaves no temporary file after a successful atomic write", async () => {
		await writeLocalePreference(dir, "system");

		expect(await readdir(dir)).toEqual([LOCALE_SETTINGS_FILE_NAME]);
	});

	it("cleans up the temporary file when the atomic rename fails", async () => {
		await mkdir(join(dir, LOCALE_SETTINGS_FILE_NAME));

		await expect(writeLocalePreference(dir, "zh-CN")).rejects.toThrow();
		expect(await readdir(dir)).toEqual([LOCALE_SETTINGS_FILE_NAME]);
	});
});
