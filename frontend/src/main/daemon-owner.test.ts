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

	// Cross-launch regression (PR #2231 review): a daemon spawned with
	// AO_KEEP_DAEMON is stamped owner:"persistent" in running.json. A LATER
	// launch of the app — which may have AO_KEEP_DAEMON unset — must NOT
	// re-establish the supervisor link from that durable owner, or closing the
	// second instance would kill the supposedly-persistent daemon. The decision
	// is read only from the daemon's record, never from the current process env.
	it("does NOT re-link a persistent daemon on attach, even when AO_KEEP_DAEMON is unset now", () => {
		expect(shouldLinkOnAttach("persistent")).toBe(false);
	});
});

describe("keepDaemonAlive", () => {
	it("returns false when AO_KEEP_DAEMON is unset", () => {
		expect(keepDaemonAlive({})).toBe(false);
	});

	it("returns false when AO_KEEP_DAEMON is empty", () => {
		expect(keepDaemonAlive({ AO_KEEP_DAEMON: "" })).toBe(false);
	});

	it.each(["1", "true", "TRUE", "yes", "on", "ON", "Yes"])("returns true for truthy value %j", (value) => {
		expect(keepDaemonAlive({ AO_KEEP_DAEMON: value })).toBe(true);
	});

	// Explicit allowlist (PR #2231 review): conventional falsy values and any
	// unrecognized string must NOT retain the daemon — "off"/"no" previously
	// fell through the old "anything but 0/false" check and kept it alive.
	it.each(["0", "false", "FALSE", "off", "OFF", "no", "No"])("returns false for conventional off value %j", (value) => {
		expect(keepDaemonAlive({ AO_KEEP_DAEMON: value })).toBe(false);
	});

	it.each(["2", "random", "yep", "disable"])(
		"returns false for unrecognized value %j (allowlist, not truthiness)",
		(value) => {
			expect(keepDaemonAlive({ AO_KEEP_DAEMON: value })).toBe(false);
		},
	);

	it("trims surrounding whitespace before evaluating", () => {
		expect(keepDaemonAlive({ AO_KEEP_DAEMON: "  0  " })).toBe(false);
		expect(keepDaemonAlive({ AO_KEEP_DAEMON: "  1  " })).toBe(true);
	});
});
