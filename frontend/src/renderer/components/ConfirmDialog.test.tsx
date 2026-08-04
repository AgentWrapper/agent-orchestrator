import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

test("uses the same centered settings-dialog layout as nearby app dialogs", () => {
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

	const dialog = screen.getByRole("dialog", { name: "Kill session?" });

	expect(dialog).toHaveClass("left-[50%]", "top-[50%]", "z-overlay", "bg-popover", "p-0");
	expect(screen.getByRole("button", { name: "Confirm kill" }).querySelector("svg")).toBeNull();
});
