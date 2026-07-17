import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeRendererI18n } from "../i18n";
import { ConfirmDialog } from "./ConfirmDialog";

afterEach(async () => {
	await initializeRendererI18n("en");
});

describe("ConfirmDialog", () => {
	it("localizes its cancel action while preserving caller content", async () => {
		await initializeRendererI18n("zh-CN");
		render(
			<ConfirmDialog
				confirmLabel="Delete Project One"
				description="/repo/project-one"
				onConfirm={vi.fn()}
				onOpenChange={vi.fn()}
				open
				title="Project One"
			/>,
		);

		expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Delete Project One" })).toBeInTheDocument();
		expect(screen.getByText("/repo/project-one")).toBeInTheDocument();
	});
});
