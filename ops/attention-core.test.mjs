import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	AttentionTracker,
	attentionRecordFromItem,
	attentionRecordsFromProjection,
	renderAlert,
	renderDigest,
	resolveMentionUserId,
	signature,
} from "./attention-core.mjs";

// After the #268/#313 consolidation, attention-core is TRANSPORT ONLY: it no
// longer classifies sessions or notifications into attention. The daemon owns
// that derivation (GET /api/v1/attention/operator). These tests pin the render
// and posting-dedup helpers the notifier reuses.

describe("resolveMentionUserId — SLACK_MEMBER_ID native", () => {
	it("reads SLACK_MEMBER_ID directly", () => {
		assert.equal(resolveMentionUserId({ SLACK_MEMBER_ID: "U1" }), "U1");
	});
	it("prefers SLACK_MEMBER_ID over the legacy alias", () => {
		assert.equal(resolveMentionUserId({ SLACK_MEMBER_ID: "U1", SLACK_MENTION_USER_ID: "U2" }), "U1");
	});
	it("falls back to the legacy alias only when native is unset", () => {
		assert.equal(resolveMentionUserId({ SLACK_MENTION_USER_ID: "U2" }), "U2");
	});
	it("returns empty string when neither is set", () => {
		assert.equal(resolveMentionUserId({}), "");
	});
	it("trims whitespace", () => {
		assert.equal(resolveMentionUserId({ SLACK_MEMBER_ID: "  U3  " }), "U3");
	});
});

function item(overrides = {}) {
	return {
		id: "session:a:decision",
		kind: "decision",
		projectId: "ao",
		sessionId: "a",
		reason: "waiting on an operator decision",
		action: "answer it",
		deepLink: "/projects/ao/sessions/a",
		...overrides,
	};
}

describe("attentionRecordFromItem — projection Item DTO adapter", () => {
	it("maps a projection item to a flat render record marked attention", () => {
		const rec = attentionRecordFromItem(item());
		assert.deepEqual(rec, {
			id: "session:a:decision",
			kind: "decision",
			sessionId: "a",
			projectId: "ao",
			title: "waiting on an operator decision",
			url: "/projects/ao/sessions/a",
			prUrl: "",
			attention: true,
		});
	});
	it("prefers prUrl for the link when there is no deepLink", () => {
		const rec = attentionRecordFromItem(item({ deepLink: "", prUrl: "http://pr/1" }));
		assert.equal(rec.url, "http://pr/1");
	});
	it("keeps prUrl as a separate identity even when deepLink differs (terminal-event resolve)", () => {
		const rec = attentionRecordFromItem(item({ deepLink: "/projects/ao/sessions/a", prUrl: "http://pr/9" }));
		assert.equal(rec.url, "/projects/ao/sessions/a");
		assert.equal(rec.prUrl, "http://pr/9");
	});
	it("falls back to the session title when there is no reason", () => {
		const rec = attentionRecordFromItem(item({ reason: "", sessionTitle: "ao #12 fix" }));
		assert.equal(rec.title, "ao #12 fix");
	});
	it("returns null for a non-object", () => {
		assert.equal(attentionRecordFromItem(null), null);
	});
});

describe("attentionRecordsFromProjection — response mapper", () => {
	it("maps {items:[...]} to render records", () => {
		const recs = attentionRecordsFromProjection({ items: [item(), item({ id: "pr:1:merge", kind: "pr" })] });
		assert.equal(recs.length, 2);
		assert.equal(recs[0].kind, "decision");
		assert.equal(recs[1].kind, "pr");
	});
	it("accepts a bare array too", () => {
		const recs = attentionRecordsFromProjection([item()]);
		assert.equal(recs.length, 1);
	});
	it("returns an empty array for a shapeless payload", () => {
		assert.deepEqual(attentionRecordsFromProjection({}), []);
	});
});

describe("signature — posting-dedup key", () => {
	it("uses the projection item id when present", () => {
		assert.equal(signature(attentionRecordFromItem(item())), "session:a:decision");
	});
	it("falls back to project/session/kind for synthetic records without an id", () => {
		assert.equal(signature({ kind: "main_ci_red", projectId: "ao", sessionId: "main" }), "ao/main#main_ci_red");
	});
});

describe("renderAlert", () => {
	it("@mentions attention records when a member id is configured", () => {
		const msg = renderAlert(attentionRecordFromItem(item()), "U123");
		assert.match(msg, /^<@U123> 🖐️ \*decision\* \[ao\] a: waiting on an operator decision/);
	});
	it("omits the mention when no member id is configured", () => {
		const msg = renderAlert(attentionRecordFromItem(item()), "");
		assert.doesNotMatch(msg, /<@/);
		assert.match(msg, /\*decision\*/);
	});
	it("uses a distinct glyph per kind", () => {
		assert.match(renderAlert(attentionRecordFromItem(item({ kind: "blocked" })), ""), /🚧 \*blocked\*/);
		assert.match(
			renderAlert(attentionRecordFromItem(item({ kind: "parked_sensitive_merge" })), ""),
			/🛑 \*parked_sensitive_merge\*/,
		);
	});
});

describe("renderDigest — 'what needs me' view", () => {
	const now = new Date("2026-07-07T00:00:00Z");
	it("renders an explicit empty state", () => {
		assert.match(renderDigest([], { now }), /Nothing needs you/);
	});
	it("aggregates pending records across projects with reasons", () => {
		const recs = [
			attentionRecordFromItem(item()),
			attentionRecordFromItem(
				item({ id: "n:mainci", kind: "main_ci_red", projectId: "cc", sessionId: "main", reason: "main is red" }),
			),
		];
		const out = renderDigest(recs, { now });
		assert.match(out, /2 things need you/);
		assert.match(out, /\*ao\*/);
		assert.match(out, /\*cc\*/);
		assert.match(out, /waiting on an operator decision/);
		assert.match(out, /main is red/);
	});
	it("excludes non-attention records from the digest", () => {
		const out = renderDigest([{ kind: "decision", projectId: "ao", sessionId: "a", attention: false }], { now });
		assert.match(out, /Nothing needs you/);
	});
	it("uses singular phrasing for exactly one record", () => {
		assert.match(renderDigest([attentionRecordFromItem(item())], { now }), /1 thing needs you/);
	});
});

describe("AttentionTracker — posting dedup / resolve ledger", () => {
	const rec = () => attentionRecordFromItem(item());

	it("isOpen is false until markOpen commits the signature", () => {
		const t = new AttentionTracker();
		assert.equal(t.isOpen(rec()), false);
		t.markOpen(rec());
		assert.equal(t.isOpen(rec()), true);
	});

	it("markOpen ignores non-attention records", () => {
		const t = new AttentionTracker();
		t.markOpen({ id: "x", kind: "decision", attention: false });
		assert.equal(t.isOpen({ id: "x" }), false);
	});

	it("reconcile resolves records no longer present and keeps still-pending ones", () => {
		const t = new AttentionTracker();
		const a = rec();
		const b = attentionRecordFromItem(item({ id: "pr:1:merge", kind: "pr", sessionId: "b" }));
		t.markOpen(a);
		t.markOpen(b);
		const resolved = t.reconcile([a]); // b is gone
		assert.deepEqual(
			resolved.map((r) => r.id),
			["pr:1:merge"],
		);
		assert.equal(t.isOpen(a), true);
		assert.equal(t.isOpen(b), false);
	});

	it("re-alerts (re-opens) after a record resolves and re-enters", () => {
		const t = new AttentionTracker();
		t.markOpen(rec());
		t.reconcile([]); // resolved away
		assert.equal(t.isOpen(rec()), false);
		t.markOpen(rec());
		assert.equal(t.isOpen(rec()), true);
	});

	it("serialize/deserialize restores open signatures across a restart", () => {
		const t = new AttentionTracker();
		t.markOpen(rec());
		const restored = AttentionTracker.deserialize(t.serialize());
		assert.equal(restored.isOpen(rec()), true);
	});

	it("a reconciled-away record does re-alert after restart", () => {
		const t = new AttentionTracker();
		t.markOpen(rec());
		t.reconcile([]);
		const restored = AttentionTracker.deserialize(t.serialize());
		assert.equal(restored.isOpen(rec()), false);
	});

	it("deserialize tolerates malformed input", () => {
		assert.doesNotThrow(() => AttentionTracker.deserialize("not json"));
		assert.doesNotThrow(() => AttentionTracker.deserialize({}));
	});
});

describe("escapeMrkdwn — Slack control characters in projection-controlled text", async () => {
	const { escapeMrkdwn } = await import("./attention-core.mjs");

	it("escapes &, < and >", () => {
		assert.equal(escapeMrkdwn("a & <b> > c"), "a &amp; &lt;b&gt; &gt; c");
	});

	it("renderAlert cannot be injected with a fake mention via the reason field", () => {
		const rec = attentionRecordFromItem(item({ reason: "<@U999> pwned & <http://evil|click>" }));
		const msg = renderAlert(rec, "U123");
		assert.doesNotMatch(msg, /<@U999>/);
		assert.match(msg, /&lt;@U999&gt;/);
		assert.match(msg, /^<@U123> /); // the legitimate mention survives
	});

	it("renderDigest escapes reason and URL fields", () => {
		const rec = attentionRecordFromItem(item({ reason: "a & b", deepLink: "http://x/?a=1&b=<2>" }));
		const out = renderDigest([rec], { now: new Date("2026-07-07T00:00:00Z") });
		assert.match(out, /a &amp; b/);
		assert.match(out, /<http:\/\/x\/\?a=1&amp;b=&lt;2&gt;\|link>/);
	});
});

describe("canonicalPrKey — mirrors the daemon's PR identity normalization", async () => {
	const { canonicalPrKey } = await import("./attention-core.mjs");

	it("matches the shared cross-language contract table (canonical-pr-key-fixtures.json)", async () => {
		// The SAME fixture file drives the Go test
		// (backend/internal/service/attention TestCanonicalPRKey), so the two
		// parsers cannot drift.
		const { readFile } = await import("node:fs/promises");
		const cases = JSON.parse(await readFile(new URL("./canonical-pr-key-fixtures.json", import.meta.url), "utf8"));
		assert.ok(cases.length > 0, "shared fixture table is empty");
		for (const { in: input, want } of cases) {
			assert.equal(canonicalPrKey(input), want, `canonicalPrKey(${JSON.stringify(input)})`);
		}
	});
});
