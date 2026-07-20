import { expect, test } from "@playwright/test";

// Standalone shell terminals (#2822): shells the user opens by hand, with no
// agent session behind them. They render as tabs beside the session's own pane.
// The real pane needs a daemon-spawned PTY, so the preview build stands in with
// an in-memory shell list — enough to cover the parts that live in the renderer:
// which tab is current, and that opening/closing updates the strip.
test("opens, selects, and closes standalone shell terminals from the tab strip", async ({ page }) => {
	await page.goto("/#/projects/ao-demo/sessions/demo-working");
	await expect(page.getByRole("button", { name: "New terminal" })).toBeVisible();

	const closeButtons = page.getByRole("button", { name: /^Close terminal / });
	const initialCount = await closeButtons.count();

	// The topbar action opens a shell and makes it the active pane.
	await page.getByRole("button", { name: "New terminal" }).click();
	await expect(closeButtons).toHaveCount(initialCount + 1);

	// Selecting the session tab hands the pane back to the agent. Matched by
	// title, not role-name: the tab's accessible name is the session's title.
	const sessionTab = page.getByTitle("Session terminal");
	await sessionTab.click();
	await expect(sessionTab).toHaveAttribute("aria-current", "true");

	// Closing a shell removes exactly its own tab.
	await closeButtons.last().click();
	await expect(closeButtons).toHaveCount(initialCount);
});
