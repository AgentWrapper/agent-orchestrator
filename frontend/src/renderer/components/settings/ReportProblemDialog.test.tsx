/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReportProblemDialog } from "./ReportProblemDialog";

describe("ReportProblemDialog", () => {
	it("disables primary action when fields are empty, and enables only when both summary and details contain text", () => {
		render(
			<ReportProblemDialog
				open={true}
				onOpenChange={vi.fn()}
			/>
		);

		// Exact placeholders & labels from DOM
		const summaryInput = screen.getByPlaceholderText(/brief title/i);
		const detailsInput = screen.getByPlaceholderText(/share what happened/i);
		const submitButton = screen.getByRole("button", { name: /copy & create github issue/i });

		// 1. Both empty -> Disabled
		expect(submitButton).toBeDisabled();

		// 2. Only summary filled -> Disabled
		fireEvent.change(summaryInput, { target: { value: "Test Summary" } });
		expect(submitButton).toBeDisabled();

		// Clear summary and fill only details -> Disabled
		fireEvent.change(summaryInput, { target: { value: "" } });
		fireEvent.change(detailsInput, { target: { value: "Test Details" } });
		expect(submitButton).toBeDisabled();

		// 3. Both filled -> Enabled
		fireEvent.change(summaryInput, { target: { value: "Test Summary" } });
		expect(submitButton).toBeEnabled();
	});
});