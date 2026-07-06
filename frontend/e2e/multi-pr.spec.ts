import { expect, test } from "@playwright/test";
import { mockAoApi } from "./fixtures";

test.beforeEach(async ({ page }) => {
	await mockAoApi(page);
});

test("the inspector rail stacks every PR a session owns, actionable-first", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Open auth stack" }).click();
	await expect(page).toHaveURL(/sessions\/stacked-auth/);

	const inspector = page.locator("#inspector");
	await expect(inspector).toBeVisible();

	// Plural heading reflects the stack size.
	await expect(inspector.getByText("Pull requests (3)")).toBeVisible();

	// One card per PR, ordered open → draft → merged (the merged base sinks).
	// Scope to the PR section: the Activity timeline also renders "Opened PR #n".
	const prSection = inspector.locator("section.inspector-section", { hasText: "Pull requests (3)" });
	const cards = prSection.locator("text=/^PR #\\d+$/");
	await expect(cards).toHaveText(["PR #41", "PR #42", "PR #40"]);
});

test("the PR board lists one row per attributed PR, actionable PRs first", async ({ page }) => {
	await page.goto("/#/prs");

	await expect(page.getByRole("heading", { name: "Pull requests" })).toBeVisible();

	// stacked-auth's three PRs keep actionable-first order across the whole board:
	// open #41 before draft #42, and the lone merged PR (#40) sinks to the bottom.
	const numbers = await page.locator("tbody tr td:first-child").allTextContents();
	expect(numbers.indexOf("#41")).toBeLessThan(numbers.indexOf("#42"));
	expect(numbers.indexOf("#42")).toBeLessThan(numbers.indexOf("#40"));
	expect(numbers.indexOf("#40")).toBe(numbers.length - 1);

	// Open/draft rows are actionable; the merged row is not.
	const mergedRow = page.locator("tbody tr", { hasText: "#40" });
	await expect(mergedRow.getByRole("button", { name: "Merge" })).toHaveCount(0);
	const openRow = page.locator("tbody tr", { hasText: "#41" });
	await expect(openRow.getByRole("button", { name: "Merge" })).toBeVisible();
});
