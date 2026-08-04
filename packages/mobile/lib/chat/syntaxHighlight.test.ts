import { describe, expect, it } from "vitest";
import { highlightCode } from "./syntaxHighlight";

describe("mobile Chat syntax highlighting", () => {
	it("tokenizes known coding languages without changing the source", () => {
		const code = 'const answer: Result = "yes"; // note';
		const tokens = highlightCode(code, "typescript")!;
		expect(tokens.map((token) => token.text).join("")).toBe(code);
		expect(tokens).toEqual(expect.arrayContaining([
			expect.objectContaining({ text: "const", kind: "keyword" }),
			expect.objectContaining({ text: "Result", kind: "type" }),
			expect.objectContaining({ text: '"yes"', kind: "string" }),
			expect.objectContaining({ text: "// note", kind: "comment" }),
		]));
	});

	it("colors diffs structurally and leaves unknown languages plain", () => {
		expect(highlightCode("+added\n-removed\n", "diff")?.map((token) => token.kind)).toEqual(["addition", "deletion"]);
		expect(highlightCode("opaque", "made-up-language")).toBeUndefined();
	});
});
