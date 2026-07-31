import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ALL_CONCURRENCY_SCOPES,
	ALL_EXECUTOR_KINDS,
	ALL_PR_EVENTS,
	ALL_SESSION_EVENTS,
	ALL_WORKSPACE_KINDS,
	parseYamlToDraft,
	serializeToYaml,
	SETTLED_OUTCOMES,
	type PipelineDraft,
} from "./pipeline-draft";
import { cycleStageIds } from "./pipeline-graph";
import { PIPELINE_TEMPLATES } from "./pipeline-templates";

// Templates are static config baked into the renderer, so the daemon never
// sees them until a user hits Save. This suite mirrors the edit-time rules of
// backend/internal/pipeline (spec §13) closely enough that a template violating
// them fails here instead of at /validate in front of a user.
//
// The mirror is a copy of the rules, not the rules, so it is backed by the real
// thing: every template's serialized YAML is committed as
// backend/internal/pipeline/testdata/templates/<id>.yaml, and
// TestStarterTemplatesValidate over there runs the actual ParseDefinition +
// Validate against each file. This suite pins the two sides together by
// asserting the fixture is byte-identical to what the serializer emits today,
// so editing a template without regenerating its fixture fails here and a
// template that stops satisfying a Go rule fails there.

// Vitest's root is frontend/ (vite.renderer.config.ts), which is also where
// `npm test` runs from.
const TEMPLATE_FIXTURE_DIR = resolve(process.cwd(), "../backend/internal/pipeline/testdata/templates");

function fixtureYaml(id: string): string {
	const path = resolve(TEMPLATE_FIXTURE_DIR, `${id}.yaml`);
	try {
		return readFileSync(path, "utf8");
	} catch {
		throw new Error(`missing template fixture ${path}; regenerate it from serializeToYaml(template.draft())`);
	}
}

const KNOWN_EXECUTORS = new Set<string>(ALL_EXECUTOR_KINDS);
const KNOWN_WORKSPACES = new Set<string>(ALL_WORKSPACE_KINDS);
const KNOWN_PR_EVENTS = new Set<string>(ALL_PR_EVENTS);
const KNOWN_SESSION_EVENTS = new Set<string>(ALL_SESSION_EVENTS);
const KNOWN_SCOPES = new Set<string>(ALL_CONCURRENCY_SCOPES);
const KNOWN_OUTCOMES = new Set<string>(SETTLED_OUTCOMES);

function draftViolations(draft: PipelineDraft): string[] {
	const out: string[] = [];
	if (draft.name.trim() === "") out.push("name: must not be empty");
	if (draft.stages.length === 0) out.push("stages: at least one stage required");

	const ids = draft.stages.map((s) => s.id);
	const idSet = new Set(ids);
	if (idSet.size !== ids.length) out.push("stages: duplicate stage ids");

	for (const event of draft.on?.pr ?? []) {
		if (!KNOWN_PR_EVENTS.has(event)) out.push(`on.pr: unknown event ${event}`);
	}
	for (const event of draft.on?.session ?? []) {
		if (!KNOWN_SESSION_EVENTS.has(event)) out.push(`on.session: unknown event ${event}`);
	}
	if (draft.concurrency?.scope && !KNOWN_SCOPES.has(draft.concurrency.scope)) {
		out.push(`concurrency.scope: unknown scope ${draft.concurrency.scope}`);
	}
	if (draft.defaults?.onFailure && !idSet.has(draft.defaults.onFailure)) {
		out.push(`defaults.onFailure: unknown stage ${draft.defaults.onFailure}`);
	}

	// Inbound success edges decide where `needs` is required and what it must
	// equal; failure edges are never counted (spec §9.2).
	const inboundSuccess = new Map<string, string[]>();
	for (const stage of draft.stages) {
		for (const to of stage.onSuccess ?? []) {
			inboundSuccess.set(to, [...(inboundSuccess.get(to) ?? []), stage.id]);
		}
	}

	for (const [i, stage] of draft.stages.entries()) {
		const base = `stages[${i}]`;
		if (stage.id.trim() === "") out.push(`${base}.id: must not be empty`);
		if (!KNOWN_EXECUTORS.has(stage.executor)) out.push(`${base}.executor: unknown kind ${stage.executor}`);

		if (stage.executor === "agent") {
			if (!stage.agent) out.push(`${base}.agent: required on an agent stage`);
			if (!stage.prompt) out.push(`${base}.prompt: required on an agent stage`);
			// §8: the credential tier is a schema property, not a convention.
			if (stage.credentials?.length) out.push(`${base}.credentials: forbidden on an agent stage`);
		} else {
			if (!stage.run) out.push(`${base}.run: required on a command stage`);
			if (stage.produces) out.push(`${base}.produces: forbidden on a command stage`);
		}
		if (stage.produces && /[\\/]/.test(stage.produces)) {
			out.push(`${base}.produces: must be a bare filename`);
		}
		if (stage.workspace && !KNOWN_WORKSPACES.has(stage.workspace)) {
			out.push(`${base}.workspace: unknown workspace ${stage.workspace}`);
		}
		for (const outcome of stage.session?.killOn ?? []) {
			if (!KNOWN_OUTCOMES.has(outcome)) out.push(`${base}.session.killOn: unknown outcome ${outcome}`);
		}

		for (const to of stage.onSuccess ?? []) {
			if (!idSet.has(to)) out.push(`${base}.onSuccess: unknown stage ${to}`);
		}
		if (stage.onFailure && !idSet.has(stage.onFailure)) {
			out.push(`${base}.onFailure: unknown stage ${stage.onFailure}`);
		}

		const inbound = inboundSuccess.get(stage.id) ?? [];
		const needs = stage.needs ?? [];
		for (const need of needs) {
			if (!idSet.has(need)) out.push(`${base}.needs: unknown stage ${need}`);
		}
		if (inbound.length > 1 && needs.length === 0) out.push(`${base}.needs: required, ${inbound.length} inbound edges`);
		if (needs.length > 0 && [...needs].sort().join(",") !== [...inbound].sort().join(",")) {
			out.push(`${base}.needs: does not match the inbound success edges`);
		}
		if (stage.workspace === "inherit" && inbound.length > 1) {
			out.push(`${base}.workspace: inherit needs exactly one inbound success edge`);
		}
	}

	return out;
}

describe("PIPELINE_TEMPLATES", () => {
	it("offers the three starter concepts", () => {
		expect(PIPELINE_TEMPLATES.map((t) => t.id)).toEqual(["pr-review", "session-idle-triage", "release-gate"]);
	});

	for (const template of PIPELINE_TEMPLATES) {
		describe(template.name, () => {
			it("returns a fresh draft per call", () => {
				const a = template.draft();
				const b = template.draft();
				expect(a).not.toBe(b);
				expect(a.stages).not.toBe(b.stages);
				expect(a).toEqual(b);
			});

			it("matches the YAML fixture the Go validator runs against", () => {
				expect(serializeToYaml(template.draft())).toBe(fixtureYaml(template.id));
			});

			it("round-trips through the codec unchanged", () => {
				const draft = template.draft();
				const parsed = parseYamlToDraft(serializeToYaml(draft));
				expect(parsed.parseError).toBeUndefined();
				expect(parsed.draft).toEqual(draft);
			});

			it("passes the mirrored backend validation rules", () => {
				expect(draftViolations(template.draft())).toEqual([]);
			});

			it("has an acyclic routing graph", () => {
				expect(cycleStageIds(template.draft())).toEqual(new Set());
			});
		});
	}

	// The shape of each starter, pinned. These are the properties that make the
	// template worth shipping rather than incidental details of the YAML.
	function byId(id: string) {
		return PIPELINE_TEMPLATES.find((t) => t.id === id)!.draft();
	}

	it("pr-review reviews with an agent and posts with a command", () => {
		const draft = byId("pr-review");
		expect(draft.on).toEqual({ pr: ["created", "updated"] });
		expect(draft.concurrency).toEqual({ scope: "pr", cancelInProgress: true });

		const review = draft.stages.find((s) => s.executor === "agent");
		expect(review?.produces).toBe("review.md");
		expect(review?.credentials).toBeUndefined();

		// The §6.4 split: the agent produces the file, a command performs the
		// unverifiable action with the credential.
		const post = draft.stages.find((s) => s.id === "post-review");
		expect(post?.executor).toBe("command");
		expect(post?.run).toContain("agent-outputs/review.md");
		expect(post?.credentials).toEqual(["github-review"]);
		expect(review?.onSuccess).toEqual(["post-review"]);
	});

	it("session-idle-triage is one agent stage that never kills the session", () => {
		const draft = byId("session-idle-triage");
		expect(draft.on).toEqual({ session: ["idle"] });
		expect(draft.stages).toHaveLength(1);
		expect(draft.stages[0].executor).toBe("agent");
		// An explicit empty list, not an absent block: the engine default would
		// kill the human's own session (§7.2).
		expect(draft.stages[0].session).toEqual({ killOn: [] });
	});

	it("release-gate fans out, joins on needs, and routes failure through defaults", () => {
		const draft = byId("release-gate");
		expect(draft.stages).toHaveLength(6);
		expect(draft.concurrency).toEqual({ scope: "project", group: "release", cancelInProgress: false });
		expect(draft.defaults?.onFailure).toBe("notify-failure");

		const prepare = draft.stages.find((s) => s.id === "prepare");
		expect(prepare?.onSuccess).toEqual(["build", "release-notes"]);
		// Concurrent stages get a tree each; three parallel npm ci in one tree is
		// a corrupt node_modules (§5.2).
		expect(draft.stages.find((s) => s.id === "build")?.workspace).toBe("stage");
		expect(draft.stages.find((s) => s.id === "release-notes")?.workspace).toBe("stage");

		const publish = draft.stages.find((s) => s.id === "publish");
		expect(publish?.needs).toEqual(["release-notes", "verify"]);
		expect(publish?.credentials).toEqual(["github-release"]);

		// Every stage relies on defaults.on_failure; none repeats the key.
		expect(draft.stages.filter((s) => s.onFailure)).toEqual([]);
	});
});
