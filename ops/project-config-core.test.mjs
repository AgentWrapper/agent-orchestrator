import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	PAUSE_FIELDS,
	assertNoSecretEnv,
	assertValidProjectId,
	canonicalize,
	configEqual,
	diffConfig,
	extractLiveConfig,
	formatDiff,
	hasDrift,
	normalizeConfig,
	serializeSpec,
	validateSpec,
} from "./project-config-core.mjs";

// A representative clean-boot config, shaped like `.project.config` from
// `ao project get <id> --json`.
const BASE_CONFIG = {
	defaultBranch: "main",
	projectPrefix: "ao",
	autonomousMerge: true,
	workspace: "in-place",
	env: { POLYPOWERS_REPO: "polymath-ventures/agent-orchestrator" },
	agentConfig: { permissions: "bypass-permissions" },
	worker: { agent: "codex", agentConfig: { model: "gpt-5.5" } },
	orchestrator: { agent: "claude-code", agentConfig: { model: "opus" } },
	workerMix: [
		{ agent: "codex", model: "gpt-5.5", weight: 55 },
		{ agent: "codex-fugu", model: "fugu-ultra", weight: 27 },
		{ agent: "claude-code", model: "opus", weight: 18 },
	],
	trackerIntake: {
		enabled: true,
		provider: "github",
		excludeLabels: ["no-ao", "deferred"],
		maxConcurrent: 8,
	},
};

const clone = (v) => JSON.parse(JSON.stringify(v));

describe("normalizeConfig", () => {
	it("drops null, undefined, and empty containers but keeps false/0/empty-string", () => {
		const out = normalizeConfig({
			autonomousMerge: false,
			maxConcurrent: 0,
			note: "",
			trackerIntake: {},
			labels: [],
			gone: null,
			missing: undefined,
			env: { KEEP: "v", DROP: null },
		});
		assert.deepEqual(out, {
			autonomousMerge: false,
			maxConcurrent: 0,
			note: "",
			env: { KEEP: "v" },
		});
	});

	it("treats an empty trackerIntake object as equivalent to an absent one", () => {
		assert.equal(hasDrift(diffConfig({ trackerIntake: {} }, {})), false);
		assert.equal(hasDrift(diffConfig({}, { trackerIntake: {} })), false);
	});
});

describe("canonicalize", () => {
	it("sorts object keys recursively and preserves array order", () => {
		const c = canonicalize({ b: 1, a: { d: 2, c: 3 }, arr: [3, 1, 2] });
		assert.equal(JSON.stringify(c), JSON.stringify({ a: { c: 3, d: 2 }, arr: [3, 1, 2], b: 1 }));
	});
});

describe("configEqual", () => {
	it("is insensitive to object key order (Go marshals struct order; specs are key-sorted)", () => {
		assert.equal(configEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
	});

	it("is sensitive to array order (reordering workerMix weights is a real change)", () => {
		assert.equal(configEqual({ mix: [1, 2] }, { mix: [2, 1] }), false);
	});
});

describe("diffConfig", () => {
	it("reports no drift for structurally identical configs regardless of key order", () => {
		const reordered = { workspace: "in-place", defaultBranch: "main", ...BASE_CONFIG };
		assert.deepEqual(diffConfig(BASE_CONFIG, reordered), []);
		assert.equal(hasDrift(diffConfig(BASE_CONFIG, reordered)), false);
	});

	it("flags a wiped field as a `missing` divergence (the July-8 failure mode)", () => {
		const wiped = clone(BASE_CONFIG);
		delete wiped.autonomousMerge;
		const diffs = diffConfig(BASE_CONFIG, wiped);
		assert.equal(hasDrift(diffs), true);
		const d = diffs.find((x) => x.path === "autonomousMerge");
		assert.ok(d, "autonomousMerge should be reported");
		assert.equal(d.kind, "missing");
		assert.equal(d.specValue, true);
	});

	it("flags a changed field with both values", () => {
		const changed = clone(BASE_CONFIG);
		changed.autonomousMerge = false;
		const diffs = diffConfig(BASE_CONFIG, changed);
		const d = diffs.find((x) => x.path === "autonomousMerge");
		assert.equal(d.kind, "changed");
		assert.equal(d.specValue, true);
		assert.equal(d.liveValue, false);
	});

	it("flags an unexpected live field not present in the spec", () => {
		const extra = clone(BASE_CONFIG);
		extra.rogueField = "sneaked-in";
		const d = diffConfig(BASE_CONFIG, extra).find((x) => x.path === "rogueField");
		assert.equal(d.kind, "unexpected");
		assert.equal(d.liveValue, "sneaked-in");
	});

	it("descends into nested objects and reports the dotted path", () => {
		const changed = clone(BASE_CONFIG);
		changed.env.POLYPOWERS_REPO = "polymath-ventures/wrong";
		const d = diffConfig(BASE_CONFIG, changed).find((x) => x.path === "env.POLYPOWERS_REPO");
		assert.equal(d.kind, "changed");
	});
});

describe("diffConfig omitempty tolerance (Go zero values omitted from the wire)", () => {
	it("a spec field that is a zero scalar converges with a live payload that omits it", () => {
		// The daemon marshals `autonomousMerge`/`maxConcurrent` with omitempty, so
		// false/0 never appear live. A spec carrying them must NOT drift forever.
		assert.deepEqual(diffConfig({ autonomousMerge: false }, {}), []);
		assert.deepEqual(diffConfig({ maxConcurrent: 0 }, {}), []);
		assert.deepEqual(diffConfig({ note: "" }, {}), []);
		// Symmetric: a live zero the spec omits is not "unexpected" drift.
		assert.deepEqual(diffConfig({}, { autonomousMerge: false }), []);
	});

	it("still flags a NON-zero spec field that is missing live (the real wipe)", () => {
		const diffs = diffConfig({ autonomousMerge: true }, {});
		assert.equal(hasDrift(diffs), true);
		assert.equal(diffs[0].kind, "missing");
		assert.equal(diffs[0].specValue, true);
	});

	it("flags a true→false change when both sides are present", () => {
		const d = diffConfig({ autonomousMerge: true }, { autonomousMerge: false }).find(
			(x) => x.path === "autonomousMerge",
		);
		assert.equal(d.kind, "changed");
	});
});

describe("assertValidProjectId (path-traversal guard)", () => {
	it("accepts daemon-style slugs", () => {
		assert.equal(assertValidProjectId("agent-orchestrator"), "agent-orchestrator");
		assert.equal(assertValidProjectId("cc"), "cc");
	});

	it("rejects separators, traversal, and empties", () => {
		for (const bad of ["../etc/passwd", "a/b", "..", "", ".hidden", "with space"]) {
			assert.throws(() => assertValidProjectId(bad), /invalid project id/i);
		}
	});
});

describe("assertNoSecretEnv (do not commit/journal credentials)", () => {
	it("passes for ordinary non-secret env", () => {
		assert.doesNotThrow(() => assertNoSecretEnv({ env: { POLYPOWERS_REPO: "owner/repo" } }));
	});

	it("throws when an env key looks like a secret (incl. broadened names)", () => {
		for (const key of [
			"GITHUB_TOKEN",
			"API_KEY",
			"DB_PASSWORD",
			"AWS_SECRET_ACCESS_KEY",
			"GITHUB_PAT",
			"DATABASE_URL",
			"SESSION_COOKIE",
			"SIGNING_KEY",
		]) {
			assert.throws(() => assertNoSecretEnv({ env: { [key]: "x" } }), /secret/i);
		}
	});

	it("does not flag ordinary infra env keys (no PATH/COMPAT false positives)", () => {
		for (const key of ["PATH", "POLYPOWERS_REPO", "COMPAT_MODE", "NODE_ENV", "HOME"]) {
			assert.doesNotThrow(() => assertNoSecretEnv({ env: { [key]: "x" } }));
		}
	});

	it("honors a per-key allow override (not a global disable)", () => {
		// The named key is exempted; a different secret-shaped key still throws.
		assert.doesNotThrow(() => assertNoSecretEnv({ env: { MY_TOKEN: "x" } }, { allowKeys: ["MY_TOKEN"] }));
		assert.throws(
			() => assertNoSecretEnv({ env: { MY_TOKEN: "x", OTHER_SECRET: "y" } }, { allowKeys: ["MY_TOKEN"] }),
			/OTHER_SECRET/,
		);
	});
});

describe("pause invariant (#161/#212)", () => {
	it("extractLiveConfig returns only .project.config, excluding sibling pause state", () => {
		const payload = {
			status: "ok",
			project: {
				id: "agent-orchestrator",
				paused: true,
				pauseState: "paused",
				config: clone(BASE_CONFIG),
			},
		};
		const cfg = extractLiveConfig(payload);
		assert.deepEqual(cfg, BASE_CONFIG);
		for (const f of PAUSE_FIELDS) {
			assert.equal(f in cfg, false, `${f} must not appear in the spec-managed config`);
		}
	});

	it("pausing a project produces zero drift against its spec (pause is its own bit)", () => {
		const pausedPayload = {
			status: "ok",
			project: { paused: true, pauseState: "paused", config: clone(BASE_CONFIG) },
		};
		const diffs = diffConfig(BASE_CONFIG, extractLiveConfig(pausedPayload));
		assert.equal(hasDrift(diffs), false);
	});

	it("validateSpec rejects a spec that tries to manage a pause field", () => {
		for (const f of PAUSE_FIELDS) {
			assert.throws(() => validateSpec({ ...BASE_CONFIG, [f]: true }), /pause/i);
		}
	});

	it("extractLiveConfig throws on a malformed payload", () => {
		assert.throws(() => extractLiveConfig({ status: "ok" }), /project/i);
		assert.throws(() => extractLiveConfig({ project: { id: "x" } }), /config/i);
		assert.throws(() => extractLiveConfig(null), /payload/i);
	});
});

describe("validateSpec", () => {
	it("accepts a well-formed config object and returns it", () => {
		assert.deepEqual(validateSpec(BASE_CONFIG), BASE_CONFIG);
	});

	it("rejects non-object specs", () => {
		assert.throws(() => validateSpec(null), /object/i);
		assert.throws(() => validateSpec([1, 2]), /object/i);
		assert.throws(() => validateSpec("x"), /object/i);
	});
});

describe("serializeSpec", () => {
	it("emits canonical, tab-indented JSON with a trailing newline (prettier-stable)", () => {
		const text = serializeSpec({ b: 1, a: 2 });
		assert.equal(text, '{\n\t"a": 2,\n\t"b": 1\n}\n');
	});

	it("round-trips through JSON.parse back to the same normalized config", () => {
		const text = serializeSpec(BASE_CONFIG);
		assert.deepEqual(normalizeConfig(JSON.parse(text)), normalizeConfig(BASE_CONFIG));
	});
});

describe("formatDiff", () => {
	it("returns a clean single-line message when there is no drift", () => {
		const msg = formatDiff("agent-orchestrator", []);
		assert.match(msg, /agent-orchestrator/);
		assert.match(msg, /no drift|in sync|matches/i);
	});

	it("lists each divergence with its kind and path when drifted", () => {
		const diffs = [
			{ path: "autonomousMerge", kind: "missing", specValue: true },
			{ path: "projectPrefix", kind: "changed", specValue: "a", liveValue: "b" },
		];
		const msg = formatDiff("coachclaw", diffs);
		assert.match(msg, /coachclaw/);
		assert.match(msg, /autonomousMerge/);
		assert.match(msg, /projectPrefix/);
		assert.match(msg, /missing/);
		assert.match(msg, /changed/);
	});

	it("redacts env values (drift output lands in the journal) but keeps the path", () => {
		const diffs = [{ path: "env.GITHUB_TOKEN", kind: "changed", specValue: "old-secret", liveValue: "new-secret" }];
		const msg = formatDiff("coachclaw", diffs);
		assert.match(msg, /env\.GITHUB_TOKEN/);
		assert.match(msg, /<redacted>/);
		assert.doesNotMatch(msg, /old-secret|new-secret/);
	});
});
