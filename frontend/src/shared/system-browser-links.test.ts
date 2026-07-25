import { describe, expect, it } from "vitest";
import {
	isAllowedSystemBrowserHref,
	isSystemBrowserModifierClick,
	systemBrowserHrefFromClick,
} from "./system-browser-links";

describe("system browser link clicks", () => {
	it("recognizes left-button Alt/Option-clicks", () => {
		expect(isSystemBrowserModifierClick({ altKey: true, button: 0, defaultPrevented: false } as MouseEvent)).toBe(
			true,
		);
		expect(isSystemBrowserModifierClick({ altKey: false, button: 0, defaultPrevented: false } as MouseEvent)).toBe(
			false,
		);
		expect(isSystemBrowserModifierClick({ altKey: true, button: 1, defaultPrevented: false } as MouseEvent)).toBe(
			false,
		);
		expect(isSystemBrowserModifierClick({ altKey: true, button: 0, defaultPrevented: true } as MouseEvent)).toBe(
			false,
		);
	});

	it("finds the nearest allowed anchor for a modified click", () => {
		document.body.innerHTML = `<a href="https://example.com/docs"><span id="label">Docs</span></a>`;
		const target = document.querySelector("#label")!;

		const href = systemBrowserHrefFromClick({
			altKey: true,
			button: 0,
			defaultPrevented: false,
			target,
		} as unknown as MouseEvent);

		expect(href).toBe("https://example.com/docs");
	});

	it("ignores plain clicks and app-internal links", () => {
		document.body.innerHTML = `<a href="app://renderer/sessions/1" id="link">Session</a>`;
		const target = document.querySelector("#link")!;

		expect(
			systemBrowserHrefFromClick({
				altKey: false,
				button: 0,
				defaultPrevented: false,
				target,
			} as unknown as MouseEvent),
		).toBeNull();
		expect(
			systemBrowserHrefFromClick({
				altKey: true,
				button: 0,
				defaultPrevented: false,
				target,
			} as unknown as MouseEvent),
		).toBeNull();
	});

	it("allows only OS-safe external protocols", () => {
		expect(isAllowedSystemBrowserHref("https://example.com")).toBe(true);
		expect(isAllowedSystemBrowserHref("http://localhost:3000")).toBe(true);
		expect(isAllowedSystemBrowserHref("mailto:dev@example.com")).toBe(true);
		expect(isAllowedSystemBrowserHref("file:///tmp/index.html")).toBe(false);
		expect(isAllowedSystemBrowserHref("javascript:alert(1)")).toBe(false);
	});
});
