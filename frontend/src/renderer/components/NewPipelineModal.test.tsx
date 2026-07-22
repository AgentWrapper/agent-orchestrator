import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewPipelineModal, type NewPipelineChoice } from "./NewPipelineModal";

function renderModal(onCreate = vi.fn(), onCancel = vi.fn()) {
	render(<NewPipelineModal open onCancel={onCancel} onCreate={onCreate} />);
	return { onCreate, onCancel };
}

describe("NewPipelineModal", () => {
	it("defaults to Blank canvas and creates a blank draft", async () => {
		const user = userEvent.setup();
		const { onCreate } = renderModal();

		expect(screen.getByRole("radio", { name: /Blank canvas/ })).toHaveAttribute("aria-checked", "true");
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(onCreate).toHaveBeenCalledWith({ kind: "blank" });
	});

	it("gates Create on a template pick and creates the chosen template", async () => {
		const user = userEvent.setup();
		const { onCreate } = renderModal();

		await user.click(screen.getByRole("radio", { name: /From template/ }));
		expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

		await user.click(screen.getByRole("radio", { name: "PR review loop" }));
		expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();

		await user.click(screen.getByRole("button", { name: "Create" }));
		const choice = onCreate.mock.calls[0][0] as NewPipelineChoice;
		expect(choice.kind).toBe("template");
		if (choice.kind === "template") expect(choice.template.id).toBe("pr-review-loop");
	});

	it("clicking a template row while Blank canvas is active switches the path", async () => {
		const user = userEvent.setup();
		renderModal();

		expect(screen.getByRole("radio", { name: /Blank canvas/ })).toHaveAttribute("aria-checked", "true");
		await user.click(screen.getByRole("radio", { name: "PR review loop" }));

		expect(screen.getByRole("radio", { name: /From template/ })).toHaveAttribute("aria-checked", "true");
		expect(screen.getByRole("radio", { name: /Blank canvas/ })).toHaveAttribute("aria-checked", "false");
		expect(screen.getByRole("radio", { name: "PR review loop" })).toHaveAttribute("aria-checked", "true");
	});

	it("shows each template's stage count", () => {
		renderModal();

		expect(screen.getByRole("radio", { name: "PR review loop" })).toHaveTextContent("8 stages");
		expect(screen.getByRole("radio", { name: "Nightly triage sweep" })).toHaveTextContent("4 stages");
		expect(screen.getByRole("radio", { name: "Release gate" })).toHaveTextContent("5 stages");
	});

	it("imports pasted YAML through the Paste YAML path", async () => {
		const user = userEvent.setup();
		const { onCreate } = renderModal();

		await user.click(screen.getByRole("radio", { name: /Paste YAML/ }));
		const textarea = screen.getByLabelText("Paste YAML");
		expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

		await user.type(textarea, "name: imported");
		expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();

		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(onCreate).toHaveBeenCalledWith({ kind: "yaml", yamlSource: "name: imported" });
	});

	it("fires onCancel when dismissed", async () => {
		const user = userEvent.setup();
		const { onCancel } = renderModal();

		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onCancel).toHaveBeenCalled();
	});
});
