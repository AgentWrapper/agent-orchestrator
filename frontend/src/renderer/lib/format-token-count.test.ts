import { describe, expect, it } from "vitest";
import { formatTokenCount } from "./format-token-count";

describe("formatTokenCount", () => {
	it.each([
		[0, "0 tok"],
		[999, "999 tok"],
		[1_000, "1K tok"],
		[12_400, "12.4K tok"],
		[1_250_000, "1.3M tok"],
	])("formats %d as %s", (tokens, expected) => {
		expect(formatTokenCount(tokens)).toBe(expected);
	});
});
