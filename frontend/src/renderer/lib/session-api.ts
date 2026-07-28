// Per-session API routing. Every renderer→daemon call that targets a specific
// session goes through here so a CLOUD session's actions (kill, send, restart,
// files, reviews, PR, rename, preview) hit ITS sandbox daemon — exactly like a
// local session hits the local daemon. Without this, cloud sessions are
// watch-only; with it, cloud and local behave identically in the UI.
//
// Cloud REST can't be called from the renderer directly: the Daytona preview
// host emits a duplicate Access-Control-Allow-Origin header that browsers reject.
// So a cloud client's fetch is rerouted through the LOCAL daemon's
// /api/v1/cloud/proxy, which performs the call server-side (no CORS). The
// terminal mux stays a direct WebSocket (not subject to CORS).
import createClient from "openapi-fetch";
import type { paths } from "../../api/schema";
import { apiClient } from "./api-client";
import { cloudTargetFor } from "./cloud-sessions";

// One client per (preview URL, shared?) pair (memoized). Shared readonly viewers
// route through /cloud/shared-proxy, which skips the tenant-ownership check the
// owner proxy enforces — so an `ao://share/...` link connects even when the
// viewer isn't the sandbox's owner.
const cloudClients = new Map<string, typeof apiClient>();

function clientForBase(previewUrl: string, shared: boolean): typeof apiClient {
	const key = `${shared ? "shared" : "owned"}:${previewUrl}`;
	let c = cloudClients.get(key);
	if (!c) {
		c = createClient<paths>({
			baseUrl: previewUrl,
			fetch: async (input: Request) => {
				const method = input.method || "GET";
				const u = new URL(input.url);
				const path = u.pathname + u.search;
				let body: unknown;
				const text = await input.clone().text().catch(() => "");
				if (text) {
					try {
						body = JSON.parse(text);
					} catch {
						body = text;
					}
				}
				const endpoint = shared ? "/api/v1/cloud/shared-proxy" : "/api/v1/cloud/proxy";
				const { data } = await apiClient.POST(endpoint, {
					body: { previewUrl, method, path, body },
				});
				const status = data?.status ?? 502;
				const payload = data?.json ?? null;
				return new Response(payload === null ? "" : JSON.stringify(payload), {
					status,
					headers: { "content-type": "application/json" },
				});
			},
		}) as unknown as typeof apiClient;
		cloudClients.set(key, c);
	}
	return c;
}

/**
 * Resolve the correct daemon client + real session id for a board session id.
 * Local session → the global client and the id unchanged. Cloud session (board
 * id `cloud-<sandboxId>` / `shared-<sandboxId>`) → a client bound to its
 * sandbox's preview URL (routed via the proxy) and the sandbox-local session id.
 */
export function sessionApi(boardSessionId: string): { client: typeof apiClient; sessionId: string } {
	const target = cloudTargetFor(boardSessionId);
	if (!target) return { client: apiClient, sessionId: boardSessionId };
	return { client: clientForBase(target.previewUrl, target.shared), sessionId: target.sessionId };
}
