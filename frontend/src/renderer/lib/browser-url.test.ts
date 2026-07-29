// Test coverage ported from the `normalizeBrowserURL`/`isAllowedBrowserURL`/
// `clampBoundsToWindow`/`scaleBoundsForZoom` describe blocks in
// frontend/src/main/browser-view-host.test.ts (the Electron host's tests),
// since browser-url.ts is a byte-for-byte port of those pure functions.
import { describe, expect, it } from "vitest";
import { clampBoundsToWindow, isAllowedBrowserURL, normalizeBrowserURL, scaleBoundsForZoom } from "./browser-url";

describe("normalizeBrowserURL", () => {
	it("defaults localhost-style inputs to http", () => {
		expect(normalizeBrowserURL("localhost:5173").href).toBe("http://localhost:5173/");
		expect(normalizeBrowserURL("127.0.0.1:3000").href).toBe("http://127.0.0.1:3000/");
		expect(normalizeBrowserURL("[::1]:4173").href).toBe("http://[::1]:4173/");
	});

	it("defaults ordinary bare hosts to https", () => {
		expect(normalizeBrowserURL("example.com").href).toBe("https://example.com/");
		expect(normalizeBrowserURL("example.com/path?q=1").href).toBe("https://example.com/path?q=1");
		expect(normalizeBrowserURL("192.168.1.5:8080").href).toBe("https://192.168.1.5:8080/");
	});

	it("routes non-URL input to a web search", () => {
		expect(normalizeBrowserURL("hi").href).toBe("https://www.google.com/search?q=hi");
		expect(normalizeBrowserURL("how do i center a div").href).toBe(
			"https://www.google.com/search?q=how%20do%20i%20center%20a%20div",
		);
		// A dot-less token with a trailing colon is text, not a scheme, once it
		// carries whitespace, so it still searches rather than throwing on new URL().
		expect(normalizeBrowserURL("time: now").href).toBe("https://www.google.com/search?q=time%3A%20now");
	});

	it("allows file:// preview targets without mangling the scheme", () => {
		expect(normalizeBrowserURL("file:///tmp/preview/index.html").href).toBe("file:///tmp/preview/index.html");
		expect(normalizeBrowserURL("file:///C:/tmp/index.html").protocol).toBe("file:");
	});

	it("converts absolute local file paths to file URLs", () => {
		expect(normalizeBrowserURL("C:\\Users\\Lenovo\\Downloads\\sm5\\paper_explainer.html").href).toBe(
			"file:///C:/Users/Lenovo/Downloads/sm5/paper_explainer.html",
		);
		expect(normalizeBrowserURL("C:/Users/Lenovo/My File.html").href).toBe("file:///C:/Users/Lenovo/My%20File.html");
		expect(normalizeBrowserURL("/tmp/preview/index.html").href).toBe("file:///tmp/preview/index.html");
	});

	it("rejects privileged or unsupported schemes", () => {
		expect(() => normalizeBrowserURL("app://renderer/index.html")).toThrow(/unsupported/i);
		expect(() => normalizeBrowserURL("javascript:alert(1)")).toThrow(/unsupported/i);
	});
});

describe("isAllowedBrowserURL", () => {
	it("allows file:// even when a renderer origin is set", () => {
		expect(isAllowedBrowserURL("file:///tmp/preview/index.html", "http://localhost:5173")).toBe(true);
	});

	it("still blocks the renderer's own http origin", () => {
		expect(isAllowedBrowserURL("http://localhost:5173/", "http://localhost:5173")).toBe(false);
	});
});

describe("clampBoundsToWindow", () => {
	it("rounds and clamps an out-of-bounds rect to the window", () => {
		expect(clampBoundsToWindow({ x: -10.4, y: 20.6, width: 900.2, height: 700.8 }, { width: 800, height: 600 })).toEqual({
			x: 0,
			y: 21,
			width: 800,
			height: 579,
		});
	});

	it("collapses a rect that starts entirely past the window edge to zero size", () => {
		expect(clampBoundsToWindow({ x: 900, y: 10, width: 100, height: 100 }, { width: 800, height: 600 })).toEqual({
			x: 800,
			y: 10,
			width: 0,
			height: 100,
		});
	});
});

describe("scaleBoundsForZoom", () => {
	it("scales all fields uniformly at a non-default zoom factor", () => {
		expect(scaleBoundsForZoom({ x: 100, y: 20, width: 320, height: 240 }, 1.25)).toEqual({
			x: 125,
			y: 25,
			width: 400,
			height: 300,
		});
	});

	it("is a passthrough at zoom 1, and for non-positive or non-finite factors", () => {
		const rect = { x: 1, y: 1, width: 1, height: 1 };
		expect(scaleBoundsForZoom(rect, 1)).toBe(rect);
		expect(scaleBoundsForZoom(rect, 0)).toBe(rect);
		expect(scaleBoundsForZoom(rect, Number.NaN)).toBe(rect);
	});
});
