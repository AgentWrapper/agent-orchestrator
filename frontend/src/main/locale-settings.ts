import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { coerceLocalePreference, type LocalePreference } from "../shared/locale";

export const LOCALE_SETTINGS_FILE_NAME = "locale-settings.json";

export async function readLocalePreference(userDataDir: string): Promise<LocalePreference> {
	try {
		const raw = await readFile(join(userDataDir, LOCALE_SETTINGS_FILE_NAME), "utf8");
		const parsed: unknown = JSON.parse(raw);
		const preference =
			typeof parsed === "object" && parsed !== null
				? (parsed as { preference?: unknown }).preference
				: undefined;
		return coerceLocalePreference(preference);
	} catch {
		return "system";
	}
}

export async function writeLocalePreference(
	userDataDir: string,
	preference: LocalePreference,
): Promise<void> {
	await mkdir(userDataDir, { recursive: true, mode: 0o750 });
	const file = join(userDataDir, LOCALE_SETTINGS_FILE_NAME);
	const temporaryFile = join(userDataDir, `.locale-settings-${process.pid}-${randomUUID()}.json`);
	const data = `${JSON.stringify({ preference }, null, 2)}\n`;

	try {
		await writeFile(temporaryFile, data, { mode: 0o600 });
		await rename(temporaryFile, file);
	} catch (error) {
		await rm(temporaryFile, { force: true }).catch(() => undefined);
		throw error;
	}
}
