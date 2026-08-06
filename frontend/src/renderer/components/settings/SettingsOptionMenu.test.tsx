import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SettingsOptionMenu } from "./SettingsOptionMenu";

describe("SettingsOptionMenu", () => {
	it("filters searchable options by label and value", async () => {
		render(
			<SettingsOptionMenu
				aria-label="Worker model"
				value=""
				searchable
				options={[
					{ value: "anthropic/claude-sonnet", label: "Claude Sonnet" },
					{ value: "openai/gpt-5.5", label: "GPT Five" },
				]}
				onChange={() => {}}
			/>,
		);

		await userEvent.click(screen.getByRole("button", { name: "Worker model" }));
		const search = screen.getByRole("searchbox", { name: "Search worker model" });

		await userEvent.type(search, "sonnet");
		expect(screen.getByRole("menuitem", { name: "Claude Sonnet" })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "GPT Five" })).not.toBeInTheDocument();

		await userEvent.clear(search);
		await userEvent.type(search, "openai/gpt");
		expect(screen.getByRole("menuitem", { name: "GPT Five" })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Claude Sonnet" })).not.toBeInTheDocument();
	});
});
