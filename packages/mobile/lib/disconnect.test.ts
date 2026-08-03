import { beforeEach, describe, expect, it, vi } from "vitest";

// The modules under the seam all reach into native storage, so they're mocked
// out: what's worth asserting here is the order and completeness of the steps,
// not their implementations (which have their own coverage).
const calls: string[] = [];
// Lets a test make the push step fail the way a SecureStore write can.
let unregisterThrows: Error | null = null;

vi.mock("./push", () => ({
	unregisterFromPush: vi.fn(async () => {
		calls.push("unregisterFromPush");
		if (unregisterThrows) throw unregisterThrows;
	}),
}));
vi.mock("./config", () => ({
	clearConfig: vi.fn(async () => {
		calls.push("clearConfig");
	}),
}));
vi.mock("./onboardingStore", () => ({
	clearOnboardingSkipped: vi.fn(async () => {
		calls.push("clearOnboardingSkipped");
	}),
}));

const { forgetServer } = await import("./disconnect");

describe("forgetServer", () => {
	beforeEach(() => {
		calls.length = 0;
		unregisterThrows = null;
	});

	// Clearing only the config would leave the daemon still pushing to this
	// device, and leave the password behind in the keystore.
	it("unregisters push, clears the config, and re-arms onboarding", async () => {
		await forgetServer();
		expect(calls).toEqual(["unregisterFromPush", "clearConfig", "clearOnboardingSkipped"]);
	});

	// The unregister needs credentials that clearConfig would otherwise destroy,
	// so the ordering is load-bearing, not incidental.
	it("unregisters before the credentials are thrown away", async () => {
		await forgetServer();
		expect(calls.indexOf("unregisterFromPush")).toBeLessThan(calls.indexOf("clearConfig"));
	});

	// unregisterFromPush catches its own network failures, but its SecureStore
	// writes are unguarded. A throw there used to abort the disconnect with the
	// host and password still on disk — the phone looked disconnected and was not.
	it("still clears credentials when the push step throws", async () => {
		unregisterThrows = new Error("SecureStore unavailable");
		await expect(forgetServer()).rejects.toThrow("SecureStore unavailable");
		expect(calls).toContain("clearConfig");
		expect(calls).toContain("clearOnboardingSkipped");
	});
});
