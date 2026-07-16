import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

test("confirm kill button renders without a leading icon while busy", () => {
	render(
		<ConfirmDialog
			open
			title="Kill session?"
			description="This will stop the session."
			confirmLabel="Confirm kill"
			destructive
			busy
			onConfirm={vi.fn()}
			onOpenChange={vi.fn()}
		/>,
	);

	const confirmButton = screen.getByRole("button", { name: "Confirm kill" });

	expect(confirmButton.querySelector("svg")).toBeNull();
});
