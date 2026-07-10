// @vitest-environment node
import { describe, it, expect } from "vitest";
import { keepDaemonAlive, shouldLinkOnAttach } from "./daemon-owner";

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

	it("returns false for an app-owned daemon when AO_KEEP_DAEMON is set", () => {
		expect(shouldLinkOnAttach("app", { AO_KEEP_DAEMON: "1" })).toBe(false);
	});

	it("still returns true for an app-owned daemon when AO_KEEP_DAEMON is unset", () => {
		expect(shouldLinkOnAttach("app", {})).toBe(true);
	});

	it('returns false for an app-owned daemon when AO_KEEP_DAEMON is "0" (off)', () => {
		expect(shouldLinkOnAttach("app", { AO_KEEP_DAEMON: "0" })).toBe(true);
	});
});

describe("keepDaemonAlive", () => {
	it("returns false when AO_KEEP_DAEMON is unset", () => {
		expect(keepDaemonAlive({})).toBe(false);
	});

	it("returns false when AO_KEEP_DAEMON is empty", () => {
		expect(keepDaemonAlive({ AO_KEEP_DAEMON: "" })).toBe(false);
	});

	it.each(["1", "true", "TRUE", "yes", "on"])("returns true for truthy value %j", (value) => {
		expect(keepDaemonAlive({ AO_KEEP_DAEMON: value })).toBe(true);
	});

	it.each(["0", "false", "FALSE"])("returns false for explicit off value %j", (value) => {
		expect(keepDaemonAlive({ AO_KEEP_DAEMON: value })).toBe(false);
	});

	it("trims surrounding whitespace before evaluating", () => {
		expect(keepDaemonAlive({ AO_KEEP_DAEMON: "  0  " })).toBe(false);
		expect(keepDaemonAlive({ AO_KEEP_DAEMON: "  1  " })).toBe(true);
	});
});
