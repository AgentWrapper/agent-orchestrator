import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderTerminal } from "./what-needs-me.mjs";

describe("what-needs-me terminal view (acceptance #3)", () => {
	const now = new Date("2026-07-07T00:00:00Z");

	it("shows an explicit empty state", () => {
		const out = renderTerminal({ sessions: [] }, { now });
		assert.match(out, /Nothing needs you/);
	});

	it("aggregates pending sessions across projects with reasons", () => {
		const out = renderTerminal(
			{
				sessions: [
					{ id: "a", projectId: "ao", activity: { state: "waiting_input" } },
					{ id: "b", projectId: "ao", activity: { state: "active" } },
					{ id: "c", projectId: "cc", activity: { state: "blocked" }, prs: [{ url: "http://pr/1" }] },
				],
			},
			{ now },
		);
		assert.match(out, /2 things need your attention/);
		assert.match(out, /ao:/);
		assert.match(out, /cc:/);
		assert.match(out, /a — needs_input/);
		assert.match(out, /c — blocked/);
		assert.match(out, /http:\/\/pr\/1/);
		assert.doesNotMatch(out, /\bb\b —/);
	});

	it("uses singular phrasing for one item", () => {
		const out = renderTerminal(
			{ sessions: [{ id: "a", projectId: "ao", activity: { state: "waiting_input" } }] },
			{ now },
		);
		assert.match(out, /1 thing needs your attention/);
	});
});
