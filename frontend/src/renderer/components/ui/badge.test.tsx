import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./badge";

describe("Badge", () => {
	it("sizes text badges as content-width pills instead of fixed icon squares", () => {
		render(
			<Badge variant="success" className="h-5 px-1.5 text-micro font-medium">
				open
			</Badge>,
		);

		const badge = screen.getByText("open");

		expect(badge).not.toHaveClass("size-icon-xl");
		expect(badge).not.toHaveClass("h-icon-xl");
		expect(badge.className).not.toMatch(/\b(?:w|min-w)-/);
		expect(badge).toHaveClass("inline-flex", "whitespace-nowrap", "rounded-full", "h-5", "px-1.5");
	});

	it("lets compact call sites override badge height without reintroducing fixed width", () => {
		render(
			<Badge variant="neutral" className="h-3.5 px-1 text-[9px] leading-none">
				2d ago
			</Badge>,
		);

		const badge = screen.getByText("2d ago");

		expect(badge).toHaveClass("h-3.5", "px-1", "text-[9px]", "leading-none");
		expect(badge.className).not.toMatch(/\b(?:size|h|w|min-w)-icon-xl\b/);
	});
});
