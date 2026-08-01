import type { MenuItemConstructorOptions } from "electron";

export type BuildWindowsAppMenuDeps = {
	// Closes the active tab of whichever browser panel is currently focused.
	// Returns false when nothing browser-related is focused, so Ctrl+W falls back
	// to the native "close the window" behaviour.
	closeFocusedBrowserTab: () => boolean;
};

export function buildWindowsAppMenuTemplate(deps: BuildWindowsAppMenuDeps): MenuItemConstructorOptions[] {
	return [
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ accelerator: "Ctrl+=", role: "zoomIn" },
				{ accelerator: "Ctrl+Plus", acceleratorWorksWhenHidden: true, role: "zoomIn", visible: false },
				{ accelerator: "Ctrl+-", role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "Window",
			submenu: [
				{ role: "minimize" },
				{
					label: "Close",
					accelerator: "CmdOrCtrl+W",
					click: (_item, focusedWindow) => {
						if (deps.closeFocusedBrowserTab()) return;
						focusedWindow?.close();
					},
				},
			],
		},
	];
}
