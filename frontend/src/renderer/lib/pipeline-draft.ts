// The canonical in-memory pipeline draft plus its YAML codec.
//
// PipelineDraft is a faithful TypeScript mirror of the Go domain model in
// backend/internal/pipeline/types.go + predicate.go: the visual editor edits a
// draft, and serializeToYaml turns it into the exact config document the daemon
// accepts (pipeline.ParseDefinition). parseYamlToDraft rebuilds a draft from
// YAML edited in Split/YAML mode. Round-tripping a normalized draft
// (draft -> yaml -> draft) is stable for every field the editor manages.
//
// The draft mirrors the config's YAML keys 1:1 (which are camelCase, matching
// the Go yaml tags), so serialization is "prune the empties and dump" and
// parsing is "load and coerce the container shape" — no field-name mapping.
// The daemon's /validate endpoint (not TypeScript) remains the source of truth
// for semantic validity; this codec only manages structure.

import yaml from "js-yaml";

// --- enums (mirror types.go) -----------------------------------------------

export type Scope = "worker" | "orchestrator" | "workstream";
export type StageTriggerEvent = "pr.opened" | "pr.updated" | "pr.merge_ready" | "pr.merged" | "manual";
export type ExecutorKind = "agent" | "command" | "builtin";
export type TaskMode = "review" | "code" | "answer";
export type BuiltinName = "router" | "compose";
export type WorkspaceMode = "shared-ro" | "isolated-rw";
export type Severity = "error" | "warning" | "info";
export type Verdict = "pass" | "fail" | "neutral";
export type PredicateKind =
	| "all_pass"
	| "any_pass"
	| "majority_pass"
	| "no_open_findings"
	| "finding_count_below"
	| "loop_rounds_at_least"
	| "stage_retried_at_least"
	| "stage_verdict"
	| "and"
	| "or"
	| "not";

export const ALL_TRIGGER_EVENTS: StageTriggerEvent[] = [
	"pr.opened",
	"pr.updated",
	"pr.merge_ready",
	"pr.merged",
	"manual",
];
export const ALL_EXECUTOR_KINDS: ExecutorKind[] = ["agent", "command", "builtin"];

// --- draft shape (mirror types.go / predicate.go) --------------------------

// PredicateDraft is the recursive typed-predicate DSL (predicate.go). Only the
// fields relevant to `kind` are meaningful; the daemon rejects the rest.
export interface PredicateDraft {
	kind: PredicateKind;
	stages?: string[];
	stage?: string;
	severity?: Severity;
	max?: number;
	n?: number;
	verdict?: Verdict;
	predicates?: PredicateDraft[];
	predicate?: PredicateDraft;
}

// ExecutorDraft is the single tagged struct covering all three kinds
// (StageExecutor in types.go). Fields belonging to another kind must stay
// unset or the daemon rejects them.
export interface ExecutorDraft {
	kind: ExecutorKind;
	// agent
	plugin?: string;
	mode?: TaskMode;
	// command
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	// builtin
	name?: BuiltinName;
	// agent + builtin
	config?: Record<string, unknown>;
}

export interface TaskDraft {
	prompt?: string;
	outputSchema?: Record<string, unknown>;
	inputs?: Record<string, unknown>;
}

export interface StagePolicyDraft {
	blocksMerge?: boolean;
	stallWindow?: number;
}

export interface StageBudgetDraft {
	maxUsd?: number;
	maxDurationMs?: number;
}

export interface StageRoutesDraft {
	when: PredicateDraft;
}

export interface ExitPredicatesDraft {
	done?: PredicateDraft;
	stalled?: PredicateDraft;
	blocksMerge?: PredicateDraft;
}

export interface StageDraft {
	name: string;
	trigger: { on: StageTriggerEvent[] };
	executor: ExecutorDraft;
	task?: TaskDraft;
	policy?: StagePolicyDraft;
	budget?: StageBudgetDraft;
	timeoutMs?: number;
	retries?: number;
	maxLoopRounds?: number;
	dependsOn?: string[];
	routes?: StageRoutesDraft;
	workspace?: WorkspaceMode;
}

export interface PipelineDraft {
	name: string;
	scope?: Scope;
	stages: StageDraft[];
	maxConcurrentStages?: number;
	allowForkPRs?: boolean;
	exitPredicates?: ExitPredicatesDraft;
}

// --- codec ------------------------------------------------------------------

// prune drops the values that the config's `omitempty` tags would omit —
// undefined, "", [], {} — so a serialized draft carries only meaningful keys
// and stays strict-decodable. It deliberately KEEPS `false` and `0`, which are
// meaningful config values (e.g. allowForkPRs: false, retries: 0, stallWindow:
// 0), unlike a naive falsy filter.
function prune(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(prune).filter((v) => v !== undefined);
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
			const cleaned = prune(raw);
			if (cleaned === undefined) continue;
			if (cleaned === "") continue;
			if (Array.isArray(cleaned) && cleaned.length === 0) continue;
			if (isPlainObject(cleaned) && Object.keys(cleaned).length === 0) continue;
			out[key] = cleaned;
		}
		return out;
	}
	return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// serializeToYaml turns a draft into the config YAML the daemon accepts. The
// draft keys already match the config's YAML keys, so this is prune + dump.
export function serializeToYaml(draft: PipelineDraft): string {
	return yaml.dump(prune(draft), { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false });
}

// parseYamlToDraft rebuilds a draft from YAML. On a syntax error it returns the
// empty draft plus the error message so callers can keep the last good draft
// and surface the problem; a well-formed but semantically invalid document
// still parses into a draft (semantic validity is the /validate endpoint's job).
export function parseYamlToDraft(source: string): { draft: PipelineDraft; error?: string } {
	let loaded: unknown;
	try {
		loaded = yaml.load(source);
	} catch (err) {
		return { draft: emptyDraft(), error: err instanceof Error ? err.message : String(err) };
	}
	if (loaded === undefined || loaded === null) {
		return { draft: emptyDraft() };
	}
	if (!isPlainObject(loaded)) {
		return { draft: emptyDraft(), error: "pipeline definition must be a YAML mapping" };
	}
	return { draft: normalizeDraft(loaded) };
}

// normalizeDraft coerces a loaded YAML object into the canonical draft shape:
// the required container fields (name, stages, per-stage trigger.on + executor)
// always exist, and optional fields pass through as-authored. Normalizing here
// is what makes the round-trip stable — serialize(draft) -> parse yields an
// equal draft for every managed field.
export function normalizeDraft(raw: Record<string, unknown>): PipelineDraft {
	const stages = Array.isArray(raw.stages) ? raw.stages : [];
	const draft: PipelineDraft = {
		name: typeof raw.name === "string" ? raw.name : "",
		stages: stages.filter(isPlainObject).map(normalizeStage),
	};
	if (typeof raw.scope === "string") draft.scope = raw.scope as Scope;
	if (typeof raw.maxConcurrentStages === "number") draft.maxConcurrentStages = raw.maxConcurrentStages;
	if (typeof raw.allowForkPRs === "boolean") draft.allowForkPRs = raw.allowForkPRs;
	if (isPlainObject(raw.exitPredicates)) draft.exitPredicates = normalizeExitPredicates(raw.exitPredicates);
	return draft;
}

function normalizeStage(raw: Record<string, unknown>): StageDraft {
	const triggerOn =
		isPlainObject(raw.trigger) && Array.isArray((raw.trigger as { on?: unknown }).on)
			? ((raw.trigger as { on: unknown[] }).on.filter((e) => typeof e === "string") as StageTriggerEvent[])
			: [];
	const executor = isPlainObject(raw.executor)
		? (raw.executor as unknown as ExecutorDraft)
		: { kind: "agent" as ExecutorKind };

	const stage: StageDraft = {
		name: typeof raw.name === "string" ? raw.name : "",
		trigger: { on: triggerOn },
		executor: { ...executor, kind: (executor.kind ?? "agent") as ExecutorKind },
	};
	if (isPlainObject(raw.task)) stage.task = raw.task as TaskDraft;
	if (isPlainObject(raw.policy)) stage.policy = raw.policy as StagePolicyDraft;
	if (isPlainObject(raw.budget)) stage.budget = raw.budget as StageBudgetDraft;
	if (typeof raw.timeoutMs === "number") stage.timeoutMs = raw.timeoutMs;
	if (typeof raw.retries === "number") stage.retries = raw.retries;
	if (typeof raw.maxLoopRounds === "number") stage.maxLoopRounds = raw.maxLoopRounds;
	if (Array.isArray(raw.dependsOn)) stage.dependsOn = raw.dependsOn.filter((d) => typeof d === "string") as string[];
	if (isPlainObject(raw.routes) && isPlainObject((raw.routes as { when?: unknown }).when)) {
		stage.routes = { when: (raw.routes as { when: unknown }).when as unknown as PredicateDraft };
	}
	if (typeof raw.workspace === "string") stage.workspace = raw.workspace as WorkspaceMode;
	return stage;
}

function normalizeExitPredicates(raw: Record<string, unknown>): ExitPredicatesDraft {
	const out: ExitPredicatesDraft = {};
	if (isPlainObject(raw.done)) out.done = raw.done as unknown as PredicateDraft;
	if (isPlainObject(raw.stalled)) out.stalled = raw.stalled as unknown as PredicateDraft;
	if (isPlainObject(raw.blocksMerge)) out.blocksMerge = raw.blocksMerge as unknown as PredicateDraft;
	return out;
}

// emptyDraft is the starting point for a brand-new pipeline and the fallback a
// failed parse returns.
export function emptyDraft(): PipelineDraft {
	return { name: "", stages: [] };
}

// DEFAULT_DRAFT is the skeleton a "new pipeline" starts from: one agent stage,
// mirroring lib/pipeline-yaml.ts' DEFAULT_PIPELINE_YAML so both entry points
// agree on the starter shape.
export function defaultDraft(): PipelineDraft {
	return {
		name: "my-pipeline",
		stages: [
			{
				name: "review",
				trigger: { on: ["manual"] },
				executor: { kind: "agent", plugin: "claude-code", mode: "review" },
			},
		],
	};
}
