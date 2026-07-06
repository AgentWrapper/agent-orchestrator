import { expect, test } from "@playwright/test";
import { mockAoApi } from "./fixtures";

test.beforeEach(async ({ page }) => {
	await mockAoApi(page);
});

test("renders the orchestrator-first workbench shell", async ({ page }) => {
	await page.goto("/");
	// The single pinned Orchestrator anchor + the Projects group + a name-only worker row.
	await expect(page.getByRole("button", { name: "Orchestrator board", exact: true })).toBeVisible();
	await expect(page.getByText("Projects")).toBeVisible();
	await expect(page.getByRole("button", { name: "Open fix-webgl-fallback", exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Board" })).toBeVisible();
});

test("deep-links into a worker session", async ({ page }) => {
	await page.goto("/#/projects/api-gateway/sessions/refactor-mux");
	await expect(page.locator(".dashboard-app-header")).toBeVisible();
	await expect(page.getByTestId("terminal").getByText("Split terminal mux responsibilities")).toBeVisible();
});

test("drilling into a worker opens its Git review rail", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Open Split terminal mux responsibilities" }).click();
	await expect(page).toHaveURL(/sessions\/refactor-mux/);
	await expect(page.getByTestId("terminal").getByText("Split terminal mux responsibilities")).toBeVisible();
});

test("web mode opens an in-app project path prompt from the New project button", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "New project" }).click();

	await expect(page.getByRole("dialog", { name: "Project path" })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Project path" })).toBeFocused();
});
