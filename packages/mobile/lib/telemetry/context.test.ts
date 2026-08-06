import { describe, expect, it } from "vitest";
import { buildMobileContext, MOBILE_TELEMETRY_SCHEMA_VERSION } from "./context";

describe("buildMobileContext", () => {
	it("tags the native app as client=mobile with the OS platform", () => {
		const ctx = buildMobileContext({ platformOS: "ios", isPhysicalDevice: true, dev: false, appVersion: "1.1.0" });
		expect(ctx.client).toBe("mobile");
		expect(ctx.platform).toBe("ios");
		expect(ctx.build_mode).toBe("device");
		expect(ctx.app_version).toBe("1.1.0");
		expect(ctx.telemetry_schema_version).toBe(MOBILE_TELEMETRY_SCHEMA_VERSION);
	});

	// The bifurcation the ask named: the web build must not count as a native app.
	it("tags the web build as client=mobile-web", () => {
		const ctx = buildMobileContext({ platformOS: "web", isPhysicalDevice: false, dev: false, appVersion: "1.1.0" });
		expect(ctx.client).toBe("mobile-web");
		expect(ctx.platform).toBe("web");
	});

	it("distinguishes dev, simulator, and device builds", () => {
		expect(buildMobileContext({ platformOS: "android", isPhysicalDevice: true, dev: true, appVersion: "x" }).build_mode).toBe("dev");
		expect(buildMobileContext({ platformOS: "android", isPhysicalDevice: false, dev: false, appVersion: "x" }).build_mode).toBe("simulator");
		expect(buildMobileContext({ platformOS: "android", isPhysicalDevice: true, dev: false, appVersion: "x" }).build_mode).toBe("device");
	});

	it("falls back to platform=other and version=unknown for junk input", () => {
		const ctx = buildMobileContext({ platformOS: "windows", isPhysicalDevice: true, dev: false, appVersion: "   " });
		expect(ctx.platform).toBe("other");
		expect(ctx.app_version).toBe("unknown");
	});
});
