import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AgentHealthNotifier, describeHealthAlert, diffHealth } from "./agent-health-core.mjs";

function harness(id, health, extra = {}) {
	return { id, label: id.toUpperCase(), health, ...extra };
}

test("describeHealthAlert names agent, reason, remedy and mentions", () => {
	const msg = describeHealthAlert(
		{ id: "codex", label: "Codex", health: "unauthorized", reason: "login expired", remedy: "run `codex login`" },
		{ mentionUserId: "U123", host: "boxy" },
	);
	assert.match(msg, /<@U123>/);
	assert.match(msg, /codex \(Codex\)/);
	assert.match(msg, /on boxy/);
	assert.match(msg, /login expired/);
	assert.match(msg, /run `codex login`/);
});

test("diffHealth alerts on transition into actionable, deduped while stable", () => {
	// First observation: codex already unauthorized -> alert.
	let r = diffHealth({}, [harness("codex", "unauthorized", { remedy: "run `codex login`" })]);
	assert.equal(r.alerts.length, 1);
	assert.equal(r.next.codex, "unauthorized");

	// Stable unauthorized -> no repeat.
	r = diffHealth(r.next, [harness("codex", "unauthorized")]);
	assert.equal(r.alerts.length, 0);
	assert.equal(r.recoveries.length, 0);
});

test("diffHealth recovers only from an actionable state", () => {
	// healthy after unauthorized -> recovery.
	let r = diffHealth({ codex: "unauthorized" }, [harness("codex", "healthy")]);
	assert.equal(r.recoveries.length, 1);
	assert.equal(r.next.codex, "healthy");

	// healthy when already healthy -> no recovery.
	r = diffHealth({ codex: "healthy" }, [harness("codex", "healthy")]);
	assert.equal(r.recoveries.length, 0);

	// first-ever observation healthy -> record, no post.
	r = diffHealth({}, [harness("claude-code", "healthy")]);
	assert.equal(r.recoveries.length, 0);
	assert.equal(r.alerts.length, 0);
	assert.equal(r.next["claude-code"], "healthy");
});

test("diffHealth ignores unknown entirely", () => {
	const r = diffHealth({ codex: "unauthorized" }, [harness("codex", "unknown")]);
	assert.equal(r.alerts.length, 0);
	assert.equal(r.recoveries.length, 0);
	// State for codex is preserved (still unauthorized), not overwritten.
	assert.equal(r.next.codex, "unauthorized");
});

test("diffHealth re-alerts when actionable state changes (unauthorized -> missing)", () => {
	const r = diffHealth({ codex: "unauthorized" }, [harness("codex", "missing", { remedy: "install codex" })]);
	assert.equal(r.alerts.length, 1);
	assert.equal(r.next.codex, "missing");
});

test("pollOnce posts transitions and 501 is a no-op", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ah-"));
	const stateFile = join(dir, "state.json");
	const posted = [];
	const snapshot = {
		harnesses: [harness("codex", "unauthorized", { reason: "login expired", remedy: "run `codex login`" })],
		checkedAt: "2026-07-07T12:00:00Z",
	};
	const notifier = new AgentHealthNotifier({
		stateFile,
		mentionUserId: "U9",
		host: "h1",
		postMessage: async (m) => posted.push(m),
		fetchImpl: async () => ({ ok: true, status: 200, json: async () => snapshot }),
	});
	await notifier.pollOnce();
	assert.equal(posted.length, 1);
	assert.match(posted[0], /<@U9> ⚠️ \*agent unauthorized\* codex/);

	// Second poll, unchanged -> no repeat (persisted state dedupes).
	await notifier.pollOnce();
	assert.equal(posted.length, 1);

	// A fresh notifier loading the same state file also does not re-alert.
	const restarted = new AgentHealthNotifier({
		stateFile,
		mentionUserId: "U9",
		postMessage: async (m) => posted.push(m),
		fetchImpl: async () => ({ ok: true, status: 200, json: async () => snapshot }),
	});
	await restarted.pollOnce();
	assert.equal(posted.length, 1, "restart must not re-page a still-broken harness");

	// 501 (monitor unwired) -> no throw, no post.
	const unwired = new AgentHealthNotifier({
		stateFile: join(dir, "s2.json"),
		postMessage: async (m) => posted.push(m),
		fetchImpl: async () => ({ ok: false, status: 501, json: async () => ({}) }),
	});
	const out = await unwired.pollOnce();
	assert.deepEqual(out, []);
});

test("pollOnce forwards abort signals to the health fetch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ah-fetch-signal-"));
	const controller = new AbortController();
	const n = new AgentHealthNotifier({
		stateFile: join(dir, "state.json"),
		postMessage: async () => {},
		fetchImpl: async (_url, init = {}) => {
			assert.equal(init.signal, controller.signal);
			return { ok: true, status: 200, json: async () => ({ harnesses: [] }) };
		},
		logger: { error() {}, info() {}, warn() {} },
	});

	await n.pollOnce({ signal: controller.signal });
});

test("run() is a no-op when pollMs <= 0 (disabled)", async () => {
	let polled = 0;
	const n = new AgentHealthNotifier({
		stateFile: "/tmp/ah-disabled.json",
		pollMs: 0,
		postMessage: async () => {},
		fetchImpl: async () => {
			polled++;
			return { ok: true, status: 200, json: async () => ({ harnesses: [] }) };
		},
	});
	await n.run(); // must return immediately, not busy-loop
	assert.equal(polled, 0);
});

test("run() stops promptly when aborted during poll sleep", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ah-stop-"));
	const controller = new AbortController();
	let polled = 0;
	const n = new AgentHealthNotifier({
		stateFile: join(dir, "state.json"),
		pollMs: 10_000,
		postMessage: async () => {},
		fetchImpl: async () => {
			polled += 1;
			controller.abort();
			return { ok: true, status: 200, json: async () => ({ harnesses: [] }) };
		},
		logger: { error() {}, info() {}, warn() {} },
	});

	const result = await Promise.race([
		n.run({ signal: controller.signal }).then(() => "stopped"),
		new Promise((resolve) => setTimeout(() => resolve("timed out"), 100)),
	]);

	assert.equal(result, "stopped");
	assert.equal(polled, 1);
});

// --- M8 (#293): a later post failure must not repeat earlier successful alerts.
//
// State used to be committed only after the ENTIRE batch posted. If alert A
// succeeded and B then failed, NEITHER transition was persisted — so on every
// retry A was re-posted, paging Nick again for a harness he had already been
// told about, forever, until B happened to succeed.
test("persists each health transition immediately after its own successful post", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ah-partial-"));
	const stateFile = join(dir, "state.json");
	const snapshot = {
		harnesses: [harness("codex", "unauthorized"), harness("fugu", "missing")],
	};

	const posted = [];
	const failing = new AgentHealthNotifier({
		stateFile,
		postMessage: async (m) => {
			posted.push(m);
			// The FIRST alert lands; Slack then fails for the second.
			if (posted.length === 2) throw new Error("slack 503");
		},
		fetchImpl: async () => ({ ok: true, status: 200, json: async () => snapshot }),
		logger: { error() {}, info() {}, warn() {} },
	});

	await assert.rejects(failing.pollOnce(), /slack 503/, "the batch failure must still surface");
	assert.equal(posted.length, 2, "it must have attempted both");

	// A fresh notifier reads the state file from disk — exactly what happens after
	// the notifier restarts, or on the next poll.
	const retried = [];
	const retry = new AgentHealthNotifier({
		stateFile,
		postMessage: async (m) => retried.push(m),
		fetchImpl: async () => ({ ok: true, status: 200, json: async () => snapshot }),
		logger: { error() {}, info() {}, warn() {} },
	});
	await retry.pollOnce();

	assert.equal(retried.length, 1, "only the alert that FAILED may be retried");
	assert.match(retried[0], /fugu/, "the successfully-posted codex alert must not be re-paged");
	assert.doesNotMatch(retried[0], /codex/);
});

test("a recovery post that fails is retried, not silently marked healthy", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ah-recovery-"));
	const stateFile = join(dir, "state.json");

	// Seed: codex is known-unauthorized.
	const seed = new AgentHealthNotifier({
		stateFile,
		postMessage: async () => {},
		fetchImpl: async () => ({
			ok: true,
			status: 200,
			json: async () => ({ harnesses: [harness("codex", "unauthorized")] }),
		}),
		logger: { error() {}, info() {}, warn() {} },
	});
	await seed.pollOnce();

	const healthy = { harnesses: [harness("codex", "healthy")] };
	let fail = true;
	const flaky = new AgentHealthNotifier({
		stateFile,
		postMessage: async () => {
			if (fail) throw new Error("slack 503");
		},
		fetchImpl: async () => ({ ok: true, status: 200, json: async () => healthy }),
		logger: { error() {}, info() {}, warn() {} },
	});
	await assert.rejects(flaky.pollOnce(), /slack 503/);

	// Recovery post failed, so the harness must still be recorded as unauthorized:
	// marking it healthy would swallow the recovery notice permanently.
	fail = false;
	const posted = [];
	const after = new AgentHealthNotifier({
		stateFile,
		postMessage: async (m) => posted.push(m),
		fetchImpl: async () => ({ ok: true, status: 200, json: async () => healthy }),
		logger: { error() {}, info() {}, warn() {} },
	});
	await after.pollOnce();

	assert.equal(posted.length, 1, "the recovery must be retried");
	assert.match(posted[0], /recovered/);
});
