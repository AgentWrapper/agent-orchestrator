// Tests for the stable/nightly e2e-gate verdict contract.
//
// These exercise the pure deriveGateOutcome() so the verdict->exit-code->status
// mapping is deterministic and needs no real pod. Run with:
//   node --test scripts/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveGateOutcome, parseArgs } from "./ao-e2e-pod-gate.mjs";

test("tests passed -> success / exit 0", () => {
	const o = deriveGateOutcome({ ranOk: true, testsPassed: true });
	assert.equal(o.state, "success");
	assert.equal(o.exitCode, 0);
	assert.equal(o.description, "T0 pod smoke passed");
});

test("test failure -> failure / exit 1", () => {
	const o = deriveGateOutcome({ ranOk: true, testsPassed: false });
	assert.equal(o.state, "failure");
	assert.equal(o.exitCode, 1);
	assert.match(o.description, /failed/);
});

test("runner crash is failure, never a silent pass", () => {
	// ranOk=false must fail even if testsPassed is left truthy.
	const o = deriveGateOutcome({ ranOk: false, testsPassed: true });
	assert.equal(o.state, "failure");
	assert.equal(o.exitCode, 1);
	assert.match(o.description, /crash/);
	assert.notEqual(o.state, "success");
});

test("timeout -> failure / exit 1", () => {
	const o = deriveGateOutcome({ ranOk: true, testsPassed: true, timedOut: true });
	assert.equal(o.state, "failure");
	assert.equal(o.exitCode, 1);
	assert.match(o.description, /timed out/);
});

test("timeout beats a truthy testsPassed", () => {
	const o = deriveGateOutcome({ ranOk: true, testsPassed: true, timedOut: true });
	assert.equal(o.state, "failure");
});

test("crash precedence beats timeout", () => {
	const o = deriveGateOutcome({ ranOk: false, timedOut: true, testsPassed: false });
	assert.equal(o.state, "failure");
	assert.match(o.description, /crash/);
});

test("artifacts link is attached on success", () => {
	const url = "https://pods.example/run/123/artifacts";
	const o = deriveGateOutcome({ ranOk: true, testsPassed: true, artifactsUrl: url });
	assert.equal(o.artifactsUrl, url);
	assert.equal(o.state, "success");
});

test("artifacts link is attached on failure too", () => {
	const url = "https://pods.example/run/456/artifacts";
	const o = deriveGateOutcome({ ranOk: true, testsPassed: false, artifactsUrl: url });
	assert.equal(o.artifactsUrl, url);
	assert.equal(o.state, "failure");
});

test("missing artifacts url normalizes to null", () => {
	const o = deriveGateOutcome({ ranOk: true, testsPassed: true });
	assert.equal(o.artifactsUrl, null);
	const o2 = deriveGateOutcome({ ranOk: true, testsPassed: true, artifactsUrl: "" });
	assert.equal(o2.artifactsUrl, null);
});

test("exit code is always 0 or 1", () => {
	for (const facts of [
		{ ranOk: true, testsPassed: true },
		{ ranOk: true, testsPassed: false },
		{ ranOk: false, testsPassed: true },
		{ ranOk: true, testsPassed: true, timedOut: true },
		{},
	]) {
		const o = deriveGateOutcome(facts);
		assert.ok(o.exitCode === 0 || o.exitCode === 1);
		assert.ok(o.state === "success" || o.state === "failure");
	}
});

test("parseArgs reads the gate CLI flags", () => {
	const a = parseArgs(["--repo", "owner/repo", "--sha", "abc123", "--tag", "v1.2.3", "--suite", "T0"]);
	assert.equal(a.repo, "owner/repo");
	assert.equal(a.sha, "abc123");
	assert.equal(a.tag, "v1.2.3");
	assert.equal(a.suite, "T0");
});
