import { expect, test } from "@playwright/test";
import { mockAoApi } from "./fixtures";

// Regression for the dead inspector toggle: rrp v4 derives panel sizes from
// the observed DOM layout, so the flex-grow transition animating an
// imperative expand()/collapse() fired onResize with transient sizes.
// SessionView mirrored every onResize into the ui-store, so a mid-collapse
// frame read as "dragged back open" and re-expanded the panel — the topbar
// button did nothing visible — and a mount-time 0-size event flipped fresh
// profiles to collapsed. Only real separator drags may write back; this needs
// the real rrp + CSS pipeline, which the mocked unit tests can't exercise.
test.beforeEach(async ({ page }) => {
	await mockAoApi(page);
});

test("topbar button collapses and reopens the inspector rail", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Open Split terminal mux responsibilities" }).click();
	await expect(page).toHaveURL(/sessions\/refactor-mux/);

	// Fresh profile: the rail must mount open, not get toggled shut by
	// mount-time layout events.
	const inspector = page.locator("#inspector");
	await expect(inspector).toBeVisible();

	await page.getByRole("button", { name: "Close inspector panel" }).click();
	await expect(inspector).toBeHidden();

	await page.getByRole("button", { name: "Open inspector panel" }).click();
	await expect(inspector).toBeVisible();
});
