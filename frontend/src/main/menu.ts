import type { MenuItemConstructorOptions } from "electron";

export const APP_NAME = "Agent Orchestrator";

function buildAppSubmenu(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
	if (platform === "darwin") {
		return [
			{ label: `About ${APP_NAME}`, role: "about" },
			{ type: "separator" },
			{ role: "services" },
			{ type: "separator" },
			{ label: `Hide ${APP_NAME}`, role: "hide" },
			{ role: "hideOthers" },
			{ role: "unhide" },
			{ type: "separator" },
			{ label: `Quit ${APP_NAME}`, role: "quit" },
		];
	}

	return [
		{ label: `About ${APP_NAME}`, role: "about" },
		{ type: "separator" },
		{ label: `Quit ${APP_NAME}`, role: "quit" },
	];
}

export function buildAppMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
	const zoomInItems: MenuItemConstructorOptions[] =
		platform === "win32"
			? [
					{ accelerator: "Ctrl+=", role: "zoomIn" },
					{ accelerator: "Ctrl+Plus", acceleratorWorksWhenHidden: true, role: "zoomIn", visible: false },
				]
			: [{ role: "zoomIn" }];

	const template: MenuItemConstructorOptions[] = [
		{
			label: APP_NAME,
			submenu: buildAppSubmenu(platform),
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "pasteAndMatchStyle" },
				{ role: "delete" },
				{ role: "selectAll" },
				{ type: "separator" },
				{
					label: "Speech",
					submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
				},
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				...zoomInItems,
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "Window",
			submenu: [{ role: "close" }, { role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
		},
		{
			label: "Help",
			submenu: [],
		},
	];

	if (platform === "win32") {
		const viewMenu = template.find((item) => item.label === "View");
		if (viewMenu && Array.isArray(viewMenu.submenu)) {
			const zoomOutItem = viewMenu.submenu.find((item) => item.role === "zoomOut");
			if (zoomOutItem) zoomOutItem.accelerator = "Ctrl+-";
		}
	}

	return template;
}
