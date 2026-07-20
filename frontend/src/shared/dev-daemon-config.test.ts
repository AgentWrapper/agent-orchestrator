// @vitest-environment node
import { describe, expect, it } from "vitest";
import { devDaemonPort, isDevIsolationEnabled } from "./dev-daemon-config";

describe("dev daemon config", () => {
	it("uses the shared daemon port by default", () => {
		expect(isDevIsolationEnabled({})).toBe(false);
		expect(devDaemonPort({})).toBe(3001);
	});

	it("uses the isolated port only when explicitly enabled", () => {
		expect(isDevIsolationEnabled({ ISOLATE_DEV: "true" })).toBe(true);
		expect(devDaemonPort({ ISOLATE_DEV: "true" })).toBe(3002);
		expect(devDaemonPort({ ISOLATE_DEV: "false" })).toBe(3001);
	});

	it("honors AO_PORT in either mode", () => {
		expect(devDaemonPort({ AO_PORT: "4100" })).toBe(4100);
		expect(devDaemonPort({ ISOLATE_DEV: "true", AO_PORT: "4100" })).toBe(4100);
	});
});
