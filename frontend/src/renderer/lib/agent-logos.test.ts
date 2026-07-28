import { describe, expect, it } from "vitest";
import { agentLogoProviders, getAgentLogo } from "./agent-logos";

describe("agent-logos", () => {
	it("resolves a mark for every registered harness", () => {
		for (const provider of agentLogoProviders()) {
			const logo = getAgentLogo(provider);
			expect(logo, provider).toBeDefined();
			expect(logo?.src, provider).toBeTruthy();
		}
	});

	it("returns undefined for a harness AO ships no mark for, so the caller can letter it", () => {
		expect(getAgentLogo("agy")).toBeUndefined();
		expect(getAgentLogo("")).toBeUndefined();
	});

	it("paints single-colour marks with currentColor rather than baking a theme in", () => {
		// These marks are one colour in the source asset, so drawing them directly
		// would lose them against one of the two boards.
		for (const provider of ["cursor", "opencode", "grok", "kimi", "pi", "continue"]) {
			expect(getAgentLogo(provider)?.paint, provider).toBe("mono");
		}
	});

	it("draws marks that carry their own palette as-is", () => {
		// Orange, a gradient and a two-tone greyscale all survive both themes, and
		// flattening them to one colour would throw away the brand.
		for (const provider of ["claude-code", "codex", "aider", "droid"]) {
			expect(getAgentLogo(provider)?.paint, provider).toBe("colour");
		}
	});
});
