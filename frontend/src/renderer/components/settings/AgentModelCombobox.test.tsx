import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentModelCombobox } from "./AgentModelCombobox";

function renderCombobox(
	models: Array<{ id: string; label: string; provider?: string; isDefault?: boolean }>,
	overrides: Partial<React.ComponentProps<typeof AgentModelCombobox>> = {},
) {
	const onChange = vi.fn();
	const onCustom = vi.fn();
	render(
		<AgentModelCombobox
			aria-label="Worker model"
			value=""
			models={models}
			allowCustom
			onChange={onChange}
			onCustom={onCustom}
			{...overrides}
		/>,
	);
	return { onChange, onCustom };
}

describe("AgentModelCombobox", () => {
	it("renders only the first 50 models from a large cached catalog", async () => {
		const models = Array.from({ length: 1_397 }, (_, index) => ({
			id: `provider-${index % 4}/model-${index}`,
			label: `Model ${index}`,
			provider: `provider-${index % 4}`,
			isDefault: index === 0,
		}));

		renderCombobox(models);
		await userEvent.click(screen.getByRole("button", { name: "Worker model" }));

		// Agent default, 50 catalog models, and the custom-model action.
		expect(screen.getAllByRole("menuitem")).toHaveLength(52);
		expect(screen.getByText("Showing 50 of 1,397 matching models — type to narrow")).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: /Model 1000/ })).not.toBeInTheDocument();
	});

	it("searches the full catalog and groups matching models by provider", async () => {
		const models = Array.from({ length: 100 }, (_, index) => ({
			id: `provider-${index % 2}/model-${index}`,
			label: `Model ${index}`,
			provider: `provider-${index % 2}`,
		}));
		const { onChange } = renderCombobox(models);
		await userEvent.click(screen.getByRole("button", { name: "Worker model" }));
		await userEvent.type(screen.getByRole("searchbox", { name: "Search worker model" }), "provider-1/model-99");

		expect(screen.getByText("provider-1", { selector: "div" })).toBeInTheDocument();
		expect(screen.getByText("Showing 1 of 1 matching models")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("menuitem", { name: /Model 99/ }));
		expect(onChange).toHaveBeenCalledWith("provider-1/model-99");
	});

	it("offers the typed value as a custom model when no catalog model matches", async () => {
		const { onCustom } = renderCombobox([{ id: "openai/gpt-5", label: "GPT-5", provider: "OpenAI" }]);
		await userEvent.click(screen.getByRole("button", { name: "Worker model" }));
		await userEvent.type(
			screen.getByRole("searchbox", { name: "Search worker model" }),
			"private/custom-model",
		);

		await userEvent.click(screen.getByRole("menuitem", { name: "Use “private/custom-model” as a custom model" }));
		expect(onCustom).toHaveBeenCalledWith("private/custom-model");
	});
});
