import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PipelineDraft, StageDraft } from "../lib/pipeline-draft";
import { stageEnvVars } from "../lib/pipeline-env";
import { StageInspector, type StageInspectorProps } from "./StageInspector";

const STAGE_IDS = ["fix", "triage", "tests"];

function agentStage(): StageDraft {
	return { id: "fix", executor: "agent", agent: "claude-code", prompt: "Fix it" };
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
			stageIds={STAGE_IDS}
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
	it("binds the id field", async () => {
		const { last } = renderInspector(agentStage());
		await userEvent.type(screen.getByRole("textbox", { name: "Stage id" }), "!");
		expect(last().id).toBe("fix!");
	});

	it("renders and binds agent executor fields", async () => {
		const { last } = renderInspector(agentStage());
		expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent("claude-code");

		await chooseOption(screen.getByRole("combobox", { name: "Agent" }), "codex");
		expect(last().agent).toBe("codex");

		await userEvent.type(screen.getByRole("textbox", { name: "Produces" }), "review.md");
		expect(last().produces).toBe("review.md");

		await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "!");
		expect(last().prompt).toBe("Fix it!");
	});

	it("renders and binds command executor fields", async () => {
		const { last } = renderInspector({ id: "tests", executor: "command", run: "npm test" });

		await userEvent.type(screen.getByRole("textbox", { name: "Run" }), "x");
		expect(last().run).toBe("npm testx");
	});

	it("adds and removes credential chips on a command stage", async () => {
		const { last } = renderInspector({ id: "tests", executor: "command", run: "npm test" });
		const input = screen.getByRole("textbox", { name: "Add credential" });

		await userEvent.type(input, "github-release{Enter}");
		expect(last().credentials).toEqual(["github-release"]);
		// The committed name leaves the input, so the next one starts clean.
		expect(input).toHaveValue("");

		await userEvent.type(input, "discord{Enter}");
		expect(last().credentials).toEqual(["github-release", "discord"]);

		// A duplicate is a no-op rather than a second identical chip.
		await userEvent.type(input, "discord{Enter}");
		expect(last().credentials).toEqual(["github-release", "discord"]);

		await userEvent.click(screen.getByRole("button", { name: "Remove credential github-release" }));
		expect(last().credentials).toEqual(["discord"]);

		await userEvent.click(screen.getByRole("button", { name: "Remove credential discord" }));
		expect(last().credentials).toBeUndefined();
	});

	it("drops the other kind's fields when switching executor", async () => {
		const { last } = renderInspector({ ...agentStage(), produces: "review.md" });
		await userEvent.click(screen.getByRole("radio", { name: "command" }));
		expect(last()).toEqual({ id: "fix", executor: "command" });

		await userEvent.type(screen.getByRole("textbox", { name: "Run" }), "npm test");
		await userEvent.click(screen.getByRole("radio", { name: "agent" }));
		expect(last()).toEqual({ id: "fix", executor: "agent" });
	});

	it("adds and removes onSuccess successors", async () => {
		const { last } = renderInspector({ ...agentStage(), onSuccess: ["triage"] });
		await userEvent.click(screen.getByRole("button", { name: "Add successor tests" }));
		expect(last().onSuccess).toEqual(["triage", "tests"]);

		await userEvent.click(screen.getByRole("button", { name: "Remove successor triage" }));
		expect(last().onSuccess).toEqual(["tests"]);

		await userEvent.click(screen.getByRole("button", { name: "Remove successor tests" }));
		expect(last().onSuccess).toBeUndefined();
	});

	it("never offers the stage itself as a successor", () => {
		renderInspector(agentStage());
		expect(screen.queryByRole("button", { name: "Add successor fix" })).not.toBeInTheDocument();
	});

	it("binds onFailure and falls back to the pipeline default", async () => {
		const { last } = renderInspector(agentStage());
		await chooseOption(screen.getByRole("combobox", { name: "On failure" }), "triage");
		expect(last().onFailure).toBe("triage");

		await chooseOption(screen.getByRole("combobox", { name: "On failure" }), "Pipeline default");
		expect(last().onFailure).toBeUndefined();
	});

	it("renders needs read-only, since the graph lib maintains it", () => {
		renderInspector({ ...agentStage(), needs: ["triage", "tests"] });
		const needs = screen.getByTestId("stage-needs");
		expect(needs).toHaveTextContent("triage");
		expect(needs).toHaveTextContent("tests");
		expect(needs.querySelector("button")).toBeNull();
	});

	it("binds the workspace select", async () => {
		const { last } = renderInspector(agentStage());
		await chooseOption(screen.getByRole("combobox", { name: "Workspace" }), "stage");
		expect(last().workspace).toBe("stage");

		await chooseOption(screen.getByRole("combobox", { name: "Workspace" }), "Default");
		expect(last().workspace).toBeUndefined();
	});

	it("binds the deadline field and shows the inherited one as the placeholder", async () => {
		const { last } = renderInspector(agentStage(), { defaultDeadline: "45m" });
		// Spec §13.1: the effective bound must be visible, not just the override.
		expect(screen.getByRole("textbox", { name: "Deadline" })).toHaveAttribute("placeholder", "45m");

		await userEvent.type(screen.getByRole("textbox", { name: "Deadline" }), "40m");
		expect(last().deadline).toBe("40m");
	});

	it("falls back to the engine default deadline placeholder", () => {
		renderInspector(agentStage());
		expect(screen.getByRole("textbox", { name: "Deadline" })).toHaveAttribute("placeholder", "30m");
	});

	it("rejects a produces filename carrying a path separator", async () => {
		const { last } = renderInspector(agentStage());
		const produces = screen.getByRole("textbox", { name: "Produces" });
		expect(produces).toHaveAttribute("aria-invalid", "false");

		await userEvent.type(produces, "docs/review.md");
		// The edit still binds (the daemon is authoritative); the field flags it.
		expect(last().produces).toBe("docs/review.md");
		expect(produces).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByText(/bare filename/i)).toBeInTheDocument();
	});

	it("rejects a windows path separator in produces too", async () => {
		renderInspector({ ...agentStage(), produces: "docs\\review.md" });
		expect(screen.getByRole("textbox", { name: "Produces" })).toHaveAttribute("aria-invalid", "true");
	});

	it("warns on workspace session under a pr.* trigger (spec §5.3)", () => {
		renderInspector({ ...agentStage(), workspace: "session" }, { prTriggered: true });
		expect(screen.getByText(/no local session/i)).toBeInTheDocument();
	});

	it("does not warn on workspace session without a pr.* trigger", () => {
		renderInspector({ ...agentStage(), workspace: "session" });
		expect(screen.queryByText(/no local session/i)).not.toBeInTheDocument();
	});

	it("never offers credentials on an agent stage", () => {
		renderInspector(agentStage(), { prTriggered: true });
		// Credentials-on-agent is impossible by construction, not by validation.
		expect(screen.queryByRole("textbox", { name: "Credentials" })).not.toBeInTheDocument();
	});

	it("overrides session kill-on, including the never-kill empty list", async () => {
		const { last } = renderInspector(agentStage());
		const toggle = screen.getByRole("switch", { name: "Override kill-on" });
		expect(toggle).not.toBeChecked();

		await userEvent.click(toggle);
		expect(last().session).toEqual({ killOn: ["succeeded", "failed"] });

		await userEvent.click(screen.getByRole("button", { name: "succeeded" }));
		await userEvent.click(screen.getByRole("button", { name: "failed" }));
		// An explicit empty list is the "never kill" contract, not an absent key.
		expect(last().session).toEqual({ killOn: [] });
		expect(screen.getByText("Never kills the session.")).toBeInTheDocument();

		await userEvent.click(toggle);
		expect(last().session).toBeUndefined();
	});

	it("hides the session block on a command stage", () => {
		renderInspector({ id: "tests", executor: "command", run: "npm test" });
		expect(screen.queryByRole("switch", { name: "Override kill-on" })).not.toBeInTheDocument();
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
});

// The catalog the editor really passes: derived from the draft the stage lives
// in, so availability here is what a run of this pipeline would produce.
function envFor(stage: StageDraft, rest: Partial<PipelineDraft> = {}): StageInspectorProps["envVars"] {
	return stageEnvVars({ name: "p", stages: [stage], ...rest }, stage);
}

describe("StageInspector $AO completion", () => {
	const promptStage = () => agentStage();

	async function typeInPrompt(text: string, stage = promptStage(), rest: Partial<PipelineDraft> = {}) {
		const { last } = renderInspector({ ...stage, prompt: "" }, { envVars: envFor(stage, rest) });
		const prompt = screen.getByRole("textbox", { name: "Prompt" });
		await userEvent.click(prompt);
		await userEvent.type(prompt, text);
		return { prompt, last };
	}

	it("opens the menu on $AO and lists the stage's variables", async () => {
		await typeInPrompt("Write to $AO");
		const options = screen.getAllByRole("option");
		expect(options.length).toBeGreaterThan(10);
		expect(options[0]).toHaveTextContent("$AO_PROJECT");
	});

	it("stays shut for a bare $ and for other shell variables", async () => {
		await typeInPrompt("cd $HOME");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("narrows as the name is typed", async () => {
		await typeInPrompt("Write to $AO_RU");
		expect(screen.getAllByRole("option").map((o) => o.textContent)).toHaveLength(2);
		expect(screen.getByRole("option", { name: /AO_RUN_ID/ })).toBeInTheDocument();
	});

	it("inserts the highlighted entry on Enter", async () => {
		const { last } = await typeInPrompt("Write to $AO_CON");
		await userEvent.keyboard("{Enter}");
		expect(last().prompt).toBe("Write to $AO_CONTEXT");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("moves the highlight with the arrow keys", async () => {
		const { last } = await typeInPrompt("Write to $AO_PREV");
		await userEvent.keyboard("{ArrowDown}{Enter}");
		expect(last().prompt).toBe("Write to $AO_PREV_OUTCOME");
	});

	it("dismisses on Escape without inserting", async () => {
		const { last } = await typeInPrompt("Write to $AO_CON");
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		expect(last().prompt).toBe("Write to $AO_CON");
	});

	it("does not reopen on the token it just completed", async () => {
		await typeInPrompt("Write to $AO_CON");
		await userEvent.keyboard("{Enter}");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("keeps the text after the caret when completing mid-line", async () => {
		const stage = promptStage();
		const { last } = renderInspector(
			{ ...stage, prompt: "" },
			{ envVars: envFor({ ...stage, produces: "review.md" }) },
		);
		const prompt = screen.getByRole("textbox", { name: "Prompt" });
		await userEvent.type(prompt, "cat  then stop");
		// Park the caret in the gap and complete there.
		await userEvent.type(prompt, "$AO_OUT", { initialSelectionStart: 4, initialSelectionEnd: 4 });
		await userEvent.keyboard("{Enter}");
		expect(last().prompt).toBe("cat $AO_OUTPUT then stop");
	});

	it("still lists what the stage lacks, greyed and with the reason", async () => {
		// No `produces:`, so AO_OUTPUT cannot resolve; the menu says why instead
		// of hiding it.
		await typeInPrompt("Write to $AO_OUT");
		const option = screen.getByRole("option", { name: /AO_OUTPUT/ });
		expect(option).toHaveAttribute("aria-disabled", "true");
		expect(option).toHaveTextContent("needs `produces:`");
	});

	it("offers the same completion in a command stage's run script", async () => {
		const cmd: StageDraft = { id: "tests", executor: "command", run: "" };
		const { last } = renderInspector(cmd, { envVars: envFor(cmd) });
		const run = screen.getByRole("textbox", { name: "Run" });
		await userEvent.type(run, "cd $AO_WORK");
		await userEvent.keyboard("{Enter}");
		expect(last().run).toBe("cd $AO_WORKSPACE");
	});
});

describe("StageInspector environment reference", () => {
	it("summarizes reach and expands to the full catalog", async () => {
		const stage = agentStage();
		renderInspector(stage, { envVars: envFor(stage) });
		const toggle = screen.getByRole("button", { name: /\$AO variables reach this stage/ });
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		// 7 always-present of the 16 the engine can inject; nothing else resolves
		// for a lone agent stage with no triggers and no produces.
		expect(toggle).toHaveTextContent("7 of 16 $AO variables reach this stage");

		await userEvent.click(toggle);
		const list = screen.getByTestId("stage-env-reference");
		expect(list).toHaveTextContent("$AO_RUN_ID");
		expect(list).toHaveTextContent("$AO_FAILED_STAGE");
		expect(list).toHaveTextContent("only on stages entered via `on_failure`");
		// AO_ATTEMPT is described as it behaves, not as the spec's table says.
		expect(list).toHaveTextContent(/Always 1\./);
	});

	it("counts the ones a pr trigger and a produces unlock", async () => {
		const stage = agentStage();
		renderInspector(stage, { envVars: envFor({ ...stage, produces: "review.md" }, { on: { pr: ["created"] } }) });
		// The pr trio, AO_SESSION_ID and AO_OUTPUT join the seven.
		expect(screen.getByRole("button", { name: /\$AO variables reach this stage/ })).toHaveTextContent("12 of 16");
	});

	it("stays out of the panel when no catalog is wired", () => {
		renderInspector(agentStage());
		expect(screen.queryByRole("button", { name: /\$AO variables/ })).not.toBeInTheDocument();
	});
});
