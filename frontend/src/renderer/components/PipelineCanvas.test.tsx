import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PipelineCanvas } from "./PipelineCanvas";
import type { StageSelection } from "../hooks/useStageSelection";
import type { PipelineDraft, StageDraft } from "../lib/pipeline-draft";
import { edgeAppearance } from "../lib/pipeline-graph";

function stage(id: string, overrides?: Partial<StageDraft>): StageDraft {
	return { id, executor: "agent", agent: "claude-code", ...overrides };
}

function draftOf(...stages: StageDraft[]): PipelineDraft {
	return { name: "pr-review", stages };
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
			stage("review", { workspace: "stage", produces: "review.md" }),
			stage("tests", { executor: "command", agent: undefined, run: "npm test\nnpm run lint" }),
		);
		render(<PipelineCanvas draft={draft} />);

		expect(screen.getByText("review")).toBeInTheDocument();
		expect(screen.getByText("claude-code")).toBeInTheDocument();
		expect(screen.getByLabelText("Agent stage")).toHaveTextContent("A");

		expect(screen.getByText("tests")).toBeInTheDocument();
		// A block-scalar run script shows its first line on the card.
		expect(screen.getByText("npm test")).toBeInTheDocument();
		expect(screen.getByLabelText("Command stage")).toHaveTextContent("$");

		// Explicit workspace and the declared artifact each get their own chip.
		expect(screen.getByText("stage")).toBeInTheDocument();
		expect(screen.getByText("review.md")).toBeInTheDocument();
	});

	it("shows the effective deadline on every card (spec §13.1)", () => {
		const draft: PipelineDraft = {
			name: "release",
			defaults: { deadline: "45m" },
			stages: [stage("build", { deadline: "10m" }), stage("sign")],
		};
		render(<PipelineCanvas draft={draft} />);

		// The stage's own deadline wins; the other inherits the pipeline default.
		expect(screen.getByText("10m")).toBeInTheDocument();
		expect(screen.getByText("45m")).toBeInTheDocument();
	});

	it("falls back to the engine default deadline when nothing declares one", () => {
		render(<PipelineCanvas draft={draftOf(stage("review"))} />);
		expect(screen.getByText("30m")).toBeInTheDocument();
	});

	it("shows a needs chip on join nodes only", () => {
		render(<PipelineCanvas draft={draftOf(stage("gate", { needs: ["review", "tests"] }), stage("review"))} />);

		expect(screen.getByText("needs 2")).toBeInTheDocument();
		expect(document.querySelector('[data-stage-id="review"]')).not.toHaveTextContent("needs");
	});

	it("warns on workspace session under a pr trigger (spec §5.3)", () => {
		const withPr: PipelineDraft = {
			name: "pr-review",
			on: { pr: ["created"] },
			stages: [stage("review", { workspace: "session" })],
		};
		const { unmount } = render(<PipelineCanvas draft={withPr} />);
		expect(screen.getByLabelText(/no session/i)).toBeInTheDocument();
		unmount();

		// Same stage without a pr.* trigger: the subject always has a session.
		render(<PipelineCanvas draft={draftOf(stage("review", { workspace: "session" }))} />);
		expect(screen.queryByLabelText(/no session/i)).not.toBeInTheDocument();
	});

	it("offers a success and a failure source handle per stage", () => {
		render(<PipelineCanvas draft={draftOf(stage("review"))} onDraftChange={vi.fn()} />);

		// Which handle an edge leaves picks its kind (plan Task 21).
		expect(document.querySelector('[data-handleid="success"]')).toBeInTheDocument();
		expect(document.querySelector('[data-handleid="failure"]')).toBeInTheDocument();
	});

	it("appends a default stage through the draft on Add stage", async () => {
		const onDraftChange = vi.fn();
		const selection = selectionOf();
		render(<PipelineCanvas draft={draftOf(stage("review"))} onDraftChange={onDraftChange} selection={selection} />);

		await userEvent.setup().click(screen.getByRole("button", { name: /Add stage/ }));

		expect(onDraftChange).toHaveBeenCalledTimes(1);
		const next = onDraftChange.mock.calls[0][0] as PipelineDraft;
		expect(next.stages.map((s) => s.id)).toEqual(["review", "stage-2"]);
		expect(next.stages[1].executor).toBe("agent");
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

	it("renders empty- and duplicate-id stages as distinct selectable nodes", () => {
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

	it("auto-layouts a stage left of its successors", () => {
		const draft = draftOf(
			stage("intake", { onSuccess: ["review"] }),
			stage("review", { onSuccess: ["fix"] }),
			stage("fix"),
		);
		const { container } = render(<PipelineCanvas draft={draft} />);

		expect(nodeX(container, "0")).toBeLessThan(nodeX(container, "1"));
		expect(nodeX(container, "1")).toBeLessThan(nodeX(container, "2"));
	});

	it("re-runs layout from the Auto-layout button", async () => {
		const { container } = render(
			<PipelineCanvas draft={draftOf(stage("a", { onSuccess: ["b"] }), stage("b"))} onDraftChange={vi.fn()} />,
		);

		await userEvent.setup().click(screen.getByRole("button", { name: /Auto-layout/ }));

		expect(nodeX(container, "0")).toBeLessThan(nodeX(container, "1"));
	});

	it("removes the selected stage from the draft on Delete/Backspace", async () => {
		const onDraftChange = vi.fn();
		const selection = selectionOf("0");
		const draft = draftOf(stage("review", { onSuccess: ["fix"] }), stage("fix"));
		render(<PipelineCanvas draft={draft} onDraftChange={onDraftChange} selection={selection} />);

		fireEvent.keyDown(document.querySelector(".react-flow")!, { key: "Backspace" });

		await screen.findByText("fix");
		// react-flow emits a remove for the connected edge too; the last draft
		// carries the final state (edge scrub folded into the stage removal).
		const next = onDraftChange.mock.calls.at(-1)![0] as PipelineDraft;
		expect(next.stages.map((s) => s.id)).toEqual(["fix"]);
		// The selection no longer points at anything.
		expect(selection.selectStage).toHaveBeenCalledWith(null);
	});

	// Edge DOM rendering needs measured node dimensions React Flow only gets in
	// a real browser; the draft -> edge mapping (add, remove, cycle styling) is
	// covered by pipeline-graph.test.ts.

	it("marks stages on an existing routing cycle (mockup 1d)", () => {
		const draft = draftOf(
			stage("intake", { onSuccess: ["fix"] }),
			stage("fix", { onSuccess: ["verify"] }),
			stage("verify", { onFailure: "fix" }),
		);
		render(<PipelineCanvas draft={draft} />);

		expect(screen.getAllByText("in routing cycle")).toHaveLength(2);
		expect(document.querySelector('[data-stage-id="fix"]')).toHaveAttribute("data-in-cycle");
		expect(document.querySelector('[data-stage-id="verify"]')).toHaveAttribute("data-in-cycle");
		expect(document.querySelector('[data-stage-id="intake"]')).not.toHaveAttribute("data-in-cycle");
	});

	it("renders validation badges on affected nodes (mockup 1d)", () => {
		render(
			<PipelineCanvas
				draft={draftOf(stage("review"), stage("fix"))}
				stageIssues={{ "0": ["prompt is required", "unknown agent"] }}
			/>,
		);

		expect(screen.getByLabelText("2 validation problems")).toBeInTheDocument();
		// The first message renders inline on the card.
		expect(screen.getByText("prompt is required")).toBeInTheDocument();
		expect(document.querySelector('[data-stage-id="review"]')).toHaveAttribute("data-issue-count", "2");
		expect(document.querySelector('[data-stage-id="fix"]')).not.toHaveAttribute("data-issue-count");
	});

	it("shows the zoom indicator and view controls", () => {
		render(<PipelineCanvas draft={draftOf(stage("review"))} />);

		expect(screen.getByLabelText("Zoom level")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Zoom out" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Fit view" })).toBeInTheDocument();
	});
});

// Edge DOM rendering needs measured node dimensions React Flow only gets in a
// real browser, so the three treatments are asserted on the pure style mapping.
describe("edgeAppearance", () => {
	it("draws success solid accent, failure dashed destructive, defaults dashed faint", () => {
		const success = edgeAppearance("success", false);
		const failure = edgeAppearance("failure", false);
		const synthetic = edgeAppearance("default-failure", false);

		expect(success.strokeDasharray).toBeUndefined();
		expect(success.stroke).toBe("var(--color-accent)");

		expect(failure.strokeDasharray).toBeTruthy();
		expect(failure.stroke).toBe("var(--color-destructive)");

		// Synthetic defaults.on_failure edges: same tone, dashed, visibly fainter.
		// Faintness rides on the stroke color, not opacity, so the arrowhead fades
		// with the line instead of staying solid.
		expect(synthetic.strokeDasharray).toBeTruthy();
		expect(synthetic.stroke).toContain("var(--color-destructive)");
		expect(synthetic.stroke).toContain("transparent");

		const fingerprint = (a: ReturnType<typeof edgeAppearance>) => JSON.stringify(a);
		expect(new Set([success, failure, synthetic].map(fingerprint)).size).toBe(3);
	});

	it("overrides every kind with the cycle treatment", () => {
		for (const kind of ["success", "failure", "default-failure"] as const) {
			expect(edgeAppearance(kind, true).stroke).toBe("var(--color-error)");
		}
	});
});
