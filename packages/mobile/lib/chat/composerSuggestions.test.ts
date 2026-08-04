import { describe, expect, it } from "vitest";
import { findComposerSuggestion, replaceComposerSuggestion } from "./composerSuggestions";

describe("mobile Chat composer suggestions", () => {
	it("finds slash skills and @ files at token boundaries", () => {
		expect(findComposerSuggestion("/rev")).toMatchObject({ kind: "skills", query: "rev", start: 0 });
		expect(findComposerSuggestion("inspect @src/app")).toMatchObject({ kind: "files", query: "src/app" });
		expect(findComposerSuggestion("https://ao.dev")).toBeUndefined();
	});

	it("replaces only the active token", () => {
		const text = "please inspect @src/ap now";
		const trigger = findComposerSuggestion(text, "please inspect @src/ap".length)!;
		expect(replaceComposerSuggestion(text, trigger, "src/app.ts")).toBe("please inspect @src/app.ts now");
	});
});
