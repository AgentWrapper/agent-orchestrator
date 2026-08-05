/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReportProblemDialog } from "./ReportProblemDialog";

describe("ReportProblemDialog", () => {
	it("disables primary action when fields are empty or whitespace-only, and enables when both summary and details contain non-whitespace text", async () => {
		await act(async () => {
			render(<ReportProblemDialog open={true} onOpenChange={vi.fn()} />);
			await Promise.resolve();
		});

		const summaryInput = screen.getByPlaceholderText(/brief title/i);
		const detailsInput = screen.getByPlaceholderText(/share what happened/i);
		const submitButton = screen.getByRole("button", { name: /copy & create github issue/i });

		expect(submitButton).toBeDisabled();

		fireEvent.change(summaryInput, { target: { value: "Test Summary" } });
		expect(submitButton).toBeDisabled();

		fireEvent.change(summaryInput, { target: { value: "   " } });
		fireEvent.change(detailsInput, { target: { value: "Test Details" } });
		expect(submitButton).toBeDisabled();

		fireEvent.change(summaryInput, { target: { value: "Test Summary" } });
		fireEvent.change(detailsInput, { target: { value: "   " } });
		expect(submitButton).toBeDisabled();

		fireEvent.change(summaryInput, { target: { value: "Test Summary" } });
		fireEvent.change(detailsInput, { target: { value: "Test Details" } });
		expect(submitButton).toBeEnabled();
		// footer-primary variant: accent fill + token fg (not hardcoded text-white).
		expect(submitButton.className).toMatch(/bg-\[var\(--color-settings-accent\)\]/);
		expect(submitButton.className).toMatch(
			/text-\[var\(--color-settings-footer-button-primary-fg\)\]/,
		);
		expect(submitButton.className).not.toMatch(/\btext-white\b/);
	});
});
