import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { emptyDraft, parseYamlToDraft, type PipelineDraft, serializeToYaml } from "./pipeline-draft";

// roundTrip is stable for any draft whose fields are all "meaningful" (no empty
// strings/arrays/objects that prune would drop): serialize then parse yields an
// equal draft.
function roundTrip(draft: PipelineDraft): PipelineDraft {
	return parseYamlToDraft(serializeToYaml(draft)).draft;
}

describe("pipeline-draft codec", () => {
	const cases: Array<{ name: string; draft: PipelineDraft }> = [
		{
			name: "agent executor",
			draft: {
				name: "review",
				stages: [
					{
						name: "review",
						trigger: { on: ["manual", "pr.opened"] },
						executor: { kind: "agent", plugin: "claude-code", mode: "review" },
						task: { prompt: "review the diff" },
					},
				],
			},
		},
		{
			name: "command executor",
			draft: {
				name: "lint",
				stages: [
					{
						name: "lint",
						trigger: { on: ["pr.updated"] },
						executor: { kind: "command", command: "npm", args: ["run", "lint"], env: { CI: "1" }, cwd: "frontend" },
					},
				],
			},
		},
		{
			name: "builtin executor",
			draft: {
				name: "route",
				stages: [
					{
						name: "route",
						trigger: { on: ["manual"] },
						executor: { kind: "builtin", name: "router", config: { strategy: "fanout" } },
					},
				],
			},
		},
		{
			name: "routes.when predicate + dependsOn",
			draft: {
				name: "gate",
				stages: [
					{
						name: "build",
						trigger: { on: ["manual"] },
						executor: { kind: "agent", plugin: "claude-code", mode: "code" },
					},
					{
						name: "gate",
						trigger: { on: ["manual"] },
						executor: { kind: "builtin", name: "compose" },
						dependsOn: ["build"],
						routes: {
							when: {
								kind: "and",
								predicates: [
									{ kind: "all_pass", stages: ["build"] },
									{ kind: "not", predicate: { kind: "no_open_findings", stage: "build" } },
								],
							},
						},
					},
				],
			},
		},
		{
			name: "exit predicates + pipeline-level knobs",
			draft: {
				name: "full",
				scope: "worker",
				maxConcurrentStages: 2,
				allowForkPRs: false,
				stages: [
					{
						name: "check",
						trigger: { on: ["manual"] },
						executor: { kind: "agent", plugin: "claude-code", mode: "review" },
						retries: 0,
						policy: { blocksMerge: true, stallWindow: 0 },
						budget: { maxUsd: 5, maxDurationMs: 600000 },
						maxLoopRounds: 3,
						workspace: "isolated-rw",
					},
				],
				exitPredicates: {
					done: { kind: "no_open_findings", stage: "check" },
					stalled: { kind: "loop_rounds_at_least", n: 5 },
					blocksMerge: { kind: "finding_count_below", max: 1, severity: "error" },
				},
			},
		},
	];

	for (const { name, draft } of cases) {
		it(`round-trips ${name}`, () => {
			expect(roundTrip(draft)).toEqual(draft);
		});
	}

	it("keeps meaningful false/0 through serialization", () => {
		const yamlOut = serializeToYaml({
			name: "p",
			allowForkPRs: false,
			stages: [
				{
					name: "s",
					trigger: { on: ["manual"] },
					executor: { kind: "agent", plugin: "cc", mode: "code" },
					retries: 0,
				},
			],
		});
		const parsed = yaml.load(yamlOut) as Record<string, unknown>;
		expect(parsed.allowForkPRs).toBe(false);
		expect((parsed.stages as Array<Record<string, unknown>>)[0].retries).toBe(0);
	});

	it("omits empty optional fields from the YAML", () => {
		const yamlOut = serializeToYaml({
			name: "p",
			stages: [{ name: "s", trigger: { on: ["manual"] }, executor: { kind: "agent", plugin: "cc", mode: "code" } }],
		});
		expect(yamlOut).not.toContain("dependsOn");
		expect(yamlOut).not.toContain("routes");
		expect(yamlOut).not.toContain("task");
		expect(yamlOut).not.toContain("exitPredicates");
	});

	it("reports a YAML syntax error and returns the empty draft", () => {
		const { draft, error } = parseYamlToDraft("name: [unclosed\n");
		expect(error).toBeTruthy();
		expect(draft).toEqual(emptyDraft());
	});

	it("parses a semantically-invalid but well-formed document without error", () => {
		// Empty name + no stages is a validation failure server-side, but a valid
		// YAML document the codec still turns into a draft.
		const { draft, error } = parseYamlToDraft("name: ''\nstages: []\n");
		expect(error).toBeUndefined();
		expect(draft).toEqual({ name: "", stages: [] });
	});
});
