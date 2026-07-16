// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveRemoteClientBuild } from "./remote-client-build";

describe("resolveRemoteClientBuild", () => {
	it("allows the environment override only in development", () => {
		expect(resolveRemoteClientBuild({ isPackaged: false, envOverride: true, markerExists: false })).toBe(true);
		expect(resolveRemoteClientBuild({ isPackaged: true, envOverride: true, markerExists: false })).toBe(false);
	});

	it("selects a packaged remote build only from its resource marker", () => {
		expect(resolveRemoteClientBuild({ isPackaged: true, envOverride: false, markerExists: true })).toBe(true);
		expect(resolveRemoteClientBuild({ isPackaged: true, envOverride: false, markerExists: false })).toBe(false);
	});
});
