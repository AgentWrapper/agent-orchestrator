import { describe, expect, it } from "vitest";
import {
	findComposerSuggestion,
	rankComposerFiles,
	rankComposerSkills,
	replaceComposerSuggestion,
} from "./composerSuggestions";

describe("mobile Chat composer suggestions", () => {
	it("finds slash skills and @ files at token boundaries", () => {
		expect(findComposerSuggestion("/rev")).toMatchObject({ kind: "skills", query: "rev", start: 0 });
		expect(findComposerSuggestion("inspect @src/app")).toMatchObject({ kind: "files", query: "src/app" });
		expect(findComposerSuggestion("https://ao.dev")).toBeUndefined();
		expect(findComposerSuggestion("please /review")).toBeUndefined();
		expect(findComposerSuggestion("email@example.com")).toBeUndefined();
	});

	it("replaces only the active token", () => {
		const text = "please inspect @src/ap now";
		const trigger = findComposerSuggestion(text, "please inspect @src/ap".length)!;
		expect(replaceComposerSuggestion(text, trigger, "src/app.ts")).toBe("please inspect src/app.ts now");
	});

	it("quotes paths with spaces and keeps the slash for provider skills", () => {
		expect(replaceComposerSuggestion("open @my", findComposerSuggestion("open @my")!, "my notes/todo.md"))
			.toBe('open "my notes/todo.md" ');
		expect(replaceComposerSuggestion("/rev", findComposerSuggestion("/rev")!, "review"))
			.toBe("/review ");
	});

	it("ranks names and basenames ahead of descriptions and deep paths", () => {
		const skills = [
			{ name: "code-review", displayName: "Code review", description: "Review a change" },
			{ name: "review", displayName: "Review", description: "Inspect code" },
		];
		expect(rankComposerSkills(skills, "rev").map((item) => item.value)).toEqual(["review", "code-review"]);
		expect(rankComposerFiles(["deep/src/app.ts", "app.ts", "docs/application.md"], "app").map((item) => item.value))
			.toEqual(["app.ts", "deep/src/app.ts", "docs/application.md"]);
	});
});
