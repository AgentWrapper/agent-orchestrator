import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { PipelineSettingsModal } from "./PipelineSettingsModal";
import type { PipelineDraft } from "../lib/pipeline-draft";

function baseDraft(): PipelineDraft {
	return {
		name: "pr-review-loop",
		stages: [
			{ name: "security-review", trigger: { on: ["pr.opened"] }, executor: { kind: "agent" } },
			{ name: "verify", trigger: { on: ["manual"] }, executor: { kind: "agent" } },
		],
	};
}

// The harness exposes the committed draft so tests assert exactly what Done
// handed back through the V1 setDraft path.
let committed: PipelineDraft;

function Harness({ initial }: { initial: PipelineDraft }) {
	const [draft, setDraft] = useState(initial);
	const [open, setOpen] = useState(true);
	committed = draft;
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				open settings
			</button>
			<PipelineSettingsModal
				open={open}
				value={draft}
				onCancel={() => setOpen(false)}
				onDone={(next) => {
					setDraft(next);
					setOpen(false);
				}}
			/>
		</>
	);
}

describe("PipelineSettingsModal", () => {
	it("binds name, max concurrent, and allow fork PRs, committing on Done", async () => {
		const user = userEvent.setup();
		render(<Harness initial={baseDraft()} />);

		const name = screen.getByRole("textbox", { name: "Pipeline name" });
		await user.clear(name);
		await user.type(name, "nightly-triage");

		await user.click(screen.getByRole("button", { name: "Increase max concurrent" }));
		await user.click(screen.getByRole("button", { name: "Increase max concurrent" }));
		await user.click(screen.getByRole("switch", { name: "Allow fork PRs" }));

		await user.click(screen.getByRole("button", { name: "Done" }));
		expect(committed).toEqual({
			...baseDraft(),
			name: "nightly-triage",
			maxConcurrentStages: 2,
			allowForkPRs: true,
		});
	});

	it("steps max concurrent down but never below 1", async () => {
		const user = userEvent.setup();
		render(<Harness initial={{ ...baseDraft(), maxConcurrentStages: 2 }} />);

		const decrease = screen.getByRole("button", { name: "Decrease max concurrent" });
		await user.click(decrease);
		expect(screen.getByRole("spinbutton", { name: "Max concurrent" })).toHaveValue(1);
		expect(decrease).toBeDisabled();

		await user.click(screen.getByRole("button", { name: "Done" }));
		expect(committed.maxConcurrentStages).toBe(1);
	});

	it("keeps an untouched draft unchanged, exit conditions included", async () => {
		const user = userEvent.setup();
		render(<Harness initial={baseDraft()} />);

		await user.click(screen.getByRole("button", { name: "Done" }));
		expect(committed).toEqual(baseDraft());
		expect(committed.exitPredicates).toBeUndefined();
	});

	it("edits each exit condition on its own tab via the builder", async () => {
		const user = userEvent.setup();
		render(<Harness initial={baseDraft()} />);

		// done tab is active by default and starts unset.
		expect(screen.getByText("Run is done when…")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "+ Condition" }));
		expect(screen.getByTestId("compiled-predicate")).toHaveTextContent("no_open_findings");

		// stalled gets its own predicate without touching done's.
		await user.click(screen.getByRole("tab", { name: "stalled" }));
		expect(screen.getByText("Run is stalled when…")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "+ Condition" }));
		const row = screen.getByRole("combobox", { name: "Condition kind" }).closest("div")!;
		await user.click(within(row).getByRole("combobox", { name: "Condition kind" }));
		await user.click(await screen.findByRole("option", { name: "loop rounds at least" }));

		await user.click(screen.getByRole("button", { name: "Done" }));
		expect(committed.exitPredicates).toEqual({
			done: { kind: "no_open_findings" },
			stalled: { kind: "loop_rounds_at_least", n: 1 },
		});
		// blocksMerge was never touched and stays unset.
		expect(committed.exitPredicates?.blocksMerge).toBeUndefined();
	});

	it("removing a condition unsets it, dropping exitPredicates when all are unset", async () => {
		const user = userEvent.setup();
		render(<Harness initial={{ ...baseDraft(), exitPredicates: { done: { kind: "no_open_findings" } } }} />);

		await user.click(screen.getByRole("button", { name: "Remove condition" }));
		expect(screen.getByText("No condition · always matches.")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Done" }));
		expect(committed.exitPredicates).toBeUndefined();
	});

	it("discards edits on Cancel and reseeds on reopen", async () => {
		const user = userEvent.setup();
		render(<Harness initial={baseDraft()} />);

		const name = screen.getByRole("textbox", { name: "Pipeline name" });
		await user.clear(name);
		await user.type(name, "scrapped");
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(committed).toEqual(baseDraft());
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "open settings" }));
		expect(screen.getByRole("textbox", { name: "Pipeline name" })).toHaveValue("pr-review-loop");
	});
});
