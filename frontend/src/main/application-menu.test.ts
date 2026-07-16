// @vitest-environment node
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import { mainI18n } from "./i18n";
import {
	buildAboutDialogOptions,
	buildApplicationMenuTemplate,
	rebuildApplicationMenu,
	resolveDirectoryChooserTitle,
} from "./application-menu";

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
	return item.submenu as MenuItemConstructorOptions[];
}

function roles(item: MenuItemConstructorOptions): Array<string | undefined> {
	return submenu(item).map((child) => child.type === "separator" ? "separator" : child.role);
}

describe("application menu", () => {
	it("keeps the Windows accelerator roles in their existing order with Chinese labels", () => {
		const template = buildApplicationMenuTemplate({
			platform: "win32",
			productName: "Agent Orchestrator",
			t: mainI18n.getFixedT("zh-CN"),
		});

		expect(template.map((item) => item.label)).toEqual(["编辑", "视图", "窗口"]);
		expect(roles(template[0])).toEqual([
			"undo",
			"redo",
			"separator",
			"cut",
			"copy",
			"paste",
			"selectAll",
		]);
		expect(roles(template[1])).toEqual([
			"reload",
			"toggleDevTools",
			"separator",
			"resetZoom",
			"zoomIn",
			"zoomOut",
			"separator",
			"togglefullscreen",
		]);
		expect(roles(template[2])).toEqual(["minimize", "close"]);
	});

	it("keeps standard macOS app, file, edit, view, window, and help capabilities", () => {
		const template = buildApplicationMenuTemplate({
			platform: "darwin",
			productName: "Agent Orchestrator Remote",
			t: mainI18n.getFixedT("en"),
		});

		expect(template.map((item) => item.label)).toEqual([
			"Agent Orchestrator Remote",
			"File",
			"Edit",
			"View",
			"Window",
			"Help",
		]);
		expect(roles(template[0])).toEqual([
			"about",
			"separator",
			"services",
			"separator",
			"hide",
			"hideOthers",
			"unhide",
			"separator",
			"quit",
		]);
		expect(roles(template[1])).toEqual(["close"]);
		expect(roles(template[2])).toEqual([
			"undo",
			"redo",
			"separator",
			"cut",
			"copy",
			"paste",
			"pasteAndMatchStyle",
			"delete",
			"selectAll",
		]);
		expect(roles(template[3])).toEqual([
			"reload",
			"forceReload",
			"toggleDevTools",
			"separator",
			"resetZoom",
			"zoomIn",
			"zoomOut",
			"separator",
			"togglefullscreen",
		]);
		expect(roles(template[4])).toEqual([
			"minimize",
			"zoom",
			"separator",
			"front",
			"separator",
			"window",
		]);
		expect(roles(template[5])).toEqual(["about"]);
	});

	it("keeps standard Linux close, quit, edit, view, window, help, and about capabilities", () => {
		const template = buildApplicationMenuTemplate({
			platform: "linux",
			productName: "Agent Orchestrator",
			t: mainI18n.getFixedT("zh-CN"),
		});

		expect(template.map((item) => item.label)).toEqual(["文件", "编辑", "视图", "窗口", "帮助"]);
		expect(roles(template[0])).toEqual(["close", "separator", "quit"]);
		expect(roles(template[2])).toContain("toggleDevTools");
		expect(roles(template[3])).toEqual(["minimize", "close"]);
		expect(roles(template[4])).toEqual(["about"]);
	});

	it("rebuilds and installs a menu from the current translator", () => {
		const builtMenu = { id: "menu" };
		const menu = {
			buildFromTemplate: vi.fn(() => builtMenu),
			setApplicationMenu: vi.fn(),
		};

		rebuildApplicationMenu({
			menu,
			platform: "linux",
			productName: "Agent Orchestrator",
			t: mainI18n.getFixedT("en"),
		});

		expect(menu.buildFromTemplate).toHaveBeenCalledOnce();
		expect(menu.setApplicationMenu).toHaveBeenCalledWith(builtMenu);
	});
});

describe("native dialog copy", () => {
	it("uses the supplied Remote product name in Chinese About options", () => {
		expect(
			buildAboutDialogOptions({
				productName: "Agent Orchestrator Remote",
				version: "0.10.3",
				t: mainI18n.getFixedT("zh-CN"),
			}),
		).toEqual({
			type: "info",
			title: "关于 Agent Orchestrator Remote",
			message: "Agent Orchestrator Remote",
			detail: "版本 0.10.3",
			buttons: ["确定"],
		});
	});

	it.each([undefined, "", "  \t"])("localizes a blank directory title fallback (%s)", (title) => {
		expect(resolveDirectoryChooserTitle(title, mainI18n.getFixedT("zh-CN"))).toBe("选择 Git 仓库");
	});

	it("leaves a non-empty caller directory title unchanged", () => {
		expect(resolveDirectoryChooserTitle("  Choose this exact folder  ", mainI18n.getFixedT("zh-CN"))).toBe(
			"  Choose this exact folder  ",
		);
	});
});
