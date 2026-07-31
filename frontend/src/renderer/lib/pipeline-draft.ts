// The canonical in-memory pipeline draft plus its YAML codec.
//
// PipelineDraft is a faithful TypeScript mirror of the Go domain model in
// backend/internal/pipeline/definition.go: the visual editor edits a draft, and
// serializeToYaml turns it into the exact config document the daemon accepts
// (pipeline.ParseDefinition). parseYamlToDraft rebuilds a draft from YAML edited
// in Split/YAML mode. Round-tripping a normalized draft (draft -> yaml -> draft)
// is stable for every field the editor manages.
//
// Unlike v1, the draft field names and the YAML keys are NOT identical: the Go
// yaml tags are snake_case/kebab-case (`on_success`, `on_failure`, `kill-on`,
// `cancel-in-progress`) while the draft stays camelCase like the rest of the
// renderer. The mapping is explicit and lives in this file only, in the two
// functions below; nothing else in the app should know a YAML key.
//
// The daemon's /validate endpoint (not TypeScript) remains the source of truth
// for semantic validity; this codec only manages structure.

import yaml from "js-yaml";

// --- enums (mirror definition.go / outcome.go) ------------------------------

export type ExecutorKind = "agent" | "command";
export type WorkspaceKind = "auto" | "inherit" | "session" | "run" | "stage" | "checkout";
export type PREvent = "created" | "updated" | "merge-ready" | "merged";
export type SessionEvent = "idle" | "exited" | "blocked";
export type ConcurrencyScope = "pr" | "session" | "project";
export type StageOutcome =
	| "pending"
	| "running"
	| "succeeded"
	| "succeeded_unverified"
	| "failed"
	| "no_output"
	| "no_signal"
	| "timed_out"
	| "cancelled"
	| "skipped";
export type RunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export const ALL_EXECUTOR_KINDS: ExecutorKind[] = ["agent", "command"];
export const ALL_WORKSPACE_KINDS: WorkspaceKind[] = ["auto", "inherit", "session", "run", "stage", "checkout"];
export const ALL_PR_EVENTS: PREvent[] = ["created", "updated", "merge-ready", "merged"];
export const ALL_SESSION_EVENTS: SessionEvent[] = ["idle", "exited", "blocked"];
export const ALL_CONCURRENCY_SCOPES: ConcurrencyScope[] = ["pr", "session", "project"];

// The outcomes a stage can settle in, i.e. the legal `session.kill-on` values.
// pending/running are transient and never settle, so they are not offered.
export const SETTLED_OUTCOMES: StageOutcome[] = [
	"succeeded",
	"succeeded_unverified",
	"failed",
	"no_output",
	"no_signal",
	"timed_out",
	"cancelled",
	"skipped",
];

// The engine's fallback when neither the stage nor `defaults` names a deadline
// (backend DefaultStageDeadline). Canvas badges render this, so the editor and
// the engine must agree on the number.
export const DEFAULT_STAGE_DEADLINE = "30m";

// --- draft shape (mirror definition.go) -------------------------------------

export interface SessionSpecDraft {
	// Absent means the engine default {succeeded, failed}; an explicit empty
	// list means "never kill", which is why serialization keeps `kill-on: []`.
	killOn?: StageOutcome[];
}

export interface StageDraft {
	id: string;
	executor: ExecutorKind;
	// agent stages
	agent?: string;
	prompt?: string;
	produces?: string;
	session?: SessionSpecDraft;
	// command stages
	run?: string;
	credentials?: string[];
	// both
	workspace?: WorkspaceKind;
	deadline?: string;
	onSuccess?: string[];
	onFailure?: string;
	needs?: string[];
}

export interface TriggerDraft {
	pr?: PREvent[];
	session?: SessionEvent[];
}

export interface ConcurrencyDraft {
	scope?: ConcurrencyScope;
	group?: string;
	cancelInProgress?: boolean;
}

export interface DefaultsDraft {
	deadline?: string;
	onFailure?: string;
}

export interface PipelineDraft {
	name: string;
	on?: TriggerDraft;
	concurrency?: ConcurrencyDraft;
	defaults?: DefaultsDraft;
	stages: StageDraft[];
}

// --- serialization ----------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// put writes a YAML key only when the value would survive Go's `omitempty` —
// undefined, "", [], {} are dropped. It deliberately KEEPS `false` and `0`,
// which are meaningful config values (concurrency.cancel-in-progress: false is
// the documented release-pipeline setting), unlike a naive falsy filter.
function put(out: Record<string, unknown>, key: string, value: unknown): void {
	if (value === undefined || value === null) return;
	if (value === "") return;
	if (Array.isArray(value) && value.length === 0) return;
	if (isPlainObject(value) && Object.keys(value).length === 0) return;
	out[key] = value;
}

// stageToYaml emits keys in the spec §11 order so a hand-written definition
// round-trips through the canvas without its stages being reshuffled.
function stageToYaml(stage: StageDraft): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	put(out, "id", stage.id);
	put(out, "executor", stage.executor);
	put(out, "agent", stage.agent);
	put(out, "needs", stage.needs);
	put(out, "workspace", stage.workspace);
	put(out, "produces", stage.produces);
	put(out, "credentials", stage.credentials);
	put(out, "deadline", stage.deadline);
	// `kill-on: []` means "never kill a session for this stage" and must survive
	// the empty-list prune; only an absent `session` block is omitted.
	if (stage.session?.killOn !== undefined) out.session = { "kill-on": stage.session.killOn };
	put(out, "run", stage.run);
	put(out, "prompt", stage.prompt);
	// A single successor is emitted as a scalar (`on_success: verify`), matching
	// how the spec's own examples read; the parser accepts either form.
	if (stage.onSuccess && stage.onSuccess.length > 0) {
		out.on_success = stage.onSuccess.length === 1 ? stage.onSuccess[0] : stage.onSuccess;
	}
	put(out, "on_failure", stage.onFailure);
	return out;
}

// serializeToYaml turns a draft into the config YAML the daemon accepts.
export function serializeToYaml(draft: PipelineDraft): string {
	const out: Record<string, unknown> = {};
	put(out, "name", draft.name);

	const on: Record<string, unknown> = {};
	put(on, "pr", draft.on?.pr);
	put(on, "session", draft.on?.session);
	put(out, "on", on);

	const concurrency: Record<string, unknown> = {};
	put(concurrency, "scope", draft.concurrency?.scope);
	put(concurrency, "group", draft.concurrency?.group);
	put(concurrency, "cancel-in-progress", draft.concurrency?.cancelInProgress);
	put(out, "concurrency", concurrency);

	const defaults: Record<string, unknown> = {};
	put(defaults, "deadline", draft.defaults?.deadline);
	put(defaults, "on_failure", draft.defaults?.onFailure);
	put(out, "defaults", defaults);

	out.stages = draft.stages.map(stageToYaml);

	return yaml.dump(out, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false });
}

// --- parsing ----------------------------------------------------------------

// parseYamlToDraft rebuilds a draft from YAML. On a syntax error (or a document
// that is not a mapping) it returns a null draft plus the message, so callers
// can keep the last good draft on screen and surface the problem; a well-formed
// but semantically invalid document still parses into a draft (semantic
// validity is the /validate endpoint's job).
export function parseYamlToDraft(source: string): { draft: PipelineDraft | null; parseError?: string } {
	let loaded: unknown;
	try {
		loaded = yaml.load(source);
	} catch (err) {
		return { draft: null, parseError: err instanceof Error ? err.message : String(err) };
	}
	if (loaded === undefined || loaded === null) return { draft: emptyDraft() };
	if (!isPlainObject(loaded)) return { draft: null, parseError: "pipeline definition must be a YAML mapping" };
	return { draft: normalizeDraft(loaded) };
}

function asString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	// `deadline: 30` and other unquoted scalars load as numbers; the draft keeps
	// durations as authored text, so coerce rather than drop the key.
	if (typeof value === "number") return String(value);
	return undefined;
}

function asStringList(value: unknown): string[] | undefined {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
	return undefined;
}

// normalizeDraft coerces a loaded YAML object into the canonical draft shape:
// the required container fields (name, stages, per-stage id + executor) always
// exist and optional fields pass through as-authored. Normalizing here is what
// makes the round-trip stable, and it is where the scalar-or-list `on_success`
// shape collapses to the draft's array.
export function normalizeDraft(raw: Record<string, unknown>): PipelineDraft {
	const stages = Array.isArray(raw.stages) ? raw.stages : [];
	const draft: PipelineDraft = {
		name: asString(raw.name) ?? "",
		stages: stages.filter(isPlainObject).map(normalizeStage),
	};

	if (isPlainObject(raw.on)) {
		const on: TriggerDraft = {};
		const pr = asStringList(raw.on.pr);
		const session = asStringList(raw.on.session);
		if (pr) on.pr = pr as PREvent[];
		if (session) on.session = session as SessionEvent[];
		if (Object.keys(on).length > 0) draft.on = on;
	}

	if (isPlainObject(raw.concurrency)) {
		const concurrency: ConcurrencyDraft = {};
		const scope = asString(raw.concurrency.scope);
		const group = asString(raw.concurrency.group);
		const cancel = raw.concurrency["cancel-in-progress"];
		if (scope !== undefined) concurrency.scope = scope as ConcurrencyScope;
		if (group !== undefined) concurrency.group = group;
		if (typeof cancel === "boolean") concurrency.cancelInProgress = cancel;
		if (Object.keys(concurrency).length > 0) draft.concurrency = concurrency;
	}

	if (isPlainObject(raw.defaults)) {
		const defaults: DefaultsDraft = {};
		const deadline = asString(raw.defaults.deadline);
		const onFailure = asString(raw.defaults.on_failure);
		if (deadline !== undefined) defaults.deadline = deadline;
		if (onFailure !== undefined) defaults.onFailure = onFailure;
		if (Object.keys(defaults).length > 0) draft.defaults = defaults;
	}

	return draft;
}

function normalizeStage(raw: Record<string, unknown>): StageDraft {
	const stage: StageDraft = {
		id: asString(raw.id) ?? "",
		executor: (asString(raw.executor) ?? "agent") as ExecutorKind,
	};

	const agent = asString(raw.agent);
	const prompt = asString(raw.prompt);
	const produces = asString(raw.produces);
	const run = asString(raw.run);
	const workspace = asString(raw.workspace);
	const deadline = asString(raw.deadline);
	const onFailure = asString(raw.on_failure);
	const credentials = asStringList(raw.credentials);
	const needs = asStringList(raw.needs);
	const onSuccess = asStringList(raw.on_success);

	if (agent !== undefined) stage.agent = agent;
	if (prompt !== undefined) stage.prompt = prompt;
	if (produces !== undefined) stage.produces = produces;
	if (run !== undefined) stage.run = run;
	if (workspace !== undefined) stage.workspace = workspace as WorkspaceKind;
	if (deadline !== undefined) stage.deadline = deadline;
	if (onFailure !== undefined) stage.onFailure = onFailure;
	if (credentials) stage.credentials = credentials;
	if (needs) stage.needs = needs;
	if (onSuccess) stage.onSuccess = onSuccess;

	if (isPlainObject(raw.session)) {
		// An explicit empty list is the "never kill" contract, so the key is kept
		// whenever it was authored, even empty. A `session:` block with no
		// kill-on carries no meaning (Go reads it the same as an absent block),
		// so it is dropped rather than round-tripped as an empty mapping.
		const killOn = asStringList(raw.session["kill-on"]);
		if (killOn) stage.session = { killOn: killOn as StageOutcome[] };
	}

	return stage;
}

// --- starting points --------------------------------------------------------

// emptyDraft is the starting point for a brand-new pipeline.
export function emptyDraft(): PipelineDraft {
	return { name: "", stages: [] };
}

// defaultDraft is the skeleton a "new pipeline" starts from: one agent stage,
// mirroring lib/pipeline-yaml.ts' DEFAULT_PIPELINE_YAML so both entry points
// agree on the starter shape.
export function defaultDraft(): PipelineDraft {
	return {
		name: "my-pipeline",
		stages: [
			{
				id: "review",
				executor: "agent",
				agent: "claude-code",
				produces: "review.md",
				prompt: "Review the diff. Write your review to $AO_OUTPUT, then run `ao pipeline done`.",
			},
		],
	};
}
