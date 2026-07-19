import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CompiledPredicateReadout, PredicateBuilder } from "./PredicateBuilder";
import { PredicateBuilderModal } from "./PredicateBuilderModal";
import type { PipelineDraft, PredicateDraft } from "../lib/pipeline-draft";
import { parseYamlToDraft, serializeToYaml } from "../lib/pipeline-draft";

const STAGES = ["security-review", "style-review", "verify", "fix"];

// The harness exposes the live draft so tests can assert the exact
// PredicateDraft the builder produced (e.g. for the codec round-trip).
let latest: PredicateDraft | undefined;

function Harness({ initial }: { initial?: PredicateDraft }) {
	const [value, setValue] = useState<PredicateDraft | undefined>(initial);
	latest = value;
	return (
		<>
			<PredicateBuilder value={value} onChange={setValue} stageNames={STAGES} />
			<CompiledPredicateReadout value={value} />
		</>
	);
}

function compiled(): string {
	return screen.getByTestId("compiled-predicate").textContent ?? "";
}

async function pick(user: UserEvent, combobox: HTMLElement, option: string) {
	await user.click(combobox);
	await user.click(await screen.findByRole("option", { name: option }));
}

async function pickKind(user: UserEvent, kindLabel: string, index = 0) {
	await pick(user, screen.getAllByRole("combobox", { name: "Condition kind" })[index], kindLabel);
}

describe("PredicateBuilder", () => {
	it("starts empty (always) and adds a default condition", async () => {
		const user = userEvent.setup();
		render(<Harness />);

		expect(screen.getByText("No condition · always matches.")).toBeInTheDocument();
		expect(compiled()).toBe("always");

		await user.click(screen.getByRole("button", { name: "+ Condition" }));
		expect(compiled()).toBe("no_open_findings");
	});

	it("builds stage_verdict with stage and verdict selects", async () => {
		const user = userEvent.setup();
		render(<Harness initial={{ kind: "no_open_findings" }} />);

		await pickKind(user, "stage verdict");
		// Defaults: first stage + pass.
		expect(compiled()).toBe("stage_verdict(security-review, pass)");

		await pick(user, screen.getByRole("combobox", { name: "Stage" }), "verify");
		await pick(user, screen.getByRole("combobox", { name: "Verdict" }), "fail");
		expect(compiled()).toBe("stage_verdict(verify, fail)");
		expect(latest).toEqual({ kind: "stage_verdict", stage: "verify", verdict: "fail" });
	});

	it("builds the stages[] kinds with the multiselect", async () => {
		const user = userEvent.setup();
		render(<Harness initial={{ kind: "no_open_findings" }} />);

		await pickKind(user, "all pass");
		expect(compiled()).toBe("all_pass[]");

		await pick(user, screen.getByRole("combobox", { name: "Add stage" }), "security-review");
		await pick(user, screen.getByRole("combobox", { name: "Add stage" }), "style-review");
		expect(compiled()).toBe("all_pass[security-review, style-review]");

		await user.click(screen.getByRole("button", { name: "Remove stage security-review" }));
		expect(compiled()).toBe("all_pass[style-review]");

		await pickKind(user, "any pass");
		expect(compiled()).toBe("any_pass[]");
		await pickKind(user, "majority pass");
		expect(compiled()).toBe("majority_pass[]");
	});

	it("builds finding_count_below with max, severity, and optional scope", async () => {
		const user = userEvent.setup();
		render(<Harness initial={{ kind: "no_open_findings" }} />);

		await pickKind(user, "finding count below");
		expect(compiled()).toBe("finding_count_below(1)");

		const max = screen.getByRole("spinbutton", { name: "Max findings" });
		await user.clear(max);
		await user.type(max, "2");
		await pick(user, screen.getByRole("combobox", { name: "Severity" }), "error");
		expect(compiled()).toBe("finding_count_below(2, *, error)");

		await pick(user, screen.getByRole("combobox", { name: "Stage scope" }), "verify");
		expect(compiled()).toBe("finding_count_below(2, verify, error)");
		expect(latest).toEqual({ kind: "finding_count_below", max: 2, stage: "verify", severity: "error" });
	});

	it("builds the numeric kinds", async () => {
		const user = userEvent.setup();
		render(<Harness initial={{ kind: "no_open_findings" }} />);

		await pickKind(user, "loop rounds at least");
		expect(compiled()).toBe("loop_rounds_at_least(1)");
		const rounds = screen.getByRole("spinbutton", { name: "Rounds" });
		await user.clear(rounds);
		await user.type(rounds, "3");
		expect(compiled()).toBe("loop_rounds_at_least(3)");

		await pickKind(user, "stage retried at least");
		expect(compiled()).toBe("stage_retried_at_least(security-review, 1)");
		await pick(user, screen.getByRole("combobox", { name: "Stage" }), "fix");
		const retries = screen.getByRole("spinbutton", { name: "Retries" });
		await user.clear(retries);
		await user.type(retries, "3");
		expect(compiled()).toBe("stage_retried_at_least(fix, 3)");
	});

	it("scopes no_open_findings to a stage", async () => {
		const user = userEvent.setup();
		render(<Harness initial={{ kind: "no_open_findings" }} />);

		await pick(user, screen.getByRole("combobox", { name: "Stage scope" }), "verify");
		expect(compiled()).toBe("no_open_findings(verify)");
		await pick(user, screen.getByRole("combobox", { name: "Stage scope" }), "any stage");
		expect(compiled()).toBe("no_open_findings");
		expect(latest).toEqual({ kind: "no_open_findings" });
	});

	it("nests a group inside a group and toggles ALL/ANY", async () => {
		const user = userEvent.setup();
		render(<Harness initial={{ kind: "and", predicates: [{ kind: "no_open_findings" }] }} />);

		await user.click(screen.getByRole("button", { name: "+ Group" }));
		expect(compiled()).toBe(["and(", "  no_open_findings,", "  and( no_open_findings )", ")"].join("\n"));

		// First "Group type" select is the root group, second the nested one.
		await pick(user, screen.getAllByRole("combobox", { name: "Group type" })[0], "ANY");
		expect(compiled()).toBe(["or(", "  no_open_findings,", "  and( no_open_findings )", ")"].join("\n"));
		expect(latest).toEqual({
			kind: "or",
			predicates: [{ kind: "no_open_findings" }, { kind: "and", predicates: [{ kind: "no_open_findings" }] }],
		});
	});

	it("wraps a condition in not and unwraps it", async () => {
		const user = userEvent.setup();
		render(<Harness initial={{ kind: "no_open_findings" }} />);

		await user.click(screen.getByRole("button", { name: "Wrap condition in not" }));
		expect(compiled()).toBe("not( no_open_findings )");
		expect(latest).toEqual({ kind: "not", predicate: { kind: "no_open_findings" } });

		await user.click(screen.getByRole("button", { name: "Unwrap not" }));
		expect(compiled()).toBe("no_open_findings");
	});

	it("wraps a group in not", async () => {
		const user = userEvent.setup();
		render(<Harness initial={{ kind: "and", predicates: [{ kind: "no_open_findings" }] }} />);

		await user.click(screen.getByRole("button", { name: "Wrap group in not" }));
		expect(compiled()).toBe("not( and( no_open_findings ) )");
	});

	it("removes rows, and removing the root returns to the empty state", async () => {
		const user = userEvent.setup();
		render(
			<Harness
				initial={{ kind: "and", predicates: [{ kind: "no_open_findings" }, { kind: "loop_rounds_at_least", n: 2 }] }}
			/>,
		);

		await user.click(screen.getAllByRole("button", { name: "Remove condition" })[0]);
		expect(compiled()).toBe(["and(", "  loop_rounds_at_least(2)", ")"].join("\n"));

		await user.click(screen.getByRole("button", { name: "Remove group" }));
		expect(compiled()).toBe("always");
		expect(screen.getByText("No condition · always matches.")).toBeInTheDocument();
	});

	it("round-trips a built predicate through the V1 codec", async () => {
		const user = userEvent.setup();
		render(<Harness initial={{ kind: "and", predicates: [{ kind: "no_open_findings" }] }} />);

		// Build not( and( no_open_findings, stage_verdict(security-review, pass) ) )
		// entirely through the UI, then round-trip the resulting draft.
		await user.click(screen.getByRole("button", { name: "+ Condition" }));
		await pickKind(user, "stage verdict", 1);
		await user.click(screen.getByRole("button", { name: "Wrap group in not" }));
		expect(compiled()).toBe("not( and( no_open_findings, stage_verdict(security-review, pass) ) )");

		const pipeline: PipelineDraft = {
			name: "p",
			stages: [
				{
					name: "review",
					trigger: { on: ["manual"] },
					executor: { kind: "agent", plugin: "claude-code", mode: "review" },
					routes: { when: latest! },
				},
			],
		};
		const { draft, error } = parseYamlToDraft(serializeToYaml(pipeline));
		expect(error).toBeUndefined();
		expect(draft.stages[0].routes?.when).toEqual(latest);
	});
});

describe("PredicateBuilderModal", () => {
	it("commits edits on Done and renders the readout", async () => {
		const user = userEvent.setup();
		const onDone = vi.fn();
		render(
			<PredicateBuilderModal
				open
				title="Edit condition"
				value={undefined}
				stageNames={STAGES}
				onCancel={() => {}}
				onDone={onDone}
			/>,
		);

		expect(screen.getByText("Edit condition")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "+ Condition" }));
		expect(compiled()).toBe("no_open_findings");

		await user.click(screen.getByRole("button", { name: "Done" }));
		expect(onDone).toHaveBeenCalledWith({ kind: "no_open_findings" });
	});

	it("discards edits on Cancel", async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();
		const onDone = vi.fn();
		render(
			<PredicateBuilderModal
				open
				title="Edit condition"
				value={{ kind: "no_open_findings" }}
				stageNames={STAGES}
				onCancel={onCancel}
				onDone={onDone}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Wrap condition in not" }));
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onCancel).toHaveBeenCalled();
		expect(onDone).not.toHaveBeenCalled();
	});
});
