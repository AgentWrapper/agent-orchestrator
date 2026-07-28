import { describe, expect, it } from "vitest";
import { isAoPreviewHostname, isLoopbackHostname } from "./loopback";

describe("loopback hostnames", () => {
	it.each(["localhost", "app.localhost", "127.0.0.1", "::1", "[::1]"])("recognizes %s as loopback", (hostname) => {
		expect(isLoopbackHostname(hostname)).toBe(true);
	});

	it("recognizes AO's isolated preview hostname", () => {
		expect(isAoPreviewHostname("ao-preview.mftwk3tu.localhost")).toBe(true);
		expect(isAoPreviewHostname("app.localhost")).toBe(false);
		expect(isAoPreviewHostname("localhost")).toBe(false);
	});
});
