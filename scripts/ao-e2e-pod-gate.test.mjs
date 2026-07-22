// Tests for the stable e2e-gate verdict contract.
//
// These exercise the pure deriveGateOutcome() so the fact->classification->
// conclusion->exit-code mapping is deterministic and needs no real pod.
// Run with:  node --test scripts/*.test.mjs
//
// Core property under test: only a real app smoke failure is RED (failure);
// every infra/setup problem is NEUTRAL, so a Daytona/setup hiccup can't make an
// otherwise-good release look failed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveGateOutcome, parseArgs, parsePodVerdict, validateGateArgs } from "./ao-e2e-pod-gate.mjs";

test("passed -> success / exit 0", () => {
	const o = deriveGateOutcome({ ranOk: true, testsPassed: true });
	assert.equal(o.classification, "passed");
	assert.equal(o.conclusion, "success");
	assert.equal(o.exitCode, 0);
	assert.equal(o.description, "T0 pod smoke passed");
});

test("app smoke failure is the only RED (failure / exit 1)", () => {
	const o = deriveGateOutcome({ ranOk: true, testsPassed: false });
	assert.equal(o.classification, "app_failed");
	assert.equal(o.conclusion, "failure");
	assert.equal(o.exitCode, 1);
	assert.match(o.description, /app under test/);
});

test("runner crash is INFRA -> neutral / exit 0 (not red, not a silent pass)", () => {
	// ranOk=false is an infra/setup problem, never the release build's fault.
	const o = deriveGateOutcome({ ranOk: false, testsPassed: true });
	assert.equal(o.classification, "infra");
	assert.equal(o.conclusion, "neutral");
	assert.equal(o.exitCode, 0);
	assert.notEqual(o.conclusion, "failure"); // must not be red
});

test("timeout is INFRA -> neutral / exit 0", () => {
	const o = deriveGateOutcome({ ranOk: true, testsPassed: true, timedOut: true });
	assert.equal(o.classification, "infra");
	assert.equal(o.conclusion, "neutral");
	assert.equal(o.exitCode, 0);
	assert.match(o.description, /timed out/);
});

test("crash precedence beats timeout (both infra)", () => {
	const o = deriveGateOutcome({ ranOk: false, timedOut: true, testsPassed: false });
	assert.equal(o.classification, "infra");
});

test("ONLY app_failed maps to a red failure conclusion", () => {
	const cases = [
		{ facts: { ranOk: true, testsPassed: true }, red: false },
		{ facts: { ranOk: true, testsPassed: false }, red: true }, // app failed
		{ facts: { ranOk: false, testsPassed: true }, red: false }, // infra
		{ facts: { ranOk: true, testsPassed: true, timedOut: true }, red: false }, // infra
	];
	for (const { facts, red } of cases) {
		const o = deriveGateOutcome(facts);
		assert.equal(o.conclusion === "failure", red, `facts=${JSON.stringify(facts)}`);
	}
});

test("artifacts link is carried on pass, fail, and infra", () => {
	const url = "https://pods.example/run/123/artifacts";
	assert.equal(deriveGateOutcome({ ranOk: true, testsPassed: true, artifactsUrl: url }).artifactsUrl, url);
	assert.equal(deriveGateOutcome({ ranOk: true, testsPassed: false, artifactsUrl: url }).artifactsUrl, url);
	assert.equal(deriveGateOutcome({ ranOk: false, artifactsUrl: url }).artifactsUrl, url);
});

test("missing artifacts url normalizes to null", () => {
	assert.equal(deriveGateOutcome({ ranOk: true, testsPassed: true }).artifactsUrl, null);
	assert.equal(deriveGateOutcome({ ranOk: true, testsPassed: true, artifactsUrl: "" }).artifactsUrl, null);
});

test("classification and conclusion are always from the known sets", () => {
	for (const facts of [
		{ ranOk: true, testsPassed: true },
		{ ranOk: true, testsPassed: false },
		{ ranOk: false, testsPassed: true },
		{ ranOk: true, testsPassed: true, timedOut: true },
		{},
	]) {
		const o = deriveGateOutcome(facts);
		assert.ok(["passed", "app_failed", "infra"].includes(o.classification));
		assert.ok(["success", "failure", "neutral"].includes(o.conclusion));
		assert.ok(o.exitCode === 0 || o.exitCode === 1);
	}
});

test("parsePodVerdict: app pass / app fail / infra / missing", () => {
	assert.deepEqual(parsePodVerdict('AO_VERDICT {"passed":true,"suite":"real-app-t0"}'), {
		passed: true,
		infra: false,
	});
	assert.deepEqual(parsePodVerdict('AO_VERDICT {"passed":false,"playwright_exit":1}'), {
		passed: false,
		infra: false,
	});
	// setup/toolchain failure must be flagged infra, not an app failure
	assert.deepEqual(parsePodVerdict('AO_VERDICT {"passed":false,"infra":true,"stage":"npm-playwright"}'), {
		passed: false,
		infra: true,
	});
	// no verdict line at all => pod never produced a result => infra
	assert.deepEqual(parsePodVerdict("some logs but no verdict"), { passed: false, infra: true });
	assert.deepEqual(parsePodVerdict(""), { passed: false, infra: true });
	// garbage json => infra, never a false app pass/fail
	assert.deepEqual(parsePodVerdict("AO_VERDICT {not json}"), { passed: false, infra: true });
});

test("parsePodVerdict: uses the LAST AO_VERDICT line, not the first", () => {
	// A passing verdict followed by a failing one must resolve to the FAILING
	// one — the pod's final word wins, so a stale optimistic line can't mask a
	// later failure.
	const out = [
		'AO_VERDICT {"passed":true,"suite":"real-app-t0"}',
		"...some later retry / log output...",
		'AO_VERDICT {"passed":false,"suite":"real-app-t0","playwright_exit":1}',
	].join("\n");
	assert.deepEqual(parsePodVerdict(out), { passed: false, infra: false });
});

test("parsePodVerdict: last verdict wins for infra and pass ordering too", () => {
	// infra line emitted after an app pass -> infra wins (final word)
	assert.deepEqual(parsePodVerdict('AO_VERDICT {"passed":true}\nAO_VERDICT {"passed":false,"infra":true}'), {
		passed: false,
		infra: true,
	});
	// a genuine pass after an earlier infra line -> pass wins
	assert.deepEqual(parsePodVerdict('AO_VERDICT {"passed":false,"infra":true}\nAO_VERDICT {"passed":true}'), {
		passed: true,
		infra: false,
	});
	// trailing whitespace/newlines after the final line must not defeat selection
	assert.deepEqual(parsePodVerdict('AO_VERDICT {"passed":true}\nAO_VERDICT {"passed":false}\n\n'), {
		passed: false,
		infra: false,
	});
});

test("pod infra verdict maps to NEUTRAL, real app fail maps to RED", () => {
	// This is the reviewer's core point: a pod-side setup failure (infra:true)
	// must not be reported as a red app_failed release result.
	const setupFail = parsePodVerdict('AO_VERDICT {"passed":false,"infra":true}');
	const infraOutcome = deriveGateOutcome({ ranOk: !setupFail.infra, testsPassed: setupFail.passed });
	assert.equal(infraOutcome.classification, "infra");
	assert.equal(infraOutcome.conclusion, "neutral");

	const appFail = parsePodVerdict('AO_VERDICT {"passed":false}');
	const appOutcome = deriveGateOutcome({ ranOk: !appFail.infra, testsPassed: appFail.passed });
	assert.equal(appOutcome.classification, "app_failed");
	assert.equal(appOutcome.conclusion, "failure");
});

test("validateGateArgs accepts a complete set", () => {
	assert.doesNotThrow(() => validateGateArgs({ apiKey: "k", repo: "o/r", tag: "v1.0.0" }));
});

test("validateGateArgs throws on each missing required input", () => {
	assert.throws(() => validateGateArgs({ repo: "o/r", tag: "v1" }), /DAYTONA_API_KEY/);
	assert.throws(() => validateGateArgs({ apiKey: "k", tag: "v1" }), /--repo/);
	assert.throws(() => validateGateArgs({ apiKey: "k", repo: "o/r" }), /--tag/);
	assert.throws(() => validateGateArgs({}), /DAYTONA_API_KEY.*--repo.*--tag/);
	assert.throws(() => validateGateArgs(), /missing required/);
});

test("validateGateArgs treats empty strings as missing", () => {
	assert.throws(() => validateGateArgs({ apiKey: "", repo: "", tag: "" }), /DAYTONA_API_KEY.*--repo.*--tag/);
});

test("parseArgs reads the gate CLI flags", () => {
	const a = parseArgs(["--repo", "owner/repo", "--sha", "abc123", "--tag", "v1.2.3", "--suite", "T0"]);
	assert.equal(a.repo, "owner/repo");
	assert.equal(a.sha, "abc123");
	assert.equal(a.tag, "v1.2.3");
	assert.equal(a.suite, "T0");
});
