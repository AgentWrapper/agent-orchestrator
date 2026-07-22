// The three static "New pipeline" templates (mockup 1e). Baked into the
// renderer for v1 (spec decision: no template API); each is a full
// PipelineDraft in the normalized codec shape, so instantiating one is just
// serializeToYaml(template.draft()) and the result parses clean through
// backend ParseDefinition (/validate). pipeline-templates.test.ts mirrors the
// Go validation rules to keep them honest.

import type { PipelineDraft } from "./pipeline-draft";

export interface PipelineTemplate {
	id: "pr-review-loop" | "nightly-triage-sweep" | "release-gate";
	name: string;
	description: string;
	// Accent dot in the modal's template list (mockup 1e row markers).
	dotClass: string;
	// Fresh draft per call so an edited instantiation never mutates the template.
	draft: () => PipelineDraft;
}

// review -> triage -> fix -> verify, gated on findings (8 stages).
function prReviewLoop(): PipelineDraft {
	return {
		name: "pr-review-loop",
		stages: [
			{
				name: "review-correctness",
				trigger: { on: ["pr.opened", "pr.updated"] },
				executor: { kind: "agent", plugin: "claude-code", mode: "review" },
				task: { prompt: "Review the diff for correctness bugs: logic errors, unhandled edge cases, broken contracts." },
			},
			{
				name: "review-security",
				trigger: { on: ["pr.opened", "pr.updated"] },
				executor: { kind: "agent", plugin: "claude-code", mode: "review" },
				task: { prompt: "Review the diff for security issues: injection, authz gaps, secret handling, unsafe input." },
			},
			{
				name: "review-style",
				trigger: { on: ["pr.opened", "pr.updated"] },
				executor: { kind: "agent", plugin: "claude-code", mode: "review" },
				task: { prompt: "Review the diff for style and convention drift against the surrounding code." },
			},
			{
				name: "compose-findings",
				trigger: { on: ["pr.opened", "pr.updated"] },
				executor: { kind: "builtin", name: "compose" },
				dependsOn: ["review-correctness", "review-security", "review-style"],
			},
			{
				name: "triage",
				trigger: { on: ["pr.opened", "pr.updated"] },
				executor: { kind: "agent", plugin: "claude-code", mode: "answer" },
				task: { prompt: "Triage the composed findings: deduplicate, rank by severity, drop false positives." },
				dependsOn: ["compose-findings"],
			},
			{
				name: "fix",
				trigger: { on: ["pr.opened", "pr.updated"] },
				executor: { kind: "agent", plugin: "claude-code", mode: "code" },
				task: { prompt: "Fix the open findings, smallest correct change first. Push the fixes to the PR branch." },
				dependsOn: ["triage"],
				// Run the fix stage whenever the run has any open findings. Scoping this
				// to "compose-findings" was vacuously true (that builtin emits a JSON
				// artifact, never findings), so fix was skipped every run. Unscoped
				// matches the run's done predicate below.
				routes: { when: { kind: "not", predicate: { kind: "no_open_findings" } } },
				workspace: "isolated-rw",
				maxLoopRounds: 3,
			},
			{
				name: "verify",
				trigger: { on: ["pr.opened", "pr.updated"] },
				executor: { kind: "agent", plugin: "claude-code", mode: "review" },
				task: { prompt: "Verify each finding was actually resolved by the fixes; reopen anything still broken." },
				dependsOn: ["fix"],
			},
			{
				name: "route",
				trigger: { on: ["pr.opened", "pr.updated"] },
				executor: { kind: "builtin", name: "router" },
				dependsOn: ["verify"],
			},
		],
		exitPredicates: {
			done: { kind: "no_open_findings" },
			stalled: { kind: "loop_rounds_at_least", n: 5 },
		},
	};
}

// Scheduled scan across open PRs (4 stages). v1 has no cron trigger; the
// sweep is manual-triggered so an external scheduler (or a human) fires it.
function nightlyTriageSweep(): PipelineDraft {
	return {
		name: "nightly-triage-sweep",
		stages: [
			{
				name: "scan",
				trigger: { on: ["manual"] },
				executor: { kind: "agent", plugin: "claude-code", mode: "review" },
				task: {
					prompt: "Scan the open pull requests and collect actionable findings: stale PRs, red CI, unanswered reviews.",
				},
			},
			{
				name: "triage",
				trigger: { on: ["manual"] },
				executor: { kind: "agent", plugin: "claude-code", mode: "answer" },
				task: { prompt: "Classify each finding by urgency and owner; decide which PRs need action tonight." },
				dependsOn: ["scan"],
			},
			{
				name: "label",
				trigger: { on: ["manual"] },
				executor: { kind: "command", command: "gh", args: ["pr", "edit", "--add-label", "triaged"] },
				dependsOn: ["triage"],
			},
			{
				name: "report",
				trigger: { on: ["manual"] },
				executor: { kind: "agent", plugin: "claude-code", mode: "answer" },
				task: { prompt: "Write a short sweep report: what was triaged, what is blocked, what needs a human." },
				dependsOn: ["triage"],
			},
		],
		exitPredicates: {
			done: { kind: "all_pass", stages: ["triage", "report"] },
			stalled: { kind: "loop_rounds_at_least", n: 3 },
		},
	};
}

// Compose checks, block merge on any high finding (5 stages).
function releaseGate(): PipelineDraft {
	return {
		name: "release-gate",
		stages: [
			{
				name: "lint",
				trigger: { on: ["pr.merge_ready"] },
				executor: { kind: "command", command: "pnpm", args: ["lint"] },
			},
			{
				name: "test",
				trigger: { on: ["pr.merge_ready"] },
				executor: { kind: "command", command: "pnpm", args: ["test"] },
			},
			{
				name: "security-review",
				trigger: { on: ["pr.merge_ready"] },
				executor: { kind: "agent", plugin: "claude-code", mode: "review" },
				task: { prompt: "Final security pass over the release diff; flag anything that must not ship." },
			},
			{
				name: "compose-checks",
				trigger: { on: ["pr.merge_ready"] },
				executor: { kind: "builtin", name: "compose" },
				dependsOn: ["lint", "test", "security-review"],
			},
			{
				name: "gate",
				trigger: { on: ["pr.merge_ready"] },
				executor: { kind: "builtin", name: "router" },
				dependsOn: ["compose-checks"],
				policy: { blocksMerge: true },
			},
		],
		exitPredicates: {
			done: { kind: "all_pass", stages: ["lint", "test", "security-review"] },
			blocksMerge: { kind: "not", predicate: { kind: "finding_count_below", max: 1, severity: "error" } },
		},
	};
}

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
	{
		id: "pr-review-loop",
		name: "PR review loop",
		description: "review, triage, fix, verify, gated on findings",
		dotClass: "bg-accent",
		draft: prReviewLoop,
	},
	{
		id: "nightly-triage-sweep",
		name: "Nightly triage sweep",
		description: "scheduled scan across open PRs",
		dotClass: "bg-warning",
		draft: nightlyTriageSweep,
	},
	{
		id: "release-gate",
		name: "Release gate",
		description: "compose checks, block merge on any high finding",
		dotClass: "bg-success",
		draft: releaseGate,
	},
];
