import type { BrowserWindow, MenuItemConstructorOptions } from "electron";

export type BuildWindowsAppMenuDeps = {
	// Closes the active tab of whichever browser panel is currently focused.
	// Returns false when nothing browser-related is focused, so Ctrl+W falls back
	// to the native "close the window" behaviour.
	closeFocusedBrowserTab: () => boolean;
	// Reloads the active tab of whichever browser panel is currently focused.
	// Returns false when nothing browser-related is focused, so Ctrl+R falls back
	// to the native "reload the focused webContents" behaviour. Not left to the
	// native `role: "reload"` alone — that resolves getFocusedWebContents(), which
	// in practice did not reliably resolve to an embedded WebContentsView.
	reloadFocusedTab: () => boolean;
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
				{
					label: "Reload",
					accelerator: "CmdOrCtrl+R",
					click: (_item, focusedWindow) => {
						if (deps.reloadFocusedTab()) return;
						(focusedWindow as BrowserWindow | undefined)?.webContents.reload();
					},
				},
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
