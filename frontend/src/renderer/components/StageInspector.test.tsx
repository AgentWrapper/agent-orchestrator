import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { StageDraft } from "../lib/pipeline-draft";
import { StageInspector, type StageInspectorProps } from "./StageInspector";

const STAGE_NAMES = ["fix", "triage", "tests"];

function agentStage(): StageDraft {
	return {
		name: "fix",
		trigger: { on: ["pr.updated"] },
		executor: { kind: "agent", plugin: "claude-code", mode: "code" },
	};
}

// Controlled harness: feeds edits back into the stage prop (like the editor
// area does via usePipelineDraft) and records every change.
function Harness({
	initial,
	onChange,
	...rest
}: { initial: StageDraft; onChange: (next: StageDraft) => void } & Partial<StageInspectorProps>) {
	const [stage, setStage] = useState(initial);
	return (
		<StageInspector
			stage={stage}
			stageNames={STAGE_NAMES}
			onChange={(next) => {
				setStage(next);
				onChange(next);
			}}
			{...rest}
		/>
	);
}

function renderInspector(initial: StageDraft, rest: Partial<StageInspectorProps> = {}) {
	const changes: StageDraft[] = [];
	render(<Harness initial={initial} onChange={(next) => changes.push(next)} {...rest} />);
	return { last: () => changes[changes.length - 1] };
}

async function chooseOption(trigger: HTMLElement, optionName: string) {
	await userEvent.click(trigger);
	await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

describe("StageInspector", () => {
	it("binds the name field", async () => {
		const { last } = renderInspector(agentStage());
		await userEvent.type(screen.getByRole("textbox", { name: "Stage name" }), "!");
		expect(last().name).toBe("fix!");
	});

	it("renders and binds agent executor fields", async () => {
		const { last } = renderInspector(agentStage());
		expect(screen.getByRole("combobox", { name: "Plugin" })).toHaveTextContent("claude-code");
		expect(screen.getByRole("combobox", { name: "Mode" })).toHaveTextContent("code");

		await chooseOption(screen.getByRole("combobox", { name: "Mode" }), "review");
		expect(last().executor).toEqual({ kind: "agent", plugin: "claude-code", mode: "review" });

		await chooseOption(screen.getByRole("combobox", { name: "Plugin" }), "codex");
		expect(last().executor).toEqual({ kind: "agent", plugin: "codex", mode: "review" });
	});

	it("renders and binds command executor fields", async () => {
		const { last } = renderInspector({
			name: "tests",
			trigger: { on: ["manual"] },
			executor: { kind: "command", command: "npm", args: ["test"] },
		});

		await userEvent.type(screen.getByRole("textbox", { name: "Command" }), "x");
		expect(last().executor.command).toBe("npmx");

		await userEvent.type(screen.getByRole("textbox", { name: "Args" }), "\n--ci");
		expect(last().executor.args).toEqual(["test", "--ci"]);

		await userEvent.type(screen.getByRole("textbox", { name: "Env" }), "CI=1");
		expect(last().executor.env).toEqual({ CI: "1" });

		await userEvent.type(screen.getByRole("textbox", { name: "Working directory" }), "frontend");
		expect(last().executor.cwd).toBe("frontend");
		expect(last().executor.kind).toBe("command");
	});

	it("renders and binds builtin executor fields", async () => {
		const { last } = renderInspector({
			name: "gate",
			trigger: { on: ["pr.merge_ready"] },
			executor: { kind: "builtin", name: "router" },
		});
		expect(screen.getByRole("combobox", { name: "Builtin name" })).toHaveTextContent("router");

		await chooseOption(screen.getByRole("combobox", { name: "Builtin name" }), "compose");
		expect(last().executor).toEqual({ kind: "builtin", name: "compose" });
	});

	it("rewrites the executor sub-object when switching kind, leaking no fields", async () => {
		const { last } = renderInspector(agentStage());
		await userEvent.click(screen.getByRole("radio", { name: "command" }));
		expect(last().executor).toEqual({ kind: "command" });

		await userEvent.click(screen.getByRole("radio", { name: "builtin" }));
		expect(last().executor).toEqual({ kind: "builtin" });

		await userEvent.click(screen.getByRole("radio", { name: "agent" }));
		expect(last().executor).toEqual({ kind: "agent" });
	});

	it("toggles trigger events as a multi-select", async () => {
		const { last } = renderInspector(agentStage());
		await userEvent.click(screen.getByRole("button", { name: "manual" }));
		expect(last().trigger.on).toEqual(["pr.updated", "manual"]);

		await userEvent.click(screen.getByRole("button", { name: "pr.updated" }));
		expect(last().trigger.on).toEqual(["manual"]);
	});

	it("adds and removes dependsOn entries", async () => {
		const { last } = renderInspector({ ...agentStage(), dependsOn: ["triage"] });
		await userEvent.click(screen.getByRole("button", { name: "Add dependency tests" }));
		expect(last().dependsOn).toEqual(["triage", "tests"]);

		await userEvent.click(screen.getByRole("button", { name: "Remove dependency triage" }));
		expect(last().dependsOn).toEqual(["tests"]);

		await userEvent.click(screen.getByRole("button", { name: "Remove dependency tests" }));
		expect(last().dependsOn).toBeUndefined();
	});

	it("never offers the stage itself as a dependency", () => {
		renderInspector(agentStage());
		expect(screen.queryByRole("button", { name: "Add dependency fix" })).not.toBeInTheDocument();
	});

	it("binds task prompt and JSON fields", async () => {
		const { last } = renderInspector(agentStage());
		await userEvent.type(screen.getByRole("textbox", { name: "Task prompt" }), "Fix it");
		expect(last().task?.prompt).toBe("Fix it");

		const inputs = screen.getByLabelText(/Inputs/);
		await userEvent.click(inputs);
		await userEvent.paste('{"from": "triage"}');
		expect(last().task?.inputs).toEqual({ from: "triage" });

		// Partial/invalid JSON never commits; it only flags the field.
		await userEvent.type(inputs, "{{");
		expect(screen.getByText("invalid JSON")).toBeInTheDocument();
		expect(last().task?.inputs).toEqual({ from: "triage" });
	});

	it("binds the workspace segmented control", async () => {
		const { last } = renderInspector(agentStage());
		await userEvent.click(screen.getByRole("radio", { name: "isolated-rw" }));
		expect(last().workspace).toBe("isolated-rw");

		await userEvent.click(screen.getByRole("radio", { name: "Default" }));
		expect(last().workspace).toBeUndefined();
	});

	it("binds the advanced knobs", async () => {
		const { last } = renderInspector(agentStage());
		await userEvent.type(screen.getByRole("spinbutton", { name: "Retries" }), "2");
		expect(last().retries).toBe(2);

		await userEvent.type(screen.getByRole("spinbutton", { name: "Timeout (ms)" }), "1800000");
		expect(last().timeoutMs).toBe(1800000);

		await userEvent.type(screen.getByRole("spinbutton", { name: "Max rounds" }), "5");
		expect(last().maxLoopRounds).toBe(5);

		await userEvent.type(screen.getByRole("spinbutton", { name: "Budget · max USD" }), "5");
		await userEvent.type(screen.getByRole("spinbutton", { name: "Budget · max duration (ms)" }), "60000");
		expect(last().budget).toEqual({ maxUsd: 5, maxDurationMs: 60000 });

		await userEvent.clear(screen.getByRole("spinbutton", { name: "Retries" }));
		expect(last().retries).toBeUndefined();
	});

	it("summarizes an unset routes.when as always", () => {
		renderInspector(agentStage());
		expect(screen.getByTestId("routes-when-summary")).toHaveTextContent("always");
	});

	it("summarizes a set routes.when predicate", () => {
		renderInspector({
			...agentStage(),
			routes: { when: { kind: "not", predicate: { kind: "no_open_findings" } } },
		});
		expect(screen.getByTestId("routes-when-summary")).toHaveTextContent("not( no_open_findings )");
	});

	it("calls onEditCondition from the Edit-condition button", async () => {
		const onEditCondition = vi.fn();
		renderInspector(agentStage(), { onEditCondition });
		await userEvent.click(screen.getByRole("button", { name: "Edit condition" }));
		expect(onEditCondition).toHaveBeenCalledTimes(1);
	});

	it("disables Edit condition with a coming-soon affordance when unwired", () => {
		renderInspector(agentStage());
		const button = screen.getByRole("button", { name: /Edit condition · coming soon/ });
		expect(button).toBeDisabled();
		expect(button).toHaveAttribute("title", "Predicate builder coming soon");
	});

	it("calls onClose from the header close button", async () => {
		const onClose = vi.fn();
		renderInspector(agentStage(), { onClose });
		await userEvent.click(screen.getByRole("button", { name: "Close inspector" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("calls onDelete from the header delete button", async () => {
		const onDelete = vi.fn();
		renderInspector(agentStage(), { onDelete });
		await userEvent.click(screen.getByRole("button", { name: "Delete stage" }));
		expect(onDelete).toHaveBeenCalledTimes(1);
	});

	it("hides the delete button while onDelete is unwired", () => {
		renderInspector(agentStage());
		expect(screen.queryByRole("button", { name: "Delete stage" })).not.toBeInTheDocument();
	});

	it("toggles policy.blocksMerge", async () => {
		const { last } = renderInspector(agentStage());
		const toggle = screen.getByRole("switch", { name: "Blocks merge" });
		expect(toggle).not.toBeChecked();

		await userEvent.click(toggle);
		expect(last().policy).toEqual({ blocksMerge: true });

		await userEvent.click(toggle);
		expect(last().policy).toBeUndefined();
	});

	it("binds policy.stallWindow and drops the policy object once it is minimal again", async () => {
		const { last } = renderInspector(agentStage());
		await userEvent.type(screen.getByRole("spinbutton", { name: "Stall window (rounds)" }), "3");
		expect(last().policy).toEqual({ stallWindow: 3 });

		await userEvent.clear(screen.getByRole("spinbutton", { name: "Stall window (rounds)" }));
		expect(last().policy).toBeUndefined();
	});

	it("keeps both policy fields together when both are set", async () => {
		const { last } = renderInspector(agentStage());
		await userEvent.click(screen.getByRole("switch", { name: "Blocks merge" }));
		await userEvent.type(screen.getByRole("spinbutton", { name: "Stall window (rounds)" }), "2");
		expect(last().policy).toEqual({ blocksMerge: true, stallWindow: 2 });
	});
});
