import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AGENT_OPTIONS } from "../lib/agent-options";
import { AgentIcon } from "./AgentIcon";
import { TooltipProvider } from "./ui/tooltip";

describe("AgentIcon", () => {
	it("maps every supported Agent to a distinct bundled icon", () => {
		const sources = new Set<string>();

		for (const provider of AGENT_OPTIONS) {
			const { unmount } = render(
				<TooltipProvider>
					<AgentIcon provider={provider} />
				</TooltipProvider>,
			);
			const icon = screen.getByRole("img");
			expect(icon).toHaveAttribute("data-agent-provider", provider);
			expect(icon).toHaveAccessibleName();

			const image = icon.querySelector("img");
			expect(image).toHaveAttribute("src", expect.stringMatching(/\.png$/));
			sources.add(image?.getAttribute("src") ?? "");
			unmount();
		}

		expect(sources.size).toBe(AGENT_OPTIONS.length);
	});
});
