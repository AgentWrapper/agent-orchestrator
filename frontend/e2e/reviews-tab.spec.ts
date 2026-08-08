import { expect, test } from "@playwright/test";

// dev:web (VITE_NO_ELECTRON=1) serves lib/mock-data.ts, whose "stacked-auth"
// session ("auth stack") owns three PRs — so the inspector's Reviews tab is
// enabled. The tab fetches review runs and project config straight from the
// daemon; dev:web has no daemon, so we stub those two routes to drive the
// reviewer panel and prove it renders a real reviewer card (not the empty
// "no PR yet" placeholder) once a session owns a PR.

test("the Reviews tab renders the reviewer panel for a session that owns PRs", async ({ page }) => {
	await page.route("**/api/v1/sessions/stacked-auth/reviews", (route) =>
		route.fulfill({
			json: {
				reviewerHandleId: "reviewer-pane",
				reviews: [
					{
						id: "run-1",
						reviewId: "review-1",
						sessionId: "stacked-auth",
						harness: "codex",
						status: "complete",
						verdict: "approved",
						body: "Looks good.",
						prUrl: "https://github.com/me/api-gateway/pull/41",
						targetSha: "abc123",
						createdAt: new Date().toISOString(),
					},
				],
			},
		}),
	);
	await page.route("**/api/v1/projects/api-gateway", (route) =>
		route.fulfill({
			json: {
				status: "ok",
				project: {
					id: "api-gateway",
					kind: "git",
					name: "api-gateway",
					path: "/Users/me/api-gateway",
					repo: "api-gateway",
					defaultBranch: "main",
					config: { reviewers: [{ harness: "codex" }] },
				},
			},
		}),
	);

	await page.goto("/");
	await page.getByRole("button", { name: "Open auth stack" }).click();
	await expect(page).toHaveURL(/sessions\/stacked-auth/);

	const inspector = page.locator("#inspector");
	await expect(inspector).toBeVisible();

	await inspector.getByRole("tab", { name: "Reviews" }).click();

	// The reviewer card surfaces the harness, its approved verdict, and the rerun
	// action — never the empty state, since this session owns a PR.
	await expect(inspector.getByText("No pull request opened yet.")).toHaveCount(0);
	await expect(inspector.getByText("codex")).toBeVisible();
	await expect(inspector.getByText("Approved")).toBeVisible();
	await expect(inspector.getByRole("button", { name: "Re-run review" })).toBeVisible();
	await expect(inspector.getByRole("button", { name: "Open terminal" })).toHaveCount(0);
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
