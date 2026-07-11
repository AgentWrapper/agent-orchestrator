import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const CLI = new URL("./project-config.mjs", import.meta.url).pathname;

const SPEC = {
	defaultBranch: "main",
	projectPrefix: "ao",
	autonomousMerge: true,
	env: { POLYPOWERS_REPO: "polymath-ventures/agent-orchestrator" },
	workerMix: [{ agent: "codex", model: "gpt-5.5", weight: 55 }],
};

// Build a throwaway workspace: a spec dir with one project spec, and a fake
// `ao` on PATH that answers `project get` from a canned payload and logs every
// `project set-config` invocation to a file.
function makeWorkspace({ liveConfig = SPEC, paused = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pcfg-"));
	const specDir = join(dir, "specs");
	mkdirSync(specDir);
	writeFileSync(join(specDir, "agent-orchestrator.json"), `${JSON.stringify(SPEC, null, "\t")}\n`);

	const payload = JSON.stringify({
		status: "ok",
		project: { id: "agent-orchestrator", paused, pauseState: paused ? "paused" : "running", config: liveConfig },
	});
	const setLog = join(dir, "set.log");
	const fakeAo = join(dir, "ao");
	// A tiny fake `ao`: echo canned JSON for `project get --json`; append the
	// received --config-json to set.log for `project set-config`.
	writeFileSync(
		fakeAo,
		[
			"#!/usr/bin/env node",
			"const a = process.argv.slice(2);",
			`const payload = ${JSON.stringify(payload)};`,
			"if (a[0] === 'project' && a[1] === 'get') { process.stdout.write(payload); process.exit(0); }",
			"if (a[0] === 'project' && a[1] === 'set-config') {",
			"  const i = a.indexOf('--config-json');",
			`  require('fs').appendFileSync(${JSON.stringify(setLog)}, a[i + 1] + '\\n');`,
			'  process.stdout.write(\'{"status":"ok"}\'); process.exit(0);',
			"}",
			"process.stderr.write('unexpected fake-ao call: ' + a.join(' ')); process.exit(3);",
			"",
		].join("\n"),
	);
	chmodSync(fakeAo, 0o755);
	return { dir, specDir, setLog, fakeAo };
}

function run(ws, args) {
	return spawnSync("node", [CLI, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			AO_BIN: ws.fakeAo,
			AO_PROJECT_CONFIG_DIR: ws.specDir,
		},
	});
}

describe("project-config check", () => {
	it("exits 0 and reports no drift when live matches spec", () => {
		const ws = makeWorkspace({ liveConfig: SPEC });
		const r = run(ws, ["check", "agent-orchestrator"]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /no drift|matches/i);
	});

	it("exits non-zero and names the wiped field when a spec-managed field is missing live", () => {
		const wiped = { ...SPEC };
		delete wiped.autonomousMerge;
		const ws = makeWorkspace({ liveConfig: wiped });
		const r = run(ws, ["check", "agent-orchestrator"]);
		assert.notEqual(r.status, 0);
		assert.match(r.stdout + r.stderr, /autonomousMerge/);
		assert.match(r.stdout + r.stderr, /missing/);
	});

	it("does NOT report drift merely because the project is paused (pause is its own bit)", () => {
		const ws = makeWorkspace({ liveConfig: SPEC, paused: true });
		const r = run(ws, ["check", "agent-orchestrator"]);
		assert.equal(r.status, 0, r.stdout + r.stderr);
	});

	it("--all checks every committed spec and aggregates", () => {
		const ws = makeWorkspace({ liveConfig: SPEC });
		const r = run(ws, ["check", "--all"]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /agent-orchestrator/);
	});
});

describe("project-config apply", () => {
	it("writes the committed spec to the daemon via set-config --config-json", () => {
		const ws = makeWorkspace();
		const r = run(ws, ["apply", "agent-orchestrator"]);
		assert.equal(r.status, 0, r.stderr);
		const sent = JSON.parse(readFileSync(ws.setLog, "utf8").trim());
		assert.deepEqual(sent, SPEC);
	});

	it("--dry-run does not call set-config", () => {
		const ws = makeWorkspace();
		const r = run(ws, ["apply", "agent-orchestrator", "--dry-run"]);
		assert.equal(r.status, 0, r.stderr);
		assert.throws(() => readFileSync(ws.setLog, "utf8"), /ENOENT/);
	});
});

describe("project-config capture", () => {
	it("writes the live config to the spec file (backfill/dogfood path)", () => {
		const ws = makeWorkspace({ liveConfig: { ...SPEC, projectPrefix: "changed" } });
		const r = run(ws, ["capture", "agent-orchestrator"]);
		assert.equal(r.status, 0, r.stderr);
		const written = JSON.parse(readFileSync(join(ws.specDir, "agent-orchestrator.json"), "utf8"));
		assert.equal(written.projectPrefix, "changed");
	});

	it("refuses to commit a secret-like env key (config-as-code goes to git)", () => {
		const ws = makeWorkspace({ liveConfig: { ...SPEC, env: { GITHUB_TOKEN: "ghp_xxx" } } });
		const r = run(ws, ["capture", "agent-orchestrator"]);
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /secret/i);
	});

	it("a per-key AO_PROJECT_CONFIG_ALLOW_ENV_KEYS override lets a named key through", () => {
		const ws = makeWorkspace({ liveConfig: { ...SPEC, env: { AUTH_MODE: "oauth" } } });
		const r = spawnSync("node", [CLI, "capture", "agent-orchestrator"], {
			encoding: "utf8",
			env: {
				...process.env,
				AO_BIN: ws.fakeAo,
				AO_PROJECT_CONFIG_DIR: ws.specDir,
				AO_PROJECT_CONFIG_ALLOW_ENV_KEYS: "AUTH_MODE",
			},
		});
		assert.equal(r.status, 0, r.stderr);
	});
});

describe("project-config drift output redaction", () => {
	it("redacts env values in the drift report but still exits non-zero", () => {
		// Live has an env var the spec lacks; the value must not leak to the journal.
		const ws = makeWorkspace({ liveConfig: { ...SPEC, env: { ...SPEC.env, LEAK: "super-secret-value" } } });
		const r = run(ws, ["check", "agent-orchestrator"]);
		assert.notEqual(r.status, 0);
		assert.doesNotMatch(r.stdout + r.stderr, /super-secret-value/);
		assert.match(r.stdout, /<redacted>/);
	});
});

describe("project-config project-id validation", () => {
	it("rejects a traversal-style project id", () => {
		const ws = makeWorkspace();
		const r = run(ws, ["check", "../../etc/passwd"]);
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /invalid project id/i);
	});
});

describe("project-config usage", () => {
	it("exits non-zero with usage on an unknown command", () => {
		const ws = makeWorkspace();
		const r = run(ws, ["frobnicate"]);
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /usage/i);
	});
});
