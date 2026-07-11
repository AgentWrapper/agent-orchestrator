import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	AttentionTracker,
	attentionFromMainCI,
	attentionFromMainCIRecords,
	normalizeEvent,
	renderAlert,
	renderDigest,
	resolveMentionUserId,
	signature,
	touchesSensitivePath,
} from "./attention-core.mjs";

describe("resolveMentionUserId — SLACK_MEMBER_ID native (acceptance #4)", () => {
	it("reads SLACK_MEMBER_ID directly", () => {
		assert.equal(resolveMentionUserId({ SLACK_MEMBER_ID: "U_NATIVE" }), "U_NATIVE");
	});
	it("prefers SLACK_MEMBER_ID over the legacy alias", () => {
		assert.equal(resolveMentionUserId({ SLACK_MEMBER_ID: "U_NATIVE", SLACK_MENTION_USER_ID: "U_OLD" }), "U_NATIVE");
	});
	it("falls back to the legacy alias only when native is unset", () => {
		assert.equal(resolveMentionUserId({ SLACK_MENTION_USER_ID: "U_OLD" }), "U_OLD");
	});
	it("returns empty string when neither is set", () => {
		assert.equal(resolveMentionUserId({}), "");
	});
	it("trims whitespace", () => {
		assert.equal(resolveMentionUserId({ SLACK_MEMBER_ID: "  U_TRIM  " }), "U_TRIM");
	});
});

describe("normalizeEvent", () => {
	it("normalizes a needs_input notification as an attention event", () => {
		const rec = normalizeEvent({
			type: "needs_input",
			notification: { sessionId: "agent-1", projectId: "ao", message: "permission prompt" },
		});
		assert.deepEqual(rec, {
			kind: "needs_input",
			sessionId: "agent-1",
			projectId: "ao",
			title: "permission prompt",
			url: "",
			attention: true,
		});
	});

	it("treats a park-shaped payload as blocked attention", () => {
		const rec = normalizeEvent({
			type: "queue_update",
			payload: { sessionId: "agent-3", projectId: "ao", message: "Parked awaiting operator decision" },
		});
		assert.equal(rec.kind, "blocked");
		assert.equal(rec.attention, true);
	});

	it("classifies ready_to_merge on a sensitive path as parked_sensitive_merge (attention)", () => {
		const rec = normalizeEvent(
			{
				type: "ready_to_merge",
				notification: { sessionId: "agent-9", projectId: "ao", title: "PR ready", prUrl: "http://pr/9" },
			},
			{ sensitivePaths: ["backend/internal/daemon/manager.go"] },
		);
		assert.equal(rec.kind, "parked_sensitive_merge");
		assert.equal(rec.attention, true);
	});

	it("classifies ready_to_merge on a non-sensitive path as routine (no attention)", () => {
		const rec = normalizeEvent(
			{
				type: "ready_to_merge",
				notification: { sessionId: "agent-9", projectId: "ao", title: "PR ready", prUrl: "http://pr/9" },
			},
			{ sensitivePaths: ["ops/attention-core.mjs"] },
		);
		assert.equal(rec.kind, "ready_to_merge");
		assert.equal(rec.attention, false);
	});

	it("keeps pr_merged as informational (no attention)", () => {
		const rec = normalizeEvent({
			type: "pr_merged",
			notification: { sessionId: "agent-4", projectId: "ao", title: "merged" },
		});
		assert.equal(rec.attention, false);
	});

	it("normalizes a red main notification as needs-response attention", () => {
		const rec = normalizeEvent({
			type: "main_ci_red",
			notification: {
				projectId: "ao",
				title: "main is red at fee462ed: go, cli-e2e",
				sha: "fee462ed",
				failedJobs: ["go", "cli-e2e"],
				url: "https://github.example/actions/runs/1",
			},
		});
		assert.deepEqual(rec, {
			kind: "main_ci_red",
			sessionId: "main",
			projectId: "ao",
			title: "main is red at fee462ed: go, cli-e2e",
			url: "https://github.example/actions/runs/1",
			attention: true,
		});
	});

	it("returns null for uninteresting events", () => {
		assert.equal(normalizeEvent({ type: "pr_check_recorded", payload: { name: "backend" } }), null);
		assert.equal(normalizeEvent(null), null);
	});
});

describe("touchesSensitivePath", () => {
	it("matches each sensitive prefix", () => {
		assert.equal(touchesSensitivePath(["backend/internal/daemon/x.go"]), true);
		assert.equal(touchesSensitivePath(["backend/internal/session_manager/x.go"]), true);
		assert.equal(touchesSensitivePath(["backend/internal/lifecycle/x.go"]), true);
	});
	it("does not match ops-only diffs", () => {
		assert.equal(touchesSensitivePath(["ops/x.mjs", "frontend/y.ts"]), false);
		assert.equal(touchesSensitivePath([]), false);
	});
});

describe("renderAlert", () => {
	it("@mentions attention events when a member id is configured", () => {
		const rec = normalizeEvent({
			type: "needs_input",
			notification: { sessionId: "agent-1", projectId: "ao", message: "permission prompt" },
		});
		assert.equal(renderAlert(rec, "U123"), "<@U123> 🖐️ *needs_input* [ao] agent-1: permission prompt");
	});
	it("does not @mention informational events", () => {
		const rec = normalizeEvent({
			type: "pr_merged",
			notification: { sessionId: "agent-4", projectId: "ao", title: "merged" },
		});
		assert.equal(renderAlert(rec, "U123"), "🚀 *pr_merged* [ao] agent-4: merged");
	});
	it("omits the mention when no member id is configured", () => {
		const rec = normalizeEvent({
			type: "needs_input",
			notification: { sessionId: "agent-5", projectId: "ao", message: "question" },
		});
		assert.equal(renderAlert(rec, ""), "🖐️ *needs_input* [ao] agent-5: question");
	});
});

describe("AttentionTracker — dedup (acceptance #1, #2)", () => {
	const mk = (session, kind = "needs_input", project = "ao") => ({
		kind,
		sessionId: session,
		projectId: project,
		title: "",
		url: "",
		attention: true,
	});

	it("alerts once per new signature, not on repeat of the same state", () => {
		const t = new AttentionTracker();
		assert.equal(t.observe(mk("a")).alert, true);
		assert.equal(t.observe(mk("a")).alert, false);
		assert.equal(t.observe(mk("a")).alert, false);
	});

	it("alerts on a genuinely new transition (same session, different kind)", () => {
		const t = new AttentionTracker();
		assert.equal(t.observe(mk("a", "needs_input")).alert, true);
		assert.equal(t.observe(mk("a", "blocked")).alert, true);
	});

	it("dedupes by stable notification id across replay/reconnect", () => {
		const t = new AttentionTracker();
		assert.equal(t.observe(mk("a"), "ntf_1").alert, true);
		assert.equal(t.observe(mk("a"), "ntf_1").alert, false); // replayed same id
	});

	it("re-alerts after a state resolves and re-enters", () => {
		const t = new AttentionTracker();
		assert.equal(t.observe(mk("a")).alert, true);
		const resolved = t.reconcile([]); // 'a' no longer pending -> resolved
		assert.equal(resolved.length, 1);
		assert.equal(t.observe(mk("a")).alert, true); // re-entry alerts again
	});

	it("reconcile keeps still-pending signatures without re-alerting", () => {
		const t = new AttentionTracker();
		t.observe(mk("a"));
		t.observe(mk("b"));
		const resolved = t.reconcile([mk("a"), mk("b")]);
		assert.equal(resolved.length, 0);
		assert.equal(t.pending().length, 2);
	});

	it("ignores non-attention records", () => {
		const t = new AttentionTracker();
		const info = { ...mk("a"), attention: false };
		assert.equal(t.observe(info).alert, false);
		assert.equal(t.pending().length, 0);
	});
});

describe("renderDigest — 'what needs me' view (acceptance #3)", () => {
	const mk = (session, kind, project, title = "") => ({
		kind,
		sessionId: session,
		projectId: project,
		title,
		url: "",
		attention: true,
	});

	it("renders an explicit empty state", () => {
		const out = renderDigest([], { now: new Date("2026-07-07T00:00:00Z") });
		assert.match(out, /Nothing needs you/);
	});

	it("aggregates pending items across projects with reasons", () => {
		const out = renderDigest([mk("a", "needs_input", "ao", "prompt"), mk("b", "blocked", "coachclaw", "stuck on X")], {
			now: new Date("2026-07-07T00:00:00Z"),
			mentionUserId: "U1",
		});
		assert.match(out, /2 things need you/);
		assert.match(out, /<@U1>/);
		assert.match(out, /\*ao\*/);
		assert.match(out, /\*coachclaw\*/);
		assert.match(out, /agent-1|`a`/);
		assert.match(out, /needs_input/);
		assert.match(out, /stuck on X/);
	});

	it("excludes non-attention records from the digest", () => {
		const info = { ...mk("c", "pr_merged", "ao"), attention: false };
		const out = renderDigest([info], { now: new Date("2026-07-07T00:00:00Z") });
		assert.match(out, /Nothing needs you/);
	});

	it("uses singular phrasing for exactly one item", () => {
		const out = renderDigest([mk("a", "needs_input", "ao", "prompt")], {
			now: new Date("2026-07-07T00:00:00Z"),
		});
		assert.match(out, /1 thing needs you/);
	});
});

describe("signature", () => {
	it("is stable per (project, session, kind)", () => {
		const rec = { projectId: "ao", sessionId: "a", kind: "needs_input" };
		assert.equal(signature(rec), "ao/a#needs_input");
	});
});

describe("attentionFromSession — poll-based current state (acceptance #1, #3)", async () => {
	const { attentionFromSession, attentionFromSessions } = await import("./attention-core.mjs");

	it("maps a waiting_input session to needs_input attention", () => {
		const rec = attentionFromSession({
			id: "agent-48",
			projectId: "ao",
			activity: { state: "waiting_input" },
			status: "needs_input",
			isTerminated: false,
		});
		assert.equal(rec.kind, "needs_input");
		assert.equal(rec.sessionId, "agent-48");
		assert.equal(rec.attention, true);
	});

	it("maps a blocked session to blocked attention", () => {
		const rec = attentionFromSession({ id: "a", projectId: "ao", activity: { state: "blocked" } });
		assert.equal(rec.kind, "blocked");
	});

	it("classifies blocked BEFORE status-derived needs_input (backend reports both)", () => {
		// A blocked session carries status:needs_input from the backend; the
		// explicit activity state must win so the blocked reason + signature hold.
		const rec = attentionFromSession({
			id: "a",
			projectId: "ao",
			activity: { state: "blocked" },
			status: "needs_input",
		});
		assert.equal(rec.kind, "blocked");
	});

	it("ignores terminated / active / idle / exited sessions", () => {
		assert.equal(attentionFromSession({ id: "a", activity: { state: "waiting_input" }, isTerminated: true }), null);
		assert.equal(attentionFromSession({ id: "a", activity: { state: "active" } }), null);
		assert.equal(attentionFromSession({ id: "a", activity: { state: "idle" } }), null);
		assert.equal(attentionFromSession({ id: "a", activity: { state: "exited" } }), null);
	});

	it("surfaces a PR url when present", () => {
		const rec = attentionFromSession({
			id: "a",
			projectId: "ao",
			activity: { state: "blocked" },
			prs: [{ url: "http://pr/1" }],
		});
		assert.equal(rec.url, "http://pr/1");
	});

	it("maps a full sessions payload to the attention set", () => {
		const recs = attentionFromSessions({
			sessions: [
				{ id: "a", projectId: "ao", activity: { state: "waiting_input" } },
				{ id: "b", projectId: "ao", activity: { state: "active" } },
				{ id: "c", projectId: "cc", activity: { state: "blocked" } },
			],
		});
		assert.equal(recs.length, 2);
		assert.deepEqual(recs.map((r) => r.sessionId).sort(), ["a", "c"]);
	});

	it("accepts a bare array payload too", () => {
		const recs = attentionFromSessions([{ id: "a", projectId: "ao", activity: { state: "waiting_input" } }]);
		assert.equal(recs.length, 1);
	});
});

describe("attentionFromMainCI — project-level red-main inventory", () => {
	it("maps a failing main branch into a needs-response record", () => {
		const rec = attentionFromMainCI({
			projectId: "ao",
			sha: "fee462ed3aabb",
			status: "failing",
			failedJobs: ["go", "cli-e2e"],
			url: "https://github.example/actions/runs/1",
		});
		assert.deepEqual(rec, {
			kind: "main_ci_red",
			sessionId: "main",
			projectId: "ao",
			title: "main is red at fee462ed: go, cli-e2e",
			url: "https://github.example/actions/runs/1",
			attention: true,
		});
	});

	it("ignores non-failing main branch records", () => {
		assert.equal(attentionFromMainCI({ projectId: "ao", status: "passing", sha: "abc" }), null);
		assert.deepEqual(attentionFromMainCIRecords([{ status: "pending" }, { status: "passing" }]), []);
	});
});

describe("AttentionTracker.isOpen/markOpen — deferred commit (retry fix)", () => {
	const mk = (s) => ({ kind: "needs_input", sessionId: s, projectId: "ao", title: "", url: "", attention: true });
	it("isOpen is false until markOpen commits the signature", () => {
		const t = new AttentionTracker();
		const r = mk("a");
		assert.equal(t.isOpen(r), false);
		t.markOpen(r);
		assert.equal(t.isOpen(r), true);
	});
	it("markOpen ignores non-attention records", () => {
		const t = new AttentionTracker();
		t.markOpen({ ...mk("a"), attention: false });
		assert.equal(t.pending().length, 0);
	});
});

describe("attentionFromSession — extended attention states (cycle-2 review)", async () => {
	const { attentionFromSession } = await import("./attention-core.mjs");

	it("maps a no_signal orchestrator to orchestrator_dead", () => {
		const rec = attentionFromSession({
			id: "orc",
			projectId: "ao",
			kind: "orchestrator",
			status: "no_signal",
			activity: { state: "idle" },
		});
		assert.equal(rec.kind, "orchestrator_dead");
		assert.equal(rec.attention, true);
	});

	it("maps a no_signal worker to no_signal", () => {
		const rec = attentionFromSession({
			id: "w",
			projectId: "ao",
			kind: "worker",
			status: "no_signal",
			activity: { state: "idle" },
		});
		assert.equal(rec.kind, "no_signal");
	});

	it("does not page for a normally exited orchestrator (no false positives)", () => {
		assert.equal(
			attentionFromSession({
				id: "orc",
				projectId: "ao",
				kind: "orchestrator",
				status: "terminated",
				activity: { state: "exited" },
				isTerminated: true,
			}),
			null,
		);
		assert.equal(
			attentionFromSession({
				id: "orc",
				projectId: "ao",
				kind: "orchestrator",
				status: "idle",
				activity: { state: "exited" },
			}),
			null,
		);
	});
});

describe("AttentionTracker serialize/deserialize — dedup survives restart (cycle-6 fix)", () => {
	const mk = (s) => ({ kind: "needs_input", sessionId: s, projectId: "ao", title: "", url: "", attention: true });
	it("restores open signatures so a still-pending session is not re-alerted", () => {
		const t = new AttentionTracker();
		assert.equal(t.observe(mk("a")).alert, true);
		const restored = AttentionTracker.deserialize(t.serialize());
		// After a restart, the same still-pending session must NOT re-alert.
		assert.equal(restored.isOpen(mk("a")), true);
	});
	it("a resolved session (reconciled away) does re-alert after restart", () => {
		const t = new AttentionTracker();
		t.observe(mk("a"));
		t.reconcile([]); // 'a' resolved
		const restored = AttentionTracker.deserialize(t.serialize());
		assert.equal(restored.isOpen(mk("a")), false);
	});
	it("tolerates malformed input", () => {
		const t = AttentionTracker.deserialize("not json");
		assert.equal(t.pending().length, 0);
	});
});
