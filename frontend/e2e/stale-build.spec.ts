import { expect, test } from "@playwright/test";
import { mockAoApi } from "./fixtures";

test("stale browser bundles show a reload banner", async ({ page }) => {
	await mockAoApi(page, { build: { frontendTree: "newer-served-frontend-tree" } });

	const buildResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/ao-web-build.json");
	await page.goto("/");
	await expect((await buildResponse).json()).resolves.toMatchObject({ frontendTree: "newer-served-frontend-tree" });

	const banner = page.getByRole("alert").filter({ hasText: "A different AO web build is available" });
	await expect(banner).toBeVisible({ timeout: 10_000 });
	await expect(banner.getByRole("button", { name: "Reload" })).toBeVisible();
	await page.screenshot({ path: "test-results/stale-build-banner.png" });
});
