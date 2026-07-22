import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PipelineCanvas } from "./PipelineCanvas";
import type { StageSelection } from "../hooks/useStageSelection";
import type { PipelineDraft, StageDraft } from "../lib/pipeline-draft";

function stage(name: string, overrides?: Partial<StageDraft>): StageDraft {
	return {
		name,
		trigger: { on: ["manual"] },
		executor: { kind: "agent", plugin: "claude-code", mode: "review" },
		...overrides,
	};
}

function draftOf(...stages: StageDraft[]): PipelineDraft {
	return { name: "pr-review-loop", stages };
}

function nodeX(container: HTMLElement, id: string): number {
	const el = container.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
	const match = /translate\((-?[\d.]+)px/.exec(el.style.transform);
	return match ? Number(match[1]) : NaN;
}

// The editor shell's useStageSelection instance, as the canvas receives it.
function selectionOf(selectedStage: string | null = null) {
	return { selectedStage, selectStage: vi.fn<StageSelection["selectStage"]>() };
}

describe("PipelineCanvas", () => {
	it("renders one card per stage with executor-kind details", () => {
		const draft = draftOf(
			stage("review", {
				routes: { when: { kind: "not", predicate: { kind: "no_open_findings" } } },
				workspace: "isolated-rw",
				maxLoopRounds: 5,
			}),
			stage("tests", { executor: { kind: "command", command: "npm", args: ["test"] } }),
			stage("triage", { executor: { kind: "builtin", name: "compose" } }),
		);
		render(<PipelineCanvas draft={draft} />);

		expect(screen.getByText("review")).toBeInTheDocument();
		expect(screen.getByText("claude-code · review")).toBeInTheDocument();
		expect(screen.getByLabelText("Agent stage")).toHaveTextContent("A");

		expect(screen.getByText("tests")).toBeInTheDocument();
		expect(screen.getByText("npm test")).toBeInTheDocument();
		expect(screen.getByLabelText("Command stage")).toHaveTextContent("$");

		expect(screen.getByText("triage")).toBeInTheDocument();
		expect(screen.getByText("compose")).toBeInTheDocument();
		expect(screen.getByLabelText("Builtin stage")).toHaveTextContent("f");

		// Routes chip + workspace/rounds footer (mockup 1a).
		expect(screen.getByText("when: not( no_open_findings )")).toBeInTheDocument();
		expect(screen.getByText("isolated-rw · 5 rounds")).toBeInTheDocument();
	});

	it("appends a default stage through the draft on Add stage", async () => {
		const onDraftChange = vi.fn();
		const selection = selectionOf();
		render(<PipelineCanvas draft={draftOf(stage("review"))} onDraftChange={onDraftChange} selection={selection} />);

		await userEvent.setup().click(screen.getByRole("button", { name: /Add stage/ }));

		expect(onDraftChange).toHaveBeenCalledTimes(1);
		const next = onDraftChange.mock.calls[0][0] as PipelineDraft;
		expect(next.stages.map((s) => s.name)).toEqual(["review", "stage-2"]);
		expect(next.stages[1].executor.kind).toBe("agent");
		// The new stage's node id (its index) becomes the selection.
		expect(selection.selectStage).toHaveBeenCalledWith("1");
	});

	it("disables Add stage when the canvas is read-only", () => {
		render(<PipelineCanvas draft={draftOf(stage("review"))} />);
		expect(screen.getByRole("button", { name: /Add stage/ })).toBeDisabled();
	});

	it("publishes the clicked node's id (its index) through the shared selection", () => {
		const selection = selectionOf();
		render(
			<PipelineCanvas draft={draftOf(stage("review"), stage("fix"))} onDraftChange={vi.fn()} selection={selection} />,
		);

		// fireEvent, not userEvent: a full pointer sequence trips d3-drag's
		// mousedown handling, which jsdom cannot satisfy.
		fireEvent.click(screen.getByText("fix"));

		expect(selection.selectStage).toHaveBeenCalledWith("1");
	});

	it("highlights the node the shared selection points at", () => {
		render(<PipelineCanvas draft={draftOf(stage("review"), stage("fix"))} selection={selectionOf("1")} />);

		expect(document.querySelector('.react-flow__node[data-id="1"]')).toHaveClass("selected");
		expect(document.querySelector('.react-flow__node[data-id="0"]')).not.toHaveClass("selected");
	});

	it("renders empty- and duplicate-named stages as distinct selectable nodes", () => {
		const selection = selectionOf();
		render(
			<PipelineCanvas
				draft={draftOf(stage(""), stage("dup"), stage("dup"))}
				onDraftChange={vi.fn()}
				selection={selection}
			/>,
		);

		expect(screen.getByText("(unnamed)")).toBeInTheDocument();
		expect(screen.getAllByText("dup")).toHaveLength(2);

		fireEvent.click(screen.getByText("(unnamed)"));
		expect(selection.selectStage).toHaveBeenLastCalledWith("0");

		fireEvent.click(screen.getAllByText("dup")[1]);
		expect(selection.selectStage).toHaveBeenLastCalledWith("2");
	});

	it("auto-layouts dependencies left of dependents", () => {
		const draft = draftOf(
			stage("intake"),
			stage("review", { dependsOn: ["intake"] }),
			stage("fix", { dependsOn: ["review"] }),
		);
		const { container } = render(<PipelineCanvas draft={draft} />);

		expect(nodeX(container, "0")).toBeLessThan(nodeX(container, "1"));
		expect(nodeX(container, "1")).toBeLessThan(nodeX(container, "2"));
	});

	it("re-runs layout from the Auto-layout button", async () => {
		const { container } = render(
			<PipelineCanvas draft={draftOf(stage("a"), stage("b", { dependsOn: ["a"] }))} onDraftChange={vi.fn()} />,
		);

		await userEvent.setup().click(screen.getByRole("button", { name: /Auto-layout/ }));

		expect(nodeX(container, "0")).toBeLessThan(nodeX(container, "1"));
	});

	it("removes the selected stage from the draft on Delete/Backspace", async () => {
		const onDraftChange = vi.fn();
		const selection = selectionOf("0");
		const draft = draftOf(stage("review"), stage("fix", { dependsOn: ["review"] }));
		render(<PipelineCanvas draft={draft} onDraftChange={onDraftChange} selection={selection} />);

		fireEvent.keyDown(document.querySelector(".react-flow")!, { key: "Backspace" });

		await screen.findByText("fix");
		// react-flow emits a remove for the connected edge too; the last draft
		// carries the final state (edge scrub folded into the stage removal).
		const next = onDraftChange.mock.calls.at(-1)![0] as PipelineDraft;
		expect(next.stages.map((s) => s.name)).toEqual(["fix"]);
		// The removed stage is scrubbed from the survivor's dependsOn.
		expect(next.stages[0].dependsOn).toBeUndefined();
		// The selection no longer points at anything.
		expect(selection.selectStage).toHaveBeenCalledWith(null);
	});

	// Edge DOM rendering needs measured node dimensions React Flow only gets in
	// a real browser; the draft -> edge mapping (add, remove, cycle styling) is
	// covered by pipeline-graph.test.ts.

	it("marks stages on an existing dependency cycle (mockup 1d)", () => {
		const draft = draftOf(
			stage("intake"),
			stage("fix", { dependsOn: ["verify", "intake"] }),
			stage("verify", { dependsOn: ["fix"] }),
		);
		render(<PipelineCanvas draft={draft} />);

		expect(screen.getAllByText("in dependency cycle")).toHaveLength(2);
		expect(document.querySelector('[data-stage-name="fix"]')).toHaveAttribute("data-in-cycle");
		expect(document.querySelector('[data-stage-name="verify"]')).toHaveAttribute("data-in-cycle");
		expect(document.querySelector('[data-stage-name="intake"]')).not.toHaveAttribute("data-in-cycle");
	});

	it("renders validation badges on affected nodes (mockup 1d)", () => {
		render(
			<PipelineCanvas
				draft={draftOf(stage("review"), stage("fix"))}
				stageIssues={{ "0": ["task.prompt is required", "unknown plugin"] }}
			/>,
		);

		expect(screen.getByLabelText("2 validation problems")).toBeInTheDocument();
		// The first message renders inline on the card.
		expect(screen.getByText("task.prompt is required")).toBeInTheDocument();
		expect(document.querySelector('[data-stage-name="review"]')).toHaveAttribute("data-issue-count", "2");
		expect(document.querySelector('[data-stage-name="fix"]')).not.toHaveAttribute("data-issue-count");
	});

	it("shows a blocks-merge badge for a stage whose policy.blocksMerge is true", () => {
		const draft = draftOf(
			stage("review", { policy: { blocksMerge: true } }),
			stage("fix", { policy: { blocksMerge: false } }),
			stage("triage"),
		);
		render(<PipelineCanvas draft={draft} />);

		expect(screen.getAllByText("blocks merge")).toHaveLength(1);
		expect(document.querySelector('[data-stage-name="review"] span.text-warning')).toHaveTextContent("blocks merge");
		expect(document.querySelector('[data-stage-name="fix"]')).not.toHaveTextContent("blocks merge");
		expect(document.querySelector('[data-stage-name="triage"]')).not.toHaveTextContent("blocks merge");
	});

	it("shows the zoom indicator and view controls", () => {
		render(<PipelineCanvas draft={draftOf(stage("review"))} />);

		expect(screen.getByLabelText("Zoom level")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Zoom out" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Fit view" })).toBeInTheDocument();
	});
});
