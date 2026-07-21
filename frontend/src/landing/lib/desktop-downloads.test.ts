import { describe, expect, it } from "vitest";
import { DESKTOP_DOWNLOADS, getDownloadOptions, getDownloadTarget } from "./desktop-downloads";

function device(platform: string, userAgent: string, maxTouchPoints = 0) {
	return { platform, userAgent, maxTouchPoints };
}

describe("desktop download selection", () => {
	it("links Windows desktops directly to the installer", () => {
		expect(getDownloadTarget(device("Win32", "Windows NT 10.0"))).toEqual({
			label: "Download for Windows",
			href: DESKTOP_DOWNLOADS[2].href,
		});
	});

	it("links Linux desktops directly to the AppImage regardless of viewport width", () => {
		const linux = device("Linux x86_64", "X11; Linux x86_64");
		const previousWidth = window.innerWidth;
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
		try {
			expect(getDownloadTarget(linux)).toEqual({
				label: "Download for Linux",
				href: DESKTOP_DOWNLOADS[3].href,
			});
		} finally {
			Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
		}
	});

	it("links Mac desktops directly to the Apple silicon build and lists both architectures", () => {
		const mac = device("MacIntel", "Macintosh; Intel Mac OS X 10_15_7");
		expect(getDownloadTarget(mac)).toEqual({
			label: "Download for macOS",
			href: DESKTOP_DOWNLOADS[0].href,
		});
		expect(getDownloadOptions(mac)).toEqual(DESKTOP_DOWNLOADS.slice(0, 2));
	});

	it.each([
		["iPhone", "Mobile Safari", 5],
		["Linux armv8l", "Android Tablet", 5],
		["MacIntel", "Macintosh", 5],
	])("offers the full desktop chooser to portable device %s", (platform, userAgent, maxTouchPoints) => {
		const portable = device(platform, userAgent, maxTouchPoints);
		expect(getDownloadTarget(portable)).toBeNull();
		expect(getDownloadOptions(portable)).toEqual(DESKTOP_DOWNLOADS);
	});
});
