import { afterEach, describe, expect, it } from "vitest";
import {
	isLinuxPlatform,
	isMacPlatform,
	isWindowsPlatform,
	usesBoardActionsInFramedTopbar,
	usesFramedAppTopbar,
} from "./platform";

const originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, "platform");
const originalUserAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
const originalUserAgentData = Object.getOwnPropertyDescriptor(window.navigator, "userAgentData");

function spoofPlatform(platform: string, userAgent = platform) {
	Object.defineProperty(window.navigator, "platform", {
		configurable: true,
		get: () => platform,
	});
	Object.defineProperty(window.navigator, "userAgent", {
		configurable: true,
		get: () => userAgent,
	});
	Object.defineProperty(window.navigator, "userAgentData", {
		configurable: true,
		get: () => ({ platform }),
	});
}

function restoreProperty(name: "platform" | "userAgent" | "userAgentData", descriptor: PropertyDescriptor | undefined) {
	if (descriptor) {
		Object.defineProperty(window.navigator, name, descriptor);
		return;
	}
	delete (window.navigator as unknown as Record<string, unknown>)[name];
}

afterEach(() => {
	restoreProperty("platform", originalPlatform);
	restoreProperty("userAgent", originalUserAgent);
	restoreProperty("userAgentData", originalUserAgentData);
});

describe("renderer platform behavior", () => {
	it("uses the framed app topbar on macOS while leaving OS chrome native", () => {
		spoofPlatform("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");

		expect(isMacPlatform()).toBe(true);
		expect(isWindowsPlatform()).toBe(false);
		expect(usesFramedAppTopbar()).toBe(true);
		expect(usesBoardActionsInFramedTopbar()).toBe(true);
	});

	it("keeps Windows-specific board controls in the inset panel topbar", () => {
		spoofPlatform("Win32");

		expect(isWindowsPlatform()).toBe(true);
		expect(isMacPlatform()).toBe(false);
		expect(usesFramedAppTopbar()).toBe(true);
		expect(usesBoardActionsInFramedTopbar()).toBe(true);
	});

	it("uses the framed app topbar on Linux", () => {
		spoofPlatform("Linux x86_64");

		expect(isLinuxPlatform()).toBe(true);
		expect(isWindowsPlatform()).toBe(false);
		expect(usesFramedAppTopbar()).toBe(true);
		expect(usesBoardActionsInFramedTopbar()).toBe(true);
	});
});
