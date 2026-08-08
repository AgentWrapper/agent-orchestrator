import { describe, expect, it } from "vitest";
import { captureCampaign, parseCampaign } from "./campaign";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
	const map = new Map<string, string>();
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => void map.set(k, v),
	};
}

describe("parseCampaign", () => {
	it("pulls the five standard UTM params", () => {
		expect(
			parseCampaign("?utm_source=twitter&utm_medium=social&utm_campaign=launch&utm_term=agents&utm_content=hero"),
		).toEqual({
			utm_source: "twitter",
			utm_medium: "social",
			utm_campaign: "launch",
			utm_term: "agents",
			utm_content: "hero",
		});
	});

	it("keeps only what is present, so a breakdown is not polluted with blanks", () => {
		expect(parseCampaign("?utm_source=newsletter")).toEqual({ utm_source: "newsletter" });
		expect(parseCampaign("")).toEqual({});
		expect(parseCampaign("?ref=hn&gclid=abc")).toEqual({});
	});

	it("drops blank and whitespace-only values", () => {
		expect(parseCampaign("?utm_source=&utm_medium=%20%20")).toEqual({});
	});

	it("trims surrounding whitespace", () => {
		expect(parseCampaign("?utm_source=%20twitter%20")).toEqual({ utm_source: "twitter" });
	});

	it("rejects an absurdly long value as junk", () => {
		const huge = "x".repeat(500);
		expect(parseCampaign(`?utm_campaign=${huge}`)).toEqual({});
	});

	it("ignores unknown keys even when they look campaign-ish", () => {
		expect(parseCampaign("?utm_sources=x&campaign=y&source=z")).toEqual({});
	});
});

describe("captureCampaign", () => {
	// The whole reason this is capture-once. The visit lands with UTM, the visitor
	// navigates to /download which has no query, and the download click must still
	// report the original source.
	it("remembers the entry campaign after the query string is gone", () => {
		const storage = memoryStorage();
		const entry = captureCampaign("?utm_source=twitter&utm_campaign=launch", storage);
		expect(entry).toEqual({ utm_source: "twitter", utm_campaign: "launch" });

		// Later, on /download, no query string.
		const atDownload = captureCampaign("", storage);
		expect(atDownload).toEqual({ utm_source: "twitter", utm_campaign: "launch" });
	});

	// A visit with no campaign must not later inherit stray params from an
	// internal link, which would invent a source that was never real.
	it("locks in an empty campaign so internal navigation cannot backfill one", () => {
		const storage = memoryStorage();
		expect(captureCampaign("", storage)).toEqual({});
		expect(captureCampaign("?utm_source=internal-link", storage)).toEqual({});
	});

	it("falls back to a fresh parse when storage is unavailable", () => {
		expect(captureCampaign("?utm_source=twitter", undefined)).toEqual({ utm_source: "twitter" });
	});
});
