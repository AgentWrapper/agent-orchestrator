import { expect, test } from "@playwright/test";
import { mockAoApi } from "./fixtures";

test.beforeEach(async ({ page }) => {
	await mockAoApi(page);
});

test("the Reviews tab renders the reviewer panel for a session that owns PRs", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Open auth stack" }).click();
	await expect(page).toHaveURL(/sessions\/stacked-auth/);

	const inspector = page.locator("#inspector");
	await expect(inspector).toBeVisible();

	await inspector.getByRole("tab", { name: "Reviews" }).click();

	// The reviewer card surfaces the harness, its approved verdict, and both
	// actions — never the empty state, since this session owns a PR.
	await expect(inspector.getByText("No pull request opened yet.")).toHaveCount(0);
	await expect(inspector.getByText("codex")).toBeVisible();
	await expect(inspector.locator(".reviewer-status", { hasText: "Approved" })).toBeVisible();
	await expect(inspector.getByRole("button", { name: "Re-run review" })).toBeVisible();
	await expect(inspector.getByRole("button", { name: "Open terminal" })).toBeVisible();
});

test("the Reviews tab shows the empty state for a session with no PRs", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Open Split terminal mux responsibilities" }).click();
	await expect(page).toHaveURL(/sessions\/refactor-mux/);

	const inspector = page.locator("#inspector");
	await expect(inspector).toBeVisible();

	await inspector.getByRole("tab", { name: "Reviews" }).click();
	await expect(inspector.getByText("No pull request opened yet.")).toBeVisible();
});
