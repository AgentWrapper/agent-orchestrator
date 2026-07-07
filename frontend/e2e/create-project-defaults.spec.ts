import { expect, test } from "@playwright/test";
import { mockAoApi } from "./fixtures";

// The web-UI create flow must surface this deployment's standard baseline
// (bypass-permissions + opus) pre-filled in the Project agents sheet, so a
// UI-created project is runnable unattended without a hidden bare default (#63).
test("New Project agents sheet pre-fills the standard bypass + opus baseline", async ({ page }) => {
	await mockAoApi(page);
	await page.goto("/");

	await page.getByRole("button", { name: "New project" }).click();
	await expect(page.getByRole("dialog", { name: "Project path" })).toBeVisible();
	await page.getByRole("textbox", { name: "Project path" }).fill("/Users/me/throwaway-project");
	await page.getByRole("button", { name: "Continue" }).click();

	const sheet = page.getByRole("dialog", { name: "Project agents" });
	await expect(sheet).toBeVisible();

	// Defaults are visible and editable, not a hidden bare config.
	await expect(sheet.getByRole("combobox", { name: "Permission mode" })).toHaveText("Bypass permissions");
	await expect(sheet.getByRole("textbox", { name: "Model" })).toHaveValue("opus");

	// Artifact lands under Playwright's gitignored output dir.
	await page.screenshot({ path: "test-results/create-project-defaults.png" });
});
