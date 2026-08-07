import { describe, expect, it } from "vitest";
import { caretNotation, commandOutputText, stripAnsi } from "./ansi";

describe("mobile Chat terminal text", () => {
	it("removes ANSI and applies carriage-return redraws", () => {
		expect(stripAnsi("\x1b[32mok\x1b[0m 12%\rready")).toBe("ready%");
	});

	it("reads structured historical output without crashing", () => {
		expect(commandOutputText({ metadata: { text: "done" } })).toBe("done");
		expect(commandOutputText(null)).toBe("");
	});

	it("keeps terminal input meaningful", () => {
		expect(caretNotation("\x03\n")).toBe("^C\n");
	});
});
