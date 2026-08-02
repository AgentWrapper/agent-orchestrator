import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModelOverrideSelect } from "./ModelOverrideSelect";

const TRIGGER = { name: "Model override" };

async function chooseOption(trigger: HTMLElement, option: string) {
	await userEvent.click(trigger);
	await userEvent.click(await screen.findByRole("menuitem", { name: new RegExp(option, "i") }));
}

describe("ModelOverrideSelect", () => {
	it("offers every verified Codex model plus inherit and custom choices", async () => {
		render(<ModelOverrideSelect ariaLabel="Model override" value="" onChange={() => undefined} />);
		await userEvent.click(screen.getByRole("button", TRIGGER));

		for (const name of ["Agent default", "GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.6 Luna", "GPT-5.5", "Custom model ID"]) {
			expect(await screen.findByRole("menuitem", { name: new RegExp(name, "i") })).toBeInTheDocument();
		}
	});

	it("emits the exact known model ID", async () => {
		const onChange = vi.fn();
		render(<ModelOverrideSelect ariaLabel="Model override" value="" onChange={onChange} />);

		await chooseOption(screen.getByRole("button", TRIGGER), "GPT-5.6 Luna");

		expect(onChange).toHaveBeenLastCalledWith("gpt-5.6-luna");
	});

	it("shows only the selected model short label in the trigger", () => {
		render(<ModelOverrideSelect ariaLabel="Model override" value="gpt-5.6-sol" onChange={() => undefined} />);

		expect(screen.getByRole("button", TRIGGER)).toHaveTextContent("GPT-5.6 Sol");
		expect(screen.getByRole("button", TRIGGER)).not.toHaveTextContent("Latest frontier agentic coding model");
	});

	it("preserves and edits an existing custom model ID", async () => {
		const onChange = vi.fn();
		function ControlledPicker() {
			const [value, setValue] = useState("future-codex-model");
			return (
				<ModelOverrideSelect
					ariaLabel="Model override"
					value={value}
					onChange={(next) => {
						setValue(next);
						onChange(next);
					}}
				/>
			);
		}
		render(<ControlledPicker />);

		const custom = screen.getByRole("textbox", { name: "Custom model ID" });
		expect(custom).toHaveValue("future-codex-model");
		await userEvent.clear(custom);
		await userEvent.type(custom, "future-codex-model-2");

		expect(onChange).toHaveBeenLastCalledWith("future-codex-model-2");
	});

	it("keeps custom mode while typing a model ID with a known-model prefix", async () => {
		function ControlledPicker() {
			const [value, setValue] = useState("");
			return <ModelOverrideSelect ariaLabel="Model override" value={value} onChange={setValue} />;
		}
		render(<ControlledPicker />);

		await chooseOption(screen.getByRole("button", TRIGGER), "Custom model ID");
		const custom = screen.getByRole("textbox", { name: "Custom model ID" });
		await userEvent.type(custom, "gpt-5.5-preview");

		expect(screen.getByRole("textbox", { name: "Custom model ID" })).toHaveValue("gpt-5.5-preview");
		expect(screen.getByRole("button", TRIGGER)).toHaveTextContent("Custom model ID");
	});

	it("emits an empty string for inheritance", async () => {
		const onChange = vi.fn();
		render(<ModelOverrideSelect ariaLabel="Model override" value="gpt-5.6-sol" onChange={onChange} />);

		await chooseOption(screen.getByRole("button", TRIGGER), "Agent default");

		expect(onChange).toHaveBeenLastCalledWith("");
	});

	it("closes custom mode when a parent resets its value to inherit", () => {
		const { rerender } = render(
			<ModelOverrideSelect ariaLabel="Model override" value="future-codex-model" onChange={() => undefined} />,
		);
		expect(screen.getByRole("textbox", { name: "Custom model ID" })).toBeInTheDocument();

		rerender(<ModelOverrideSelect ariaLabel="Model override" value="" onChange={() => undefined} />);

		expect(screen.queryByRole("textbox", { name: "Custom model ID" })).not.toBeInTheDocument();
	});

	it("returns to inherit when a preset resets an edited custom model", async () => {
		function ControlledPicker() {
			const [value, setValue] = useState("future-codex-model");
			return (
				<>
					<ModelOverrideSelect ariaLabel="Model override" value={value} onChange={setValue} />
					<button type="button" onClick={() => setValue("")}>
						Apply preset
					</button>
				</>
			);
		}
		render(<ControlledPicker />);

		const custom = screen.getByRole("textbox", { name: "Custom model ID" });
		await userEvent.clear(custom);
		await userEvent.type(custom, "edited-custom-model");
		await userEvent.click(screen.getByRole("button", { name: "Apply preset" }));

		expect(screen.queryByRole("textbox", { name: "Custom model ID" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", TRIGGER)).toHaveTextContent("Agent default");
	});
});
