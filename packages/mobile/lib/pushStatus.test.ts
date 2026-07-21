import { describe, expect, it } from "vitest";
import { describePush, describeRegisterFailure, hasServer, type PushStatus } from "./pushStatus";

const status = (over: Partial<PushStatus> = {}): PushStatus => ({
	supported: true,
	granted: true,
	canAskAgain: true,
	registered: false,
	...over,
});

describe("describePush", () => {
	it("shows a neutral placeholder before status loads", () => {
		const d = describePush(null, { host: "192.168.1.5" });
		expect(d.action).toBeNull();
		expect(d.label).toBe("Checking…");
	});

	it("offers nothing on a simulator", () => {
		const d = describePush(status({ supported: false }), { host: "192.168.1.5" });
		expect(d.action).toBeNull();
		expect(d.label).toBe("Not available");
	});

	it("reports On with no action once granted and registered", () => {
		const d = describePush(status({ registered: true }), { host: "192.168.1.5" });
		expect(d.action).toBeNull();
		expect(d.label).toBe("On");
	});

	// Regression: an unpaired app still has a default config with an empty host.
	// Offering Register there always fails, which is what shipped to testers.
	it("does NOT offer Register when the config exists but has no host (unpaired)", () => {
		// This is the exact shape an unpaired app holds: a real config object with
		// an empty host. Passing `!!config` here (truthy!) is what shipped a
		// broken Register button to TestFlight users.
		const d = describePush(status({ granted: true, registered: false }), { host: "" });
		expect(d.action).toBeNull();
		expect(d.actionLabel).toBeNull();
		expect(d.hint).toMatch(/connect to your ao server first/i);
	});

	it("offers Register once a server host is set", () => {
		const d = describePush(status({ granted: true, registered: false }), { host: "192.168.1.5" });
		expect(d.action).toBe("register");
		expect(d.actionLabel).toBe("Register");
	});

	it("offers Enable when permission has not been asked yet", () => {
		const d = describePush(status({ granted: false, canAskAgain: true }), { host: "192.168.1.5" });
		expect(d.action).toBe("enable");
	});

	it("offers Open settings after a permanent denial", () => {
		const d = describePush(status({ granted: false, canAskAgain: false }), { host: "192.168.1.5" });
		expect(d.action).toBe("open-settings");
	});
});

describe("hasServer", () => {
	it("treats a missing, empty, or whitespace host as no server", () => {
		expect(hasServer(null)).toBe(false);
		expect(hasServer(undefined)).toBe(false);
		expect(hasServer({})).toBe(false);
		expect(hasServer({ host: "" })).toBe(false);
		expect(hasServer({ host: "   " })).toBe(false);
	});

	it("treats a real host as a server", () => {
		expect(hasServer({ host: "192.168.1.5" })).toBe(true);
	});
});

describe("describeRegisterFailure", () => {
	// Regression: a TestFlight user whose server was simply unreachable was told
	// their build "has no push entitlement", which was false and alarming.
	it("blames the server, not the build, when the daemon is unreachable", () => {
		const { title, message } = describeRegisterFailure("server-unreachable", "ios");
		expect(title).toMatch(/couldn't reach your ao server/i);
		expect(`${title} ${message}`).not.toMatch(/entitlement/i);
	});

	it("explains the missing entitlement only when the token itself failed on iOS", () => {
		const { message } = describeRegisterFailure("token-failed", "ios");
		expect(message).toMatch(/entitlement/i);
		expect(message).toMatch(/testflight/i);
	});

	it("does not mention iOS entitlements on Android", () => {
		const { message } = describeRegisterFailure("token-failed", "android");
		expect(message).not.toMatch(/entitlement/i);
	});

	it("points at system settings when permission was denied", () => {
		const { message } = describeRegisterFailure("denied", "ios");
		expect(message).toMatch(/system settings/i);
	});

	it("covers the remaining reasons with a usable message", () => {
		for (const reason of ["no-project-id", "unsupported"] as const) {
			const { title, message } = describeRegisterFailure(reason, "ios");
			expect(title.length).toBeGreaterThan(0);
			expect(message.length).toBeGreaterThan(0);
		}
	});
});
