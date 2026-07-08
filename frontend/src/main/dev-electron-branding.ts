import { existsSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { APP_DISPLAY_NAME } from "./app-menu";

export const DEV_ELECTRON_BUNDLE_ID = "dev.agent-orchestrator.desktop.dev";

const requireElectron = createRequire(import.meta.url);

type DevElectronBrandingOptions = {
	platform: NodeJS.Platform;
	appName?: string;
	bundleIdentifier?: string;
	electronExecutablePath?: string;
	brandedExecutablePath?: string;
	infoPlistPath?: string;
	exists?: (filePath: string) => boolean;
	readFile?: (filePath: string) => string;
	writeFile?: (filePath: string, contents: string) => void;
	symlink?: (target: string, filePath: string) => void;
	touch?: (filePath: string) => void;
};

function defaultElectronExecutablePath(): string {
	return requireElectron("electron") as string;
}

export function resolveDevElectronInfoPlist(electronExecutablePath: string): string {
	return path.resolve(path.dirname(electronExecutablePath), "..", "Info.plist");
}

export function resolveBrandedDevElectronExecutable(
	electronExecutablePath: string,
	appName = APP_DISPLAY_NAME,
): string {
	return path.join(path.dirname(electronExecutablePath), appName);
}

function escapePlistValue(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function replacePlistStringValue(plist: string, key: string, value: string): string {
	const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
	return plist.replace(pattern, `$1${escapePlistValue(value)}$3`);
}

export function brandDevElectronApp({
	platform,
	appName = APP_DISPLAY_NAME,
	bundleIdentifier = DEV_ELECTRON_BUNDLE_ID,
	electronExecutablePath,
	infoPlistPath,
	exists = existsSync,
	readFile = (filePath) => readFileSync(filePath, "utf8"),
	writeFile = (filePath, contents) => writeFileSync(filePath, contents),
	touch = (filePath) => {
		const now = new Date();
		utimesSync(filePath, now, now);
	},
}: DevElectronBrandingOptions): boolean {
	if (platform !== "darwin") return false;

	const plistPath =
		infoPlistPath ?? resolveDevElectronInfoPlist(electronExecutablePath ?? defaultElectronExecutablePath());
	if (!exists(plistPath)) return false;

	const current = readFile(plistPath);
	const next = [
		["CFBundleDisplayName", appName],
		["CFBundleExecutable", appName],
		["CFBundleName", appName],
		["CFBundleIdentifier", bundleIdentifier],
	].reduce((plist, [key, value]) => replacePlistStringValue(plist, key, value), current);

	if (next === current) return false;

	writeFile(plistPath, next);
	touch(path.resolve(plistPath, "..", ".."));
	return true;
}

export function prepareBrandedDevElectronExecutable({
	platform,
	appName = APP_DISPLAY_NAME,
	electronExecutablePath,
	brandedExecutablePath,
	exists = existsSync,
	symlink = symlinkSync,
	...brandingOptions
}: DevElectronBrandingOptions): string | null {
	if (platform !== "darwin") return null;

	const electronPath = electronExecutablePath ?? defaultElectronExecutablePath();
	const brandedPath = brandedExecutablePath ?? resolveBrandedDevElectronExecutable(electronPath, appName);

	if (!exists(brandedPath)) {
		symlink(path.basename(electronPath), brandedPath);
	}

	brandDevElectronApp({
		platform,
		appName,
		electronExecutablePath: electronPath,
		exists,
		...brandingOptions,
	});

	return brandedPath;
}
