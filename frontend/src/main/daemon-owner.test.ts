// @vitest-environment node
import { describe, it, expect } from "vitest";
import { shouldLinkOnAttach } from "./daemon-owner";

describe("shouldLinkOnAttach", () => {
	it('returns true when owner is "app"', () => {
		expect(shouldLinkOnAttach("app")).toBe(true);
	});

	it("returns false when owner is undefined (headless ao start)", () => {
		expect(shouldLinkOnAttach(undefined)).toBe(false);
	});

	it('returns false when owner is "" (empty string)', () => {
		expect(shouldLinkOnAttach("")).toBe(false);
	});

	it('returns false when owner is "cli"', () => {
		expect(shouldLinkOnAttach("cli")).toBe(false);
	});
});
