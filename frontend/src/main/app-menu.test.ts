// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { APP_DISPLAY_NAME, buildApplicationMenuTemplate, installApplicationMenu } from "./app-menu";

type MenuItem = {
	label?: string;
	role?: string;
	submenu?: MenuItem[];
	type?: string;
};

function collectLabels(items: MenuItem[]): string[] {
	return items.flatMap((item) => [
		item.label ?? "",
		...(Array.isArray(item.submenu) ? collectLabels(item.submenu) : []),
	]);
}

function collectRoles(items: MenuItem[]): string[] {
	return items.flatMap((item) => [item.role ?? "", ...(Array.isArray(item.submenu) ? collectRoles(item.submenu) : [])]);
}

describe("buildApplicationMenuTemplate", () => {
	it("brands the macOS app menu as Agent Orchestrator", () => {
		const template = buildApplicationMenuTemplate({ platform: "darwin", isDev: true });
		const appMenu = template[0] as MenuItem;

		expect(appMenu.label).toBe(APP_DISPLAY_NAME);
		expect(appMenu.submenu?.map((item) => item.role)).toEqual([
			"about",
			undefined,
			"services",
			undefined,
			"hide",
			"hideOthers",
			"unhide",
			undefined,
			"quit",
		]);
		expect(appMenu.submenu?.find((item) => item.role === "about")?.label).toBe(`About ${APP_DISPLAY_NAME}`);
		expect(appMenu.submenu?.find((item) => item.role === "hide")?.label).toBe(`Hide ${APP_DISPLAY_NAME}`);
		expect(appMenu.submenu?.find((item) => item.role === "quit")?.label).toBe(`Quit ${APP_DISPLAY_NAME}`);
		expect(collectLabels(template as MenuItem[]).some((label) => /electron/i.test(label))).toBe(false);
	});

	it("keeps standard top-level menus without a macOS app menu on Linux and Windows", () => {
		const linuxTemplate = buildApplicationMenuTemplate({ platform: "linux", isDev: true }) as MenuItem[];
		const windowsTemplate = buildApplicationMenuTemplate({ platform: "win32", isDev: true }) as MenuItem[];

		expect(linuxTemplate.map((item) => item.label)).toEqual(["File", "Edit", "View", "Window", "Help"]);
		expect(windowsTemplate.map((item) => item.label)).toEqual(["File", "Edit", "View", "Window", "Help"]);
		expect(linuxTemplate[0]?.label).not.toBe(APP_DISPLAY_NAME);
		expect(windowsTemplate[0]?.label).not.toBe(APP_DISPLAY_NAME);
	});

	it("keeps reload and devtools roles in development only", () => {
		const devRoles = collectRoles(buildApplicationMenuTemplate({ platform: "darwin", isDev: true }) as MenuItem[]);
		const prodRoles = collectRoles(buildApplicationMenuTemplate({ platform: "darwin", isDev: false }) as MenuItem[]);

		expect(devRoles).toEqual(expect.arrayContaining(["reload", "forceReload", "toggleDevTools"]));
		expect(prodRoles).not.toContain("reload");
		expect(prodRoles).not.toContain("forceReload");
		expect(prodRoles).not.toContain("toggleDevTools");
		expect(prodRoles).toEqual(expect.arrayContaining(["resetZoom", "zoomIn", "zoomOut", "togglefullscreen"]));
	});
});

describe("installApplicationMenu", () => {
	it("builds and installs the native menu from the branded template", () => {
		const builtMenu = { id: "native-menu" };
		const Menu = {
			buildFromTemplate: vi.fn(() => builtMenu),
			setApplicationMenu: vi.fn(),
		};

		installApplicationMenu({ Menu, platform: "darwin", isDev: true });

		expect(Menu.buildFromTemplate).toHaveBeenCalledWith(
			expect.arrayContaining([expect.objectContaining({ label: APP_DISPLAY_NAME })]),
		);
		expect(Menu.setApplicationMenu).toHaveBeenCalledWith(builtMenu);
	});
});
