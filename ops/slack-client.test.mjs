import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSlackClient } from "./slack-client.mjs";

describe("slack-client webhook sink (cycle-2 fix)", () => {
	it("throws on a non-ok webhook response so callers can retry", async () => {
		const client = createSlackClient({
			webhook: "http://hook",
			token: undefined,
			channel: undefined,
			fetchImpl: async () => ({ ok: false, status: 429 }),
		});
		await assert.rejects(() => client.postMessage("hi"), /HTTP 429/);
	});

	it("resolves on an ok webhook response", async () => {
		const client = createSlackClient({
			webhook: "http://hook",
			fetchImpl: async () => ({ ok: true, status: 200 }),
		});
		const r = await client.postMessage("hi");
		assert.deepEqual(r, { ts: null, channel: null });
	});

	it("throws when the Web API returns not-ok", async () => {
		const client = createSlackClient({
			token: "t",
			channel: "C",
			fetchImpl: async () => ({ json: async () => ({ ok: false, error: "channel_not_found" }) }),
		});
		await assert.rejects(() => client.postMessage("hi"), /channel_not_found/);
	});
});
