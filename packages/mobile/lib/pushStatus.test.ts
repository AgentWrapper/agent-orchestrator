import { describe, expect, it } from "vitest";
import { classifyServerFailure, describePush, describeRegisterFailure, hasServer, type PushStatus } from "./pushStatus";

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

	// Regression: the unpaired guard was only on the Register branch, so a fresh
	// install — permission never asked, no host — still got an Enable button that
	// spent the one-shot OS prompt and then failed against an empty host.
	it("does NOT offer Enable when unpaired", () => {
		const d = describePush(status({ granted: false, canAskAgain: true }), { host: "" });
		expect(d.action).toBeNull();
		expect(d.actionLabel).toBeNull();
		expect(d.hint).toMatch(/connect to your ao server first/i);
	});

	// A permanent denial can only be undone in system settings, and that is true
	// whether or not a server is configured — so this one stays offered.
	it("still offers Open settings when unpaired and permanently denied", () => {
		const d = describePush(status({ granted: false, canAskAgain: false }), { host: "" });
		expect(d.action).toBe("open-settings");
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

describe("classifyServerFailure", () => {
	// Only a request that never got an answer is genuinely "unreachable".
	it("reports unreachable only when there was no response at all", () => {
		expect(classifyServerFailure(undefined)).toBe("server-unreachable");
	});

	it("separates auth rejection, rate limiting, and other error statuses", () => {
		expect(classifyServerFailure(401)).toBe("server-auth");
		expect(classifyServerFailure(403)).toBe("server-auth");
		expect(classifyServerFailure(429)).toBe("server-rate-limited");
		expect(classifyServerFailure(500)).toBe("server-error");
		expect(classifyServerFailure(404)).toBe("server-error");
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

	// Regression: every non-2xx answer used to funnel into "server-unreachable",
	// telling someone with a wrong password to go check their network.
	it("does not claim the server was unreachable when it answered and rejected us", () => {
		for (const reason of ["server-auth", "server-rate-limited", "server-error"] as const) {
			const { title, message } = describeRegisterFailure(reason, "ios");
			expect(`${title} ${message}`).not.toMatch(/couldn't reach/i);
		}
	});

	it("points at the password when the server rejected the credentials", () => {
		const { message } = describeRegisterFailure("server-auth", "ios");
		expect(message).toMatch(/password/i);
	});

	it("names the HTTP status when the server errored, and omits it when unknown", () => {
		expect(describeRegisterFailure("server-error", "ios", 500).message).toMatch(/HTTP 500/);
		expect(describeRegisterFailure("server-error", "ios").message).not.toMatch(/HTTP/);
	});

	it("tells an unpaired user to connect rather than blaming the build or network", () => {
		const { title, message } = describeRegisterFailure("not-configured", "ios");
		expect(title).toMatch(/connect to your ao server/i);
		expect(`${title} ${message}`).not.toMatch(/entitlement|couldn't reach/i);
	});

	it("covers the remaining reasons with a usable message", () => {
		for (const reason of ["no-project-id", "unsupported"] as const) {
			const { title, message } = describeRegisterFailure(reason, "ios");
			expect(title.length).toBeGreaterThan(0);
			expect(message.length).toBeGreaterThan(0);
		}
	});
});
