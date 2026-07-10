// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { APP_DISPLAY_NAME } from "./app-menu";
import {
	brandDevElectronApp,
	DEV_ELECTRON_BUNDLE_ID,
	prepareBrandedDevElectronExecutable,
	resolveBrandedDevElectronExecutable,
	resolveDevElectronInfoPlist,
} from "./dev-electron-branding";

const electronInfoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>Electron</string>
	<key>CFBundleExecutable</key>
	<string>Electron</string>
	<key>CFBundleIdentifier</key>
	<string>com.github.Electron</string>
	<key>CFBundleName</key>
	<string>Electron</string>
</dict>
</plist>`;

describe("brandDevElectronApp", () => {
	it("brands the macOS Electron dev bundle metadata", () => {
		let written = "";
		const writeFile = vi.fn((_filePath: string, contents: string) => {
			written = contents;
		});
		const touch = vi.fn();

		const changed = brandDevElectronApp({
			platform: "darwin",
			infoPlistPath: "/tmp/Electron.app/Contents/Info.plist",
			exists: () => true,
			readFile: () => electronInfoPlist,
			writeFile,
			touch,
		});

		expect(changed).toBe(true);
		expect(written).toContain(`<key>CFBundleDisplayName</key>\n\t<string>${APP_DISPLAY_NAME}</string>`);
		expect(written).toContain(`<key>CFBundleExecutable</key>\n\t<string>${APP_DISPLAY_NAME}</string>`);
		expect(written).toContain(`<key>CFBundleName</key>\n\t<string>${APP_DISPLAY_NAME}</string>`);
		expect(written).toContain(`<key>CFBundleIdentifier</key>\n\t<string>${DEV_ELECTRON_BUNDLE_ID}</string>`);
		expect(writeFile).toHaveBeenCalledWith("/tmp/Electron.app/Contents/Info.plist", written);
		expect(touch).toHaveBeenCalledWith("/tmp/Electron.app");
	});

	it("does nothing outside macOS", () => {
		const writeFile = vi.fn();

		const changed = brandDevElectronApp({
			platform: "linux",
			infoPlistPath: "/tmp/Electron.app/Contents/Info.plist",
			exists: () => true,
			readFile: () => electronInfoPlist,
			writeFile,
		});

		expect(changed).toBe(false);
		expect(writeFile).not.toHaveBeenCalled();
	});

	it("does nothing when the Electron dev bundle plist cannot be found", () => {
		const changed = brandDevElectronApp({
			platform: "darwin",
			infoPlistPath: "/tmp/missing/Info.plist",
			exists: () => false,
		});

		expect(changed).toBe(false);
	});
});

describe("prepareBrandedDevElectronExecutable", () => {
	it("creates a branded executable alias for Forge dev start", () => {
		const symlink = vi.fn();
		const writeFile = vi.fn();
		const executablePath = "/repo/frontend/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";

		const brandedPath = prepareBrandedDevElectronExecutable({
			platform: "darwin",
			electronExecutablePath: executablePath,
			infoPlistPath: "/repo/frontend/node_modules/electron/dist/Electron.app/Contents/Info.plist",
			exists: (filePath) => !filePath.endsWith(`MacOS/${APP_DISPLAY_NAME}`),
			readFile: () => electronInfoPlist,
			writeFile,
			symlink,
			touch: vi.fn(),
		});

		expect(brandedPath).toBe(
			`/repo/frontend/node_modules/electron/dist/Electron.app/Contents/MacOS/${APP_DISPLAY_NAME}`,
		);
		expect(symlink).toHaveBeenCalledWith("Electron", brandedPath);
		expect(writeFile).toHaveBeenCalled();
	});

	it("does not create a dev executable alias outside macOS", () => {
		const symlink = vi.fn();

		const brandedPath = prepareBrandedDevElectronExecutable({
			platform: "linux",
			electronExecutablePath: "/repo/electron",
			symlink,
		});

		expect(brandedPath).toBeNull();
		expect(symlink).not.toHaveBeenCalled();
	});
});

describe("resolveDevElectronInfoPlist", () => {
	it("resolves Info.plist from the Electron executable path", () => {
		expect(
			resolveDevElectronInfoPlist("/repo/frontend/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
		).toBe("/repo/frontend/node_modules/electron/dist/Electron.app/Contents/Info.plist");
	});
});

describe("resolveBrandedDevElectronExecutable", () => {
	it("resolves a sibling executable alias with the app display name", () => {
		expect(
			resolveBrandedDevElectronExecutable(
				"/repo/frontend/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
			),
		).toBe("/repo/frontend/node_modules/electron/dist/Electron.app/Contents/MacOS/Agent Orchestrator");
	});
});
