import { expect, test } from "@playwright/test";
import { installFakeAgent } from "./support/fake-bridge";

// BRD-* RENDERER SMOKE (issue #2483, renderer slice). dev:web + fake bridge —
// does NOT hit the real daemon/storage/API/preload/PTY/FS. Those boundaries are
// exercised only in the packaged-app pod gate (#2697), which today runs a
// boot-level smoke (app launches, daemon ready), NOT these cases — per-case pod
// coverage is future work. Drives the board off the fake-agent CDC SSE stream so
// column moves and live updates exercise the same SSE → invalidate → refetch
// path the real daemon uses (see fake-bridge.ts). IDs cross-reference #2483.

const columnCard = (column: string, id: string) =>
	`[data-testid="board-column"][data-column="${column}"] [data-session-id="${id}"]`;

// #2483 BRD-002.
test("renderer: card moves columns when its status changes @T0 @BRD", async ({ page }) => {
	await installFakeAgent(page, { workers: [{ id: "mover", title: "Wandering worker", status: "working" }] });
	await page.goto("/#/");
	await expect(page.getByTestId("board")).toBeVisible();
	// Starts in Working.
	await expect(page.locator(columnCard("working", "mover"))).toBeVisible();
	await expect(page.locator(columnCard("action", "mover"))).toHaveCount(0);

	// Fake agent hits waiting_input → the card must move to the "Needs you" column.
	await page.evaluate(() => window.__aoFakeAgent!.setStatus("mover", "needs_input", "waiting_input"));

	await expect(page.locator(columnCard("action", "mover"))).toBeVisible();
	await expect(page.locator(columnCard("working", "mover"))).toHaveCount(0);
	await expect(page.locator(columnCard("action", "mover"))).toContainText("Input needed");
});

// #2483 BRD-006.
test("renderer: SSE pushes card updates without a manual refresh @T0 @BRD", async ({ page }) => {
	await installFakeAgent(page, { workers: [{ id: "live", title: "Live worker", status: "working" }] });
	await page.goto("/#/");
	await expect(page.locator(columnCard("working", "live"))).toContainText("Working");

	// A single CDC frame (no page.reload) must repaint the card into "Ready to
	// merge" with its new badge.
	await page.evaluate(() => window.__aoFakeAgent!.setStatus("live", "mergeable", "idle"));

	await expect(page.locator(columnCard("merge", "live"))).toBeVisible();
	await expect(page.locator(columnCard("merge", "live"))).toContainText("Ready");
});
