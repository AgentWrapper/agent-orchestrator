import { describe, expect, it } from "vitest";
import { defaultCloudDevSettings } from "../stores/ui-store";
import { cloudDevTerminalMuxURL } from "./cloud-dev";

describe("cloud dev terminal mux", () => {
	it("derives an authenticated websocket URL from the cloud API base", () => {
		const url = new URL(
			cloudDevTerminalMuxURL({
				...defaultCloudDevSettings,
				apiBaseUrl: "http://127.0.0.1:3022/",
				accessToken: "dev-token",
				orgId: "org-1",
			}),
		);

		expect(url.protocol).toBe("ws:");
		expect(url.host).toBe("127.0.0.1:3022");
		expect(url.pathname).toBe("/mux");
		expect(url.searchParams.get("access_token")).toBe("dev-token");
		expect(url.searchParams.get("org_id")).toBe("org-1");
	});
});
