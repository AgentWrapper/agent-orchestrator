import type { MenuItemConstructorOptions, MessageBoxOptions } from "electron";
import type { TFunction } from "i18next";

type ApplicationMenuOptions = {
	platform: NodeJS.Platform;
	productName: string;
	t: TFunction;
	onAbout(): void;
};

type ApplicationMenuApi<MenuType> = {
	buildFromTemplate(template: MenuItemConstructorOptions[]): MenuType;
	setApplicationMenu(menu: MenuType | null): void;
};

type RebuildApplicationMenuOptions<MenuType> = ApplicationMenuOptions & {
	menu: ApplicationMenuApi<MenuType>;
};

const separator = (): MenuItemConstructorOptions => ({ type: "separator" });

function editMenu(t: TFunction, includeDesktopRoles: boolean, includeMacRoles = false): MenuItemConstructorOptions {
	return {
		label: t("native.menu.edit"),
		submenu: [
			{ role: "undo", label: t("native.menu.undo") },
			{ role: "redo", label: t("native.menu.redo") },
			separator(),
			{ role: "cut", label: t("native.menu.cut") },
			{ role: "copy", label: t("native.menu.copy") },
			{ role: "paste", label: t("native.menu.paste") },
			...(includeDesktopRoles
				? [
						{ role: "pasteAndMatchStyle" as const, label: t("native.menu.pasteAndMatchStyle") },
						{ role: "delete" as const, label: t("native.menu.delete") },
					]
				: []),
			{ role: "selectAll", label: t("native.menu.selectAll") },
			...(includeMacRoles
				? [
						separator(),
						{
							label: t("native.menu.substitutions"),
							submenu: [
								{ role: "showSubstitutions" as const, label: t("native.menu.showSubstitutions") },
								separator(),
								{ role: "toggleSmartQuotes" as const, label: t("native.menu.smartQuotes") },
								{ role: "toggleSmartDashes" as const, label: t("native.menu.smartDashes") },
								{ role: "toggleTextReplacement" as const, label: t("native.menu.textReplacement") },
							],
						},
						separator(),
						{
							label: t("native.menu.speech"),
							submenu: [
								{ role: "startSpeaking" as const, label: t("native.menu.startSpeaking") },
								{ role: "stopSpeaking" as const, label: t("native.menu.stopSpeaking") },
							],
						},
					]
				: []),
		],
	};
}

function viewMenu(t: TFunction, includeForceReload: boolean): MenuItemConstructorOptions {
	return {
		label: t("native.menu.view"),
		submenu: [
			{ role: "reload", label: t("native.menu.reload") },
			...(includeForceReload
				? [{ role: "forceReload" as const, label: t("native.menu.forceReload") }]
				: []),
			{ role: "toggleDevTools", label: t("native.menu.toggleDevTools") },
			separator(),
			{ role: "resetZoom", label: t("native.menu.resetZoom") },
			{ role: "zoomIn", label: t("native.menu.zoomIn") },
			{ role: "zoomOut", label: t("native.menu.zoomOut") },
			separator(),
			{ role: "togglefullscreen", label: t("native.menu.toggleFullscreen") },
		],
	};
}

function aboutItem(productName: string, t: TFunction, onAbout: () => void): MenuItemConstructorOptions {
	return { label: t("native.menu.about", { productName }), click: onAbout };
}

export function buildApplicationMenuTemplate({
	platform,
	productName,
	t,
	onAbout,
}: ApplicationMenuOptions): MenuItemConstructorOptions[] {
	if (platform === "win32") {
		return [
			editMenu(t, false),
			viewMenu(t, false),
			{
				label: t("native.menu.window"),
				submenu: [
					{ role: "minimize", label: t("native.menu.minimize") },
					{ role: "close", label: t("native.menu.close") },
				],
			},
		];
	}

	const fileMenu: MenuItemConstructorOptions = {
		label: t("native.menu.file"),
		submenu:
			platform === "darwin"
				? [{ role: "close", label: t("native.menu.close") }]
				: [
						{ role: "close", label: t("native.menu.close") },
						separator(),
						{ role: "quit", label: t("native.menu.quit", { productName }) },
					],
	};
	const windowMenu: MenuItemConstructorOptions = {
		label: t("native.menu.window"),
		submenu:
			platform === "darwin"
				? [
						{ role: "minimize", label: t("native.menu.minimize") },
						{ role: "zoom", label: t("native.menu.zoom") },
						separator(),
						{ role: "front", label: t("native.menu.bringAllToFront") },
					]
				: [
						{ role: "minimize", label: t("native.menu.minimize") },
						{ role: "zoom", label: t("native.menu.zoom") },
						{ role: "close", label: t("native.menu.close") },
					],
	};
	const helpMenu: MenuItemConstructorOptions = {
		label: t("native.menu.help"),
		submenu: [aboutItem(productName, t, onAbout)],
	};
	const commonMenus = [fileMenu, editMenu(t, true, platform === "darwin"), viewMenu(t, true), windowMenu, helpMenu];

	if (platform !== "darwin") return commonMenus;

	return [
		{
			label: productName,
			submenu: [
				aboutItem(productName, t, onAbout),
				separator(),
				{ role: "services", label: t("native.menu.services") },
				separator(),
				{ role: "hide", label: t("native.menu.hide", { productName }) },
				{ role: "hideOthers", label: t("native.menu.hideOthers") },
				{ role: "unhide", label: t("native.menu.showAll") },
				separator(),
				{ role: "quit", label: t("native.menu.quit", { productName }) },
			],
		},
		...commonMenus,
	];
}

export function rebuildApplicationMenu<MenuType>({
	menu,
	...options
}: RebuildApplicationMenuOptions<MenuType>): void {
	menu.setApplicationMenu(menu.buildFromTemplate(buildApplicationMenuTemplate(options)));
}

export function buildAboutDialogOptions({
	productName,
	version,
	t,
}: {
	productName: string;
	version: string;
	t: TFunction;
}): MessageBoxOptions {
	return {
		type: "info",
		title: t("native.about.title", { productName }),
		message: productName,
		detail: t("native.about.version", { version }),
		buttons: [t("native.about.ok")],
	};
}

export function resolveDirectoryChooserTitle(title: unknown, t: TFunction): string {
	return typeof title === "string" && title.trim() ? title : t("native.directory.chooseRepository");
}
