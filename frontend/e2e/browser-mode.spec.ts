import { expect, test } from "@playwright/test";
import { mockAoApi } from "./fixtures";

test("browser mode routes avoid Electron bridge errors and dead Electron controls", async ({ page }) => {
	const errors: string[] = [];
	const captureError = (message: string) => {
		if (message.includes("Cannot read properties of undefined (reading 'dimensions')")) return;
		errors.push(message);
	};
	page.on("console", (message) => {
		if (message.type() === "error") captureError(message.text());
	});
	page.on("pageerror", (error) => {
		captureError(error.message);
	});
	await mockAoApi(page);

	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Board" })).toBeVisible();

	await page.goto("/#/settings");
	await expect(page.getByText(/managed outside browser mode/i)).toBeVisible();
	await expect(page.getByRole("button", { name: "Check for updates" })).toHaveCount(0);

	await page.goto("/#/projects/api-gateway/sessions/refactor-mux");
	const inspector = page.locator("#inspector");
	await expect(inspector.getByRole("tab", { name: "Summary" })).toBeVisible();
	await expect(inspector.getByRole("tab", { name: "Reviews" })).toBeVisible();
	await expect(inspector.getByRole("tab", { name: "Browser" })).toHaveCount(0);

	await page.goto("/#/prs");
	await expect(page.getByRole("heading", { name: "Pull requests" })).toBeVisible();
	expect(errors).toEqual([]);
});
