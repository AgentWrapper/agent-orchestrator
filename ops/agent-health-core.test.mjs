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
