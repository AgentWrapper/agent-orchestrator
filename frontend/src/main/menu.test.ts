import { describe, expect, it, vi } from "vitest";
import { buildWindowsAppMenuTemplate } from "./menu";

type MenuItem = ReturnType<typeof buildWindowsAppMenuTemplate>[number];
type SubmenuItem = NonNullable<Extract<MenuItem["submenu"], readonly unknown[]>>[number];

function buildTemplate(closeFocusedBrowserTab: () => boolean = () => false) {
	return buildWindowsAppMenuTemplate({ closeFocusedBrowserTab });
}

function viewSubmenu(): readonly SubmenuItem[] {
	const viewMenu = buildTemplate().find((item) => item.label === "View");
	if (!viewMenu || !Array.isArray(viewMenu.submenu)) {
		throw new Error("View menu not found");
	}
	return viewMenu.submenu;
}

function windowSubmenu(closeFocusedBrowserTab?: () => boolean): readonly SubmenuItem[] {
	const windowMenu = buildTemplate(closeFocusedBrowserTab).find((item) => item.label === "Window");
	if (!windowMenu || !Array.isArray(windowMenu.submenu)) {
		throw new Error("Window menu not found");
	}
	return windowMenu.submenu;
}

describe("buildWindowsAppMenuTemplate", () => {
	it("registers both plus key forms for zoom in", () => {
		const zoomInItems = viewSubmenu().filter((item) => item.role === "zoomIn");

		expect(zoomInItems).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ accelerator: "Ctrl+=", role: "zoomIn" }),
				expect.objectContaining({ accelerator: "Ctrl+Plus", role: "zoomIn", visible: false }),
			]),
		);
	});

	it("keeps the direct minus accelerator for zoom out", () => {
		expect(viewSubmenu()).toContainEqual(expect.objectContaining({ accelerator: "Ctrl+-", role: "zoomOut" }));
	});

	it("replaces the close role with a custom Ctrl+W item", () => {
		const closeItem = windowSubmenu().find((item) => item.label === "Close");
		expect(closeItem).toBeDefined();
		expect(closeItem?.role).toBeUndefined();
		expect(closeItem?.accelerator).toBe("CmdOrCtrl+W");
	});

	it("closes the focused browser tab instead of the window when one is focused", () => {
		const closeFocusedBrowserTab = vi.fn(() => true);
		const closeItem = windowSubmenu(closeFocusedBrowserTab).find((item) => item.label === "Close");
		const focusedWindow = { close: vi.fn() };

		closeItem?.click?.({} as never, focusedWindow as never, {} as never);

		expect(closeFocusedBrowserTab).toHaveBeenCalledTimes(1);
		expect(focusedWindow.close).not.toHaveBeenCalled();
	});

	it("falls back to closing the window when no browser tab is focused", () => {
		const closeFocusedBrowserTab = vi.fn(() => false);
		const closeItem = windowSubmenu(closeFocusedBrowserTab).find((item) => item.label === "Close");
		const focusedWindow = { close: vi.fn() };

		closeItem?.click?.({} as never, focusedWindow as never, {} as never);

		expect(focusedWindow.close).toHaveBeenCalledTimes(1);
	});
});
