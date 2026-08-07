import { describe, expect, it } from "vitest";
import { APP_NAME, buildAppMenuTemplate } from "./menu";

type MenuItem = ReturnType<typeof buildAppMenuTemplate>[number];
type SubmenuItem = NonNullable<Extract<MenuItem["submenu"], readonly unknown[]>>[number];

function appSubmenu(platform: NodeJS.Platform): readonly SubmenuItem[] {
	const appMenu = buildAppMenuTemplate(platform)[0];
	if (!appMenu || !Array.isArray(appMenu.submenu)) {
		throw new Error("App menu not found");
	}
	return appMenu.submenu;
}

function viewSubmenu(platform: NodeJS.Platform = "linux"): readonly SubmenuItem[] {
	const viewMenu = buildAppMenuTemplate(platform).find((item) => item.label === "View");
	if (!viewMenu || !Array.isArray(viewMenu.submenu)) {
		throw new Error("View menu not found");
	}
	return viewMenu.submenu;
}

describe("buildAppMenuTemplate", () => {
	it.each(["darwin", "linux", "win32"] as const)("uses Agent Orchestrator as the app menu label on %s", (platform) => {
		const appMenu = buildAppMenuTemplate(platform)[0];

		expect(appMenu.label).toBe(APP_NAME);
		expect(appSubmenu(platform)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: `About ${APP_NAME}`, role: "about" }),
				expect.objectContaining({ label: `Quit ${APP_NAME}`, role: "quit" }),
			]),
		);
	});

	it("keeps macOS app menu roles", () => {
		expect(appSubmenu("darwin")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: `Hide ${APP_NAME}`, role: "hide" }),
				expect.objectContaining({ role: "services" }),
			]),
		);
	});

	it("registers both Windows plus key forms for zoom in", () => {
		const zoomInItems = viewSubmenu("win32").filter((item) => item.role === "zoomIn");

		expect(zoomInItems).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ accelerator: "Ctrl+=", role: "zoomIn" }),
				expect.objectContaining({ accelerator: "Ctrl+Plus", role: "zoomIn", visible: false }),
			]),
		);
	});

	it("keeps the direct Windows minus accelerator for zoom out", () => {
		expect(viewSubmenu("win32")).toContainEqual(expect.objectContaining({ accelerator: "Ctrl+-", role: "zoomOut" }));
	});
});
