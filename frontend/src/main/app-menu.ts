import type { MenuItemConstructorOptions } from "electron";

export const APP_DISPLAY_NAME = "Agent Orchestrator";
export const APP_REPOSITORY_URL = "https://github.com/AgentWrapper/agent-orchestrator";

type OpenExternal = (url: string) => Promise<void> | void;

export type ApplicationMenuOptions = {
	platform: NodeJS.Platform;
	isDev: boolean;
	openExternal?: OpenExternal;
};

export type ApplicationMenuApi<TMenu> = {
	buildFromTemplate: (template: MenuItemConstructorOptions[]) => TMenu;
	setApplicationMenu: (menu: TMenu | null) => void;
};

function separator(): MenuItemConstructorOptions {
	return { type: "separator" };
}

function buildMacAppMenu(): MenuItemConstructorOptions {
	return {
		label: APP_DISPLAY_NAME,
		submenu: [
			{ role: "about", label: `About ${APP_DISPLAY_NAME}` },
			separator(),
			{ role: "services" },
			separator(),
			{ role: "hide", label: `Hide ${APP_DISPLAY_NAME}` },
			{ role: "hideOthers" },
			{ role: "unhide" },
			separator(),
			{ role: "quit", label: `Quit ${APP_DISPLAY_NAME}` },
		],
	};
}

function buildFileMenu(platform: NodeJS.Platform): MenuItemConstructorOptions {
	return {
		label: "File",
		submenu: platform === "darwin" ? [{ role: "close" }] : [{ role: "close" }, separator(), { role: "quit" }],
	};
}

function buildEditMenu(): MenuItemConstructorOptions {
	return {
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			separator(),
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "pasteAndMatchStyle" },
			{ role: "delete" },
			{ role: "selectAll" },
		],
	};
}

function buildViewMenu(isDev: boolean): MenuItemConstructorOptions {
	const browserControls: MenuItemConstructorOptions[] = [
		{ role: "resetZoom" },
		{ role: "zoomIn" },
		{ role: "zoomOut" },
		separator(),
		{ role: "togglefullscreen" },
	];

	return {
		label: "View",
		submenu: isDev
			? [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, separator(), ...browserControls]
			: browserControls,
	};
}

function buildWindowMenu(platform: NodeJS.Platform): MenuItemConstructorOptions {
	return {
		label: "Window",
		submenu:
			platform === "darwin"
				? [{ role: "minimize" }, { role: "zoom" }, separator(), { role: "front" }]
				: [{ role: "minimize" }, { role: "close" }],
	};
}

function buildHelpMenu(openExternal?: OpenExternal): MenuItemConstructorOptions {
	return {
		label: "Help",
		submenu: [
			{
				label: `${APP_DISPLAY_NAME} on GitHub`,
				enabled: Boolean(openExternal),
				click: () => {
					void openExternal?.(APP_REPOSITORY_URL);
				},
			},
		],
	};
}

export function buildApplicationMenuTemplate({
	platform,
	isDev,
	openExternal,
}: ApplicationMenuOptions): MenuItemConstructorOptions[] {
	const template: MenuItemConstructorOptions[] = [
		buildFileMenu(platform),
		buildEditMenu(),
		buildViewMenu(isDev),
		buildWindowMenu(platform),
		buildHelpMenu(openExternal),
	];

	if (platform === "darwin") {
		return [buildMacAppMenu(), ...template];
	}

	return template;
}

export function installApplicationMenu<TMenu>({
	Menu,
	platform,
	isDev,
	openExternal,
}: ApplicationMenuOptions & { Menu: ApplicationMenuApi<TMenu> }): void {
	Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate({ platform, isDev, openExternal })));
}
