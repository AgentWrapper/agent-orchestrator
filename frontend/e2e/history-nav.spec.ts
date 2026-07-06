import { expect, test } from "@playwright/test";
import { mockAoApi } from "./fixtures";

// Repro for the titlebar history arrows: navigate home → project → back,
// then the forward arrow must be enabled and actually traverse forward.
test.use({
	userAgent:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});

test.beforeEach(async ({ page }) => {
	await mockAoApi(page);
});

test("titlebar back/forward arrows traverse history", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByText("Projects")).toBeVisible();

	// Navigate: home → session view (in-app push).
	await page.getByRole("button", { name: "Open Split terminal mux responsibilities" }).click();
	await expect(page).toHaveURL(/sessions\/refactor-mux/);

	const back = page.getByRole("button", { name: "Go back" });
	const forward = page.getByRole("button", { name: "Go forward" });

	await expect(forward).toBeDisabled();
	await expect(back).toBeEnabled();

	await back.click();
	await expect(page).not.toHaveURL(/sessions\/refactor-mux/);

	await expect(forward).toBeEnabled();
	await forward.click();
	await expect(page).toHaveURL(/sessions\/refactor-mux/);
});
