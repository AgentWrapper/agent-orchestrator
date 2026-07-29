// LIVE end-to-end test of the renderer's own networking path against the hosted
// control plane on Azure. Unlike api-client.test.ts (which mocks fetch), this
// drives the REAL api-client module with REAL fetch: it sets the control-plane
// URL + a real Clerk bearer and confirms a `/api/v1/cloud/*` call is rebased to
// Azure, authenticated, and answered. Gated on env so normal runs skip it:
//
//   AO_CONTROL_PLANE_URL=https://<fqdn> AO_TEST_CLERK_JWT=<jwt> \
//     npx vitest run --config vite.renderer.config.ts src/renderer/lib/api-client.live.test.ts
import { describe, expect, it } from "vitest";
import { apiClient, setApiBaseUrl, setCloudAuthTokenGetter, setControlPlaneBaseUrl } from "./api-client";

const CP = process.env.AO_CONTROL_PLANE_URL;
const JWT = process.env.AO_TEST_CLERK_JWT;
const live = Boolean(CP && JWT);

describe("LIVE control plane via the real api-client", () => {
	it.runIf(live)("rebases cloud calls to Azure + attaches the Clerk bearer → 200 capabilities", async () => {
		setApiBaseUrl("http://127.0.0.1:3001"); // daemon base for local calls (unused here)
		setControlPlaneBaseUrl(CP as string);
		setCloudAuthTokenGetter(async () => JWT as string);

		const { data, response } = await apiClient.GET("/api/v1/cloud/capabilities");
		expect(response.status).toBe(200);
		expect(data).toMatchObject({ configured: true });

		// tenant-scoped list also answers (empty for a fresh throwaway user)
		const list = await apiClient.GET("/api/v1/cloud/sessions");
		expect(list.response.status).toBe(200);
	});

	it.runIf(live)("rejects the same cloud call with no bearer → 401", async () => {
		setControlPlaneBaseUrl(CP as string);
		setCloudAuthTokenGetter(async () => null); // signed out
		const { response } = await apiClient.GET("/api/v1/cloud/capabilities");
		expect(response.status).toBe(401);
	});

	it.skipIf(live)("skipped — set AO_CONTROL_PLANE_URL + AO_TEST_CLERK_JWT to run live", () => {
		expect(true).toBe(true);
	});
});
