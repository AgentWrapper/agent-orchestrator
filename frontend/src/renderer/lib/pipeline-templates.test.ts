import { describe, expect, it } from "vitest";
import {
	parseYamlToDraft,
	serializeToYaml,
	type ExecutorDraft,
	type PipelineDraft,
	type PredicateDraft,
} from "./pipeline-draft";
import { cycleMembers } from "./pipeline-graph";
import { PIPELINE_TEMPLATES } from "./pipeline-templates";

// Templates are static config baked into the renderer, so the daemon never
// sees them until a user hits Save. This suite mirrors the validation rules
// of backend/internal/pipeline (config.go validatePipelineConfig +
// predicate.go Validate) closely enough that a template violating them fails
// here instead of at /validate in front of a user.

const KNOWN_EVENTS = new Set(["pr.opened", "pr.updated", "pr.merge_ready", "pr.merged", "manual"]);
const KNOWN_MODES = new Set(["review", "code", "answer"]);
const KNOWN_BUILTINS = new Set(["router", "compose"]);
const KNOWN_WORKSPACES = new Set(["shared-ro", "isolated-rw"]);
const KNOWN_SEVERITIES = new Set(["error", "warning", "info"]);
const KNOWN_VERDICTS = new Set(["pass", "fail", "neutral"]);

// Per-kind allowed/required executor fields (config.go executorFieldRules).
const EXECUTOR_RULES: Record<string, { allowed: string[]; required: string[] }> = {
	agent: { allowed: ["plugin", "mode", "config"], required: ["plugin", "mode"] },
	command: { allowed: ["command", "args", "env", "cwd"], required: ["command"] },
	builtin: { allowed: ["name", "config"], required: ["name"] },
};

function executorViolations(executor: ExecutorDraft, path: string): string[] {
	const rules = EXECUTOR_RULES[executor.kind];
	if (!rules) return [`${path}: unknown executor kind ${executor.kind}`];
	const out: string[] = [];
	const present = Object.entries(executor)
		.filter(([key, value]) => key !== "kind" && value !== undefined)
		.map(([key]) => key);
	for (const field of present) {
		if (!rules.allowed.includes(field)) out.push(`${path}: field ${field} not valid for kind ${executor.kind}`);
	}
	for (const field of rules.required) {
		if (!present.includes(field)) out.push(`${path}: kind ${executor.kind} requires field ${field}`);
	}
	if (executor.kind === "agent" && executor.mode && !KNOWN_MODES.has(executor.mode)) {
		out.push(`${path}: unknown task mode ${executor.mode}`);
	}
	if (executor.kind === "builtin" && executor.name && !KNOWN_BUILTINS.has(executor.name)) {
		out.push(`${path}: unknown builtin name ${executor.name}`);
	}
	return out;
}

// Per-kind allowed/required predicate fields (predicate.go predicateFieldRules).
const PREDICATE_RULES: Record<string, { allowed: string[]; required: string[] }> = {
	all_pass: { allowed: ["stages"], required: ["stages"] },
	any_pass: { allowed: ["stages"], required: ["stages"] },
	majority_pass: { allowed: ["stages"], required: ["stages"] },
	no_open_findings: { allowed: ["stage"], required: [] },
	finding_count_below: { allowed: ["max", "stage", "severity"], required: ["max"] },
	loop_rounds_at_least: { allowed: ["n"], required: ["n"] },
	stage_retried_at_least: { allowed: ["stage", "n"], required: ["stage", "n"] },
	stage_verdict: { allowed: ["stage", "verdict"], required: ["stage", "verdict"] },
	and: { allowed: ["predicates"], required: ["predicates"] },
	or: { allowed: ["predicates"], required: ["predicates"] },
	not: { allowed: ["predicate"], required: ["predicate"] },
};

function predicateViolations(predicate: PredicateDraft, path: string): string[] {
	const rules = PREDICATE_RULES[predicate.kind];
	if (!rules) return [`${path}: unknown predicate kind ${predicate.kind}`];
	const out: string[] = [];
	const present = Object.entries(predicate)
		.filter(([key, value]) => key !== "kind" && value !== undefined)
		.map(([key]) => key);
	for (const field of present) {
		if (!rules.allowed.includes(field)) out.push(`${path}: field ${field} not valid for kind ${predicate.kind}`);
	}
	for (const field of rules.required) {
		if (!present.includes(field)) out.push(`${path}: kind ${predicate.kind} requires field ${field}`);
	}
	if (predicate.severity && !KNOWN_SEVERITIES.has(predicate.severity)) {
		out.push(`${path}: unknown severity ${predicate.severity}`);
	}
	if (predicate.verdict && !KNOWN_VERDICTS.has(predicate.verdict)) {
		out.push(`${path}: unknown verdict ${predicate.verdict}`);
	}
	if ((predicate.kind === "and" || predicate.kind === "or") && (predicate.predicates?.length ?? 0) < 1) {
		out.push(`${path}: ${predicate.kind} requires at least one predicate`);
	}
	for (const [i, child] of (predicate.predicates ?? []).entries()) {
		out.push(...predicateViolations(child, `${path}.predicates[${i}]`));
	}
	if (predicate.predicate) out.push(...predicateViolations(predicate.predicate, `${path}.predicate`));
	return out;
}

// Every stage name a predicate references (predicate.go ReferencedStages).
function referencedStages(predicate: PredicateDraft): string[] {
	return [
		...(predicate.stages ?? []),
		...(predicate.stage ? [predicate.stage] : []),
		...(predicate.predicates ?? []).flatMap(referencedStages),
		...(predicate.predicate ? referencedStages(predicate.predicate) : []),
	];
}

// The full config-level rule set (config.go validatePipelineConfig).
function draftViolations(draft: PipelineDraft): string[] {
	const out: string[] = [];
	if (draft.name.trim() === "") out.push("name: must not be empty");
	if (draft.scope && draft.scope !== "worker") out.push(`scope: ${draft.scope} not accepted in v1`);
	if (draft.stages.length === 0) out.push("stages: at least one stage required");
	if (draft.maxConcurrentStages !== undefined && draft.maxConcurrentStages < 1) {
		out.push("maxConcurrentStages: must be >= 1");
	}

	const names = draft.stages.map((s) => s.name);
	const nameSet = new Set(names);
	if (nameSet.size !== names.length) out.push("stages: duplicate stage names");

	for (const [i, stage] of draft.stages.entries()) {
		const base = `stages[${i}]`;
		if (stage.name.trim() === "") out.push(`${base}.name: must not be empty`);
		for (const event of stage.trigger.on) {
			if (!KNOWN_EVENTS.has(event)) out.push(`${base}.trigger.on: unknown event ${event}`);
		}
		out.push(...executorViolations(stage.executor, `${base}.executor`));
		if (stage.maxLoopRounds !== undefined && stage.maxLoopRounds < 1) {
			out.push(`${base}.maxLoopRounds: must be >= 1`);
		}
		if (stage.retries !== undefined && stage.retries < 0) out.push(`${base}.retries: must be >= 0`);
		if (stage.timeoutMs !== undefined && stage.timeoutMs < 0) out.push(`${base}.timeoutMs: must be >= 0`);
		for (const dep of stage.dependsOn ?? []) {
			if (dep === stage.name) out.push(`${base}.dependsOn: self reference`);
			else if (!nameSet.has(dep)) out.push(`${base}.dependsOn: unknown stage ${dep}`);
		}
		if (stage.routes) {
			out.push(...predicateViolations(stage.routes.when, `${base}.routes.when`));
			for (const ref of referencedStages(stage.routes.when)) {
				if (ref === stage.name) out.push(`${base}.routes.when: routes to itself`);
				else if (!nameSet.has(ref)) out.push(`${base}.routes.when: unknown stage ${ref}`);
			}
		}
		if (stage.workspace && !KNOWN_WORKSPACES.has(stage.workspace)) {
			out.push(`${base}.workspace: unknown workspace ${stage.workspace}`);
		}
	}

	for (const key of ["done", "stalled", "blocksMerge"] as const) {
		const predicate = draft.exitPredicates?.[key];
		if (!predicate) continue;
		out.push(...predicateViolations(predicate, `exitPredicates.${key}`));
		for (const ref of referencedStages(predicate)) {
			if (!nameSet.has(ref)) out.push(`exitPredicates.${key}: unknown stage ${ref}`);
		}
	}

	return out;
}

// Stage counts promised by the modal's template list (mockup 1e).
const EXPECTED_STAGE_COUNTS: Record<string, number> = {
	"PR review loop": 8,
	"Nightly triage sweep": 4,
	"Release gate": 5,
};

describe("PIPELINE_TEMPLATES", () => {
	it("matches the mockup's template list", () => {
		expect(PIPELINE_TEMPLATES.map((t) => t.name)).toEqual(Object.keys(EXPECTED_STAGE_COUNTS));
	});

	it("pr-review-loop gates its fix stage on real findings, not a findingless builtin", () => {
		const draft = PIPELINE_TEMPLATES.find((t) => t.id === "pr-review-loop")!.draft();
		const fix = draft.stages.find((s) => s.name === "fix")!;
		const when = fix.routes?.when;
		// not(no_open_findings) with no stage scope: scoping it to the compose
		// builtin (which emits a JSON artifact, never findings) made the predicate
		// vacuously true, so fix was skipped every run.
		expect(when?.kind).toBe("not");
		const inner = when && when.kind === "not" ? when.predicate : undefined;
		expect(inner?.kind).toBe("no_open_findings");
		expect((inner as { stage?: string } | undefined)?.stage).toBeUndefined();
	});

	for (const template of PIPELINE_TEMPLATES) {
		describe(template.name, () => {
			it("has the advertised stage count", () => {
				expect(template.draft().stages).toHaveLength(EXPECTED_STAGE_COUNTS[template.name]);
			});

			it("returns a fresh draft per call", () => {
				const a = template.draft();
				const b = template.draft();
				expect(a).not.toBe(b);
				expect(a.stages).not.toBe(b.stages);
				expect(a).toEqual(b);
			});

			it("round-trips through the codec unchanged", () => {
				const draft = template.draft();
				const parsed = parseYamlToDraft(serializeToYaml(draft));
				expect(parsed.error).toBeUndefined();
				expect(parsed.draft).toEqual(draft);
			});

			it("passes the mirrored backend validation rules", () => {
				expect(draftViolations(template.draft())).toEqual([]);
			});

			it("has an acyclic dependsOn graph", () => {
				expect(cycleMembers(template.draft()).size).toBe(0);
			});
		});
	}
});
