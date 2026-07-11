// Config-as-code core (#250): the committed spec IS the specification of a
// project's clean-boot config. These pure helpers read a spec, read the live
// daemon config, and diff them — with no daemon access of their own, so they
// stay fully unit-testable. The CLI wrapper (project-config.mjs) supplies the
// `ao` side effects.
//
// Spec surface: exactly `.project.config` from `ao project get <id> --json`.
// The pause bit (`paused`/`pauseState`) lives as a SIBLING of `config`, never
// inside it, so pausing a project can never look like config drift and the
// spec can never manage pause state. That separation is asserted, not assumed.

// Runtime state that lives alongside — never inside — the spec-managed config.
// A spec that names any of these is malformed (pause is its own bit; #161/#212).
export const PAUSE_FIELDS = ["paused", "pauseState"];

// A project id is used to build a filesystem path (`<dir>/<id>.json`) and is
// passed to the `ao` CLI, so it must be a plain slug — no separators, no
// traversal. The daemon's own ids are slugs like "agent-orchestrator".
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Env keys whose values are likely secrets. `capture` refuses to write these to
// a committed spec, and drift reports redact env values, so config-as-code
// never persists or journals a credential. Best-effort defense-in-depth: this
// is a denylist, not an allowlist — project env is a non-secret forwarding
// mechanism (POLYPOWERS_REPO), so blocking a broad set of secret-shaped names
// covers the real risk without rejecting every future legitimate non-secret var.
const SECRET_KEY_RE =
	/(secret|token|passw(or)?d|passphrase|api[_-]?key|private[_-]?key|access[_-]?key|credential|cookie|session|signing|cert|database[_-]?url|conn(ection)?[_-]?str|dsn|auth)/i;

// `pat` needs segment boundaries so a genuine "personal access token" name
// (GITHUB_PAT) trips while PATH / COMPAT do not.
function looksSecret(key) {
	return SECRET_KEY_RE.test(key) || /(^|[_-])pat([_-]|$)/i.test(key);
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptyContainer(value) {
	if (Array.isArray(value)) return value.length === 0;
	if (isPlainObject(value)) return Object.keys(value).length === 0;
	return false;
}

// The daemon marshals config with Go `omitempty` (verified: `autonomousMerge`,
// `maxConcurrent`, …), so a zero scalar or empty container is OMITTED from
// `ao project get --json`. A spec that carries such a zero value therefore
// converges with a live payload that omits it — treat the two as equal rather
// than reporting eternal phantom drift.
function isAbsentEquivalent(value) {
	return value === false || value === 0 || value === "" || isEmptyContainer(value);
}

export function assertValidProjectId(id) {
	if (typeof id !== "string" || !PROJECT_ID_RE.test(id)) {
		throw new Error(`invalid project id ${JSON.stringify(id)}: expected a slug matching ${PROJECT_ID_RE}`);
	}
	return id;
}

// Throw if any env value is keyed like a secret — config-as-code commits the
// spec to git and journals drift, so credentials must not live in project env.
// `allowKeys` is a per-key escape hatch for a specific non-secret name that
// trips the heuristic; unlike a global "disable all protection" switch it only
// exempts the exact keys the operator names.
export function assertNoSecretEnv(config, { allowKeys = [] } = {}) {
	if (!isPlainObject(config) || !isPlainObject(config.env)) return config;
	const allow = new Set(allowKeys);
	const offenders = Object.keys(config.env).filter((k) => looksSecret(k) && !allow.has(k));
	if (offenders.length > 0) {
		throw new Error(
			`refusing to write secret-like env key(s) to a committed spec: ${offenders.join(", ")}. ` +
				`Move secrets out of project env, or exempt specific non-secret keys via ` +
				`AO_PROJECT_CONFIG_ALLOW_ENV_KEYS=<comma-separated key names>.`,
		);
	}
	return config;
}

// Deep-normalize a config for comparison: drop null/undefined and empty
// containers (an empty `trackerIntake: {}` carries no configuration and must
// compare equal to an absent one), while preserving meaningful falsy scalars
// like `false`, `0`, and `""`.
export function normalizeConfig(value) {
	if (Array.isArray(value)) return value.map(normalizeConfig);
	if (isPlainObject(value)) {
		const out = {};
		for (const [key, raw] of Object.entries(value)) {
			if (raw === null || raw === undefined) continue;
			const child = normalizeConfig(raw);
			if (isEmptyContainer(child)) continue;
			out[key] = child;
		}
		return out;
	}
	return value;
}

// Recursively sort object keys (arrays keep their order) so serialized specs
// are deterministic and structural comparison is independent of key order.
export function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (isPlainObject(value)) {
		const out = {};
		for (const key of Object.keys(value).sort()) {
			out[key] = canonicalize(value[key]);
		}
		return out;
	}
	return value;
}

// Structural equality: insensitive to object key order, sensitive to array
// order (reordering workerMix weights is a real change).
export function configEqual(a, b) {
	return JSON.stringify(canonicalize(normalizeConfig(a))) === JSON.stringify(canonicalize(normalizeConfig(b)));
}

// Diff a spec against a live config. Returns one entry per divergence:
//   { path, kind: "missing" | "unexpected" | "changed", specValue?, liveValue? }
// "missing"    — present in spec, absent live (a wiped field: the July-8 mode).
// "unexpected" — present live, absent from spec (unmanaged drift).
// "changed"    — present on both sides but not structurally equal.
export function diffConfig(spec, live) {
	const diffs = [];
	walk("", normalizeConfig(spec ?? {}), normalizeConfig(live ?? {}), diffs);
	return diffs;
}

function walk(path, spec, live, diffs) {
	if (isPlainObject(spec) && isPlainObject(live)) {
		const keys = new Set([...Object.keys(spec), ...Object.keys(live)]);
		for (const key of [...keys].sort()) {
			const child = path ? `${path}.${key}` : key;
			const inSpec = key in spec;
			const inLive = key in live;
			if (inSpec && !inLive) {
				// A zero-valued spec field is omitted from the wire by omitempty, so
				// its absence live is convergence, not a wipe.
				if (isAbsentEquivalent(spec[key])) continue;
				diffs.push({ path: child, kind: "missing", specValue: spec[key] });
			} else if (!inSpec && inLive) {
				if (isAbsentEquivalent(live[key])) continue;
				diffs.push({ path: child, kind: "unexpected", liveValue: live[key] });
			} else {
				walk(child, spec[key], live[key], diffs);
			}
		}
		return;
	}
	if (!configEqual(spec, live)) {
		diffs.push({ path: path || "(root)", kind: "changed", specValue: spec, liveValue: live });
	}
}

export function hasDrift(diffs) {
	return Array.isArray(diffs) && diffs.length > 0;
}

// Pull the spec-managed config out of an `ao project get <id> --json` payload.
// Structurally excludes the sibling pause state, proving the invariant.
export function extractLiveConfig(payload) {
	if (!isPlainObject(payload) || !isPlainObject(payload.project)) {
		throw new Error("malformed `ao project get` payload: expected an object with a `project`");
	}
	const config = payload.project.config;
	if (!isPlainObject(config)) {
		throw new Error("malformed `ao project get` payload: `project.config` is missing or not an object");
	}
	return config;
}

// Validate a candidate spec: it must be a plain config object and must not try
// to manage runtime pause state.
export function validateSpec(spec) {
	if (!isPlainObject(spec)) {
		throw new Error("project config spec must be a JSON object");
	}
	for (const field of PAUSE_FIELDS) {
		if (field in spec) {
			throw new Error(
				`project config spec must not manage the pause field "${field}" (pause is its own bit, #161/#212)`,
			);
		}
	}
	return spec;
}

// Serialize a spec to canonical, tab-indented JSON with a trailing newline so
// committed spec files are deterministic and prettier-stable.
export function serializeSpec(spec) {
	return `${JSON.stringify(canonicalize(spec), null, "\t")}\n`;
}

// Render a diff value for the report, redacting anything under `env` or keyed
// like a secret so drift output (which lands in the systemd journal) never
// leaks a credential value. The path and kind are always shown.
function renderValue(path, value) {
	const leaf = path.split(".").pop() || path;
	if (path === "env" || path.startsWith("env.") || looksSecret(leaf)) {
		return "<redacted>";
	}
	return JSON.stringify(value);
}

// Human-readable drift report for one project.
export function formatDiff(project, diffs) {
	if (!hasDrift(diffs)) {
		return `✓ ${project}: live config matches spec (no drift)`;
	}
	const lines = [`✗ ${project}: ${diffs.length} divergence(s) from spec`];
	for (const d of diffs) {
		if (d.kind === "missing") {
			lines.push(`  - [missing]    ${d.path}: spec has ${renderValue(d.path, d.specValue)}, live has nothing`);
		} else if (d.kind === "unexpected") {
			lines.push(`  - [unexpected] ${d.path}: live has ${renderValue(d.path, d.liveValue)}, spec has nothing`);
		} else {
			lines.push(
				`  - [changed]    ${d.path}: spec ${renderValue(d.path, d.specValue)} != live ${renderValue(d.path, d.liveValue)}`,
			);
		}
	}
	return lines.join("\n");
}
