import { describe, expect, it } from "vitest";
import type { PipelineDraft, StageDraft } from "./pipeline-draft";
import { applyEnvCompletion, envCompletionAt, matchEnvVars, stageEnvVars, type StageEnvVar } from "./pipeline-env";

function stage(id: string, extra: Partial<StageDraft> = {}): StageDraft {
	return { id, executor: "agent", agent: "claude-code", ...extra };
}

function draftOf(stages: StageDraft[], rest: Partial<PipelineDraft> = {}): PipelineDraft {
	return { name: "p", stages, ...rest };
}

// The catalog is keyed by name everywhere, so every assertion goes through this
// rather than an index into the array.
function look(draft: PipelineDraft, target: StageDraft, name: string): StageEnvVar {
	const found = stageEnvVars(draft, target).find((v) => v.name === name);
	if (!found) throw new Error(`no catalog entry for ${name}`);
	return found;
}

// The shape the availability rules all key off:
//
//   build --success--> test --success--> ship
//   build --failure--> triage
const routedDraft = () =>
	draftOf([
		stage("build", { onSuccess: ["test"], onFailure: "triage" }),
		stage("test", { onSuccess: ["ship"] }),
		stage("ship"),
		stage("triage"),
	]);

describe("stageEnvVars", () => {
	it("always offers the seven the engine never omits", () => {
		const draft = routedDraft();
		const vars = stageEnvVars(draft, draft.stages[1]);
		const always = vars.filter((v) => v.availability === "always").map((v) => v.name);
		expect(always).toEqual([
			"AO_PROJECT",
			"AO_RUN_ID",
			"AO_RUN_DIR",
			"AO_STAGE",
			"AO_ATTEMPT",
			"AO_CONTEXT",
			"AO_WORKSPACE",
			"AO_PREV_STAGE",
			"AO_PREV_OUTCOME",
		]);
	});

	// The spec says "1, or 2 after a nudge"; the engine stamps it at launch and a
	// nudge never relaunches, so the reference must not repeat the spec here.
	it("describes AO_ATTEMPT as always 1, not as the spec's 1-or-2", () => {
		const draft = routedDraft();
		const attempt = look(draft, draft.stages[0], "AO_ATTEMPT");
		expect(attempt.example).toBe("1");
		expect(attempt.description).toMatch(/always 1/i);
		expect(attempt.description).not.toMatch(/\b2 after a nudge\b/);
	});

	it("takes the contextual examples from the stage itself", () => {
		const draft = routedDraft();
		expect(look(draft, draft.stages[1], "AO_STAGE").example).toBe("test");
		expect(look(draft, draft.stages[1], "AO_PREV_STAGE").example).toBe("build");
		const produces = stage("review", { produces: "review.md" });
		expect(look(draftOf([produces]), produces, "AO_OUTPUT").example).toMatch(/agent-outputs\/review\.md$/);
		const staged = stage("lint", { workspace: "stage" });
		expect(look(draftOf([staged]), staged, "AO_WORKSPACE").example).toMatch(/workspaces\/lint$/);
	});

	describe("AO_OUTPUT", () => {
		it("is available exactly when an agent stage declares produces", () => {
			const withProduces = stage("review", { produces: "review.md" });
			expect(look(draftOf([withProduces]), withProduces, "AO_OUTPUT").availability).toBe("always");
		});

		it("is greyed with the missing key as the reason", () => {
			const bare = stage("review");
			const out = look(draftOf([bare]), bare, "AO_OUTPUT");
			expect(out.availability).toBe("never");
			expect(out.note).toMatch(/produces/);
		});

		it("is greyed on a command stage, which cannot declare produces at all", () => {
			const cmd: StageDraft = { id: "tests", executor: "command", run: "npm test" };
			const out = look(draftOf([cmd]), cmd, "AO_OUTPUT");
			expect(out.availability).toBe("never");
			expect(out.note).toMatch(/agent stages only/);
		});
	});

	describe("subject variables", () => {
		const only = (on: PipelineDraft["on"]) => {
			const s = stage("build");
			return (name: string) => look(draftOf([s], { on }), s, name);
		};

		it("guarantees the session id under a session-only trigger", () => {
			expect(only({ session: ["idle"] })("AO_SESSION_ID").availability).toBe("always");
		});

		it("keeps the session id conditional under a pr trigger, where sessionless is normal", () => {
			expect(only({ pr: ["created"] })("AO_SESSION_ID").availability).toBe("sometimes");
			expect(only({ pr: ["created"], session: ["idle"] })("AO_SESSION_ID").availability).toBe("sometimes");
		});

		it("greys the session id on a manual-only pipeline", () => {
			const v = only({})("AO_SESSION_ID");
			expect(v.availability).toBe("never");
			expect(v.note).toMatch(/session\.\*/);
		});

		it("offers the pr trio under a pr trigger and greys it without one", () => {
			for (const name of ["AO_PR_NUMBER", "AO_PR_REPO", "AO_PR_HEAD"]) {
				expect(only({ pr: ["merge-ready"] })(name).availability).toBe("always");
				expect(only({ pr: ["merge-ready"], session: ["idle"] })(name).availability).toBe("sometimes");
				const missing = only({ session: ["idle"] })(name);
				expect(missing.availability).toBe("never");
				expect(missing.note).toMatch(/pr\.\*/);
			}
		});
	});

	describe("AO_PREV_STAGE", () => {
		it("is unset at the stage a run starts from", () => {
			const draft = routedDraft();
			const prev = look(draft, draft.stages[0], "AO_PREV_STAGE");
			expect(prev.availability).toBe("never");
			expect(prev.note).toMatch(/no predecessor/);
		});

		it("is set on the single success successor", () => {
			const draft = routedDraft();
			expect(look(draft, draft.stages[1], "AO_PREV_STAGE").availability).toBe("always");
		});

		it("is unset at a join, where the predecessor would be ambiguous", () => {
			const draft = draftOf([
				stage("a", { onSuccess: ["j"] }),
				stage("b", { onSuccess: ["j"] }),
				stage("j", { needs: ["a", "b"] }),
			]);
			const prev = look(draft, draft.stages[2], "AO_PREV_STAGE");
			expect(prev.availability).toBe("never");
			expect(prev.note).toMatch(/join/);
		});

		it("is conditional on a stage a failure edge can also enter", () => {
			const draft = draftOf([stage("build", { onSuccess: ["report"], onFailure: "report" }), stage("report")]);
			expect(look(draft, draft.stages[1], "AO_PREV_STAGE").availability).toBe("sometimes");
		});
	});

	describe("AO_FAILED_STAGE", () => {
		it("is greyed where nothing routes here on failure", () => {
			const draft = routedDraft();
			const failed = look(draft, draft.stages[1], "AO_FAILED_STAGE");
			expect(failed.availability).toBe("never");
			expect(failed.note).toMatch(/on_failure/);
		});

		it("is guaranteed on a stage only a failure edge reaches", () => {
			const draft = routedDraft();
			const failed = look(draft, draft.stages[3], "AO_FAILED_STAGE");
			expect(failed.availability).toBe("always");
			expect(failed.example).toBe("build");
		});

		it("counts the synthetic defaults.on_failure edge", () => {
			const draft = draftOf([stage("build"), stage("notify")], { defaults: { onFailure: "notify" } });
			expect(look(draft, draft.stages[1], "AO_FAILED_STAGE").availability).toBe("always");
		});

		it("is conditional where success can also enter", () => {
			const draft = draftOf([stage("build", { onSuccess: ["notify"] }), stage("notify")], {
				defaults: { onFailure: "notify" },
			});
			expect(look(draft, draft.stages[1], "AO_FAILED_STAGE").availability).toBe("sometimes");
		});
	});
});

describe("envCompletionAt", () => {
	const at = (text: string) => envCompletionAt(text, text.length);

	it("opens on $AO and reports the token", () => {
		expect(at("Write to $AO")).toEqual({ start: 9, query: "AO" });
		expect(at("Write to $AO_PR")).toEqual({ start: 9, query: "AO_PR" });
		expect(at("$ao_out")).toEqual({ start: 0, query: "ao_out" });
	});

	it("stays shut on a bare $ and on other shell variables", () => {
		expect(at("cd $")).toBeNull();
		expect(at("echo $HOME")).toBeNull();
		expect(at("echo $A")).toBeNull();
	});

	it("stays shut without a $, and on the braced form", () => {
		expect(at("AO_OUTPUT")).toBeNull();
		expect(at("echo ${AO_OUT")).toBeNull();
	});

	it("reads the token at the caret, not at the end of the text", () => {
		const text = "echo $AO_OUT and $AO_RUN_ID";
		expect(envCompletionAt(text, 12)).toEqual({ start: 5, query: "AO_OUT" });
		// Caret inside a word but not at its end still completes the prefix.
		expect(envCompletionAt(text, 8)).toEqual({ start: 5, query: "AO" });
	});
});

describe("matchEnvVars", () => {
	const draft = draftOf([stage("build")]);
	const vars = stageEnvVars(draft, draft.stages[0]);

	it("prefix-matches on the name, case-insensitively", () => {
		expect(matchEnvVars(vars, "AO_PR").map((v) => v.name)).toEqual([
			// AO_PROJECT shares the prefix and is the only offered one here, so it
			// leads; the greyed ones keep catalog order behind it.
			"AO_PROJECT",
			"AO_PR_NUMBER",
			"AO_PR_REPO",
			"AO_PR_HEAD",
			"AO_PREV_STAGE",
			"AO_PREV_OUTCOME",
		]);
		expect(matchEnvVars(vars, "ao_ru").map((v) => v.name)).toEqual(["AO_RUN_ID", "AO_RUN_DIR"]);
	});

	it("sorts the unavailable ones last so a greyed entry never leads", () => {
		// This stage has no produces and no triggers, so AO_OUTPUT and the PR
		// trio are all greyed; every offered entry must come first.
		const names = matchEnvVars(vars, "AO").map((v) => v.availability !== "never");
		expect(names).toEqual([...names].sort((a, b) => Number(b) - Number(a)));
	});

	it("returns nothing when the token matches no variable", () => {
		expect(matchEnvVars(vars, "AO_ZZ")).toEqual([]);
	});
});

describe("applyEnvCompletion", () => {
	it("replaces the typed token and leaves the caret after the name", () => {
		const value = "Write your review to $AO_OU then stop.";
		const completion = envCompletionAt(value, 27);
		expect(completion).not.toBeNull();
		const next = applyEnvCompletion(value, completion!, "AO_OUTPUT");
		expect(next.value).toBe("Write your review to $AO_OUTPUT then stop.");
		expect(next.caret).toBe("Write your review to $AO_OUTPUT".length);
	});

	it("keeps the rest of the line intact when completing mid-text", () => {
		const value = "cat $AO/x";
		const next = applyEnvCompletion(value, { start: 4, query: "AO" }, "AO_CONTEXT");
		expect(next.value).toBe("cat $AO_CONTEXT/x");
	});
});
