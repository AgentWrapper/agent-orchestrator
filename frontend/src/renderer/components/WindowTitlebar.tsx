import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import aoLogo from "../assets/ao-logo.png";
import { useUiStore } from "../stores/ui-store";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useTranslation } from "react-i18next";

// Windows-only: macOS keeps its system menu bar and inset traffic lights; Linux
// keeps the existing minimal chrome. Only Windows loses the native title bar and
// needs the app to paint its own (see the win32 branch in main.ts).
const isWindows =
	typeof navigator !== "undefined" &&
	/win/i.test(
		(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
			navigator.platform ??
			"",
	);

type MenuKey = "file" | "edit" | "view" | "window" | "help";

// Dispatch a native-menu action to the main process (see menu:action in main.ts).
const act = (action: string) => () => {
	void window.ao?.menu?.action(action);
};

// One top-level menu (File/Edit/…). Declared at module scope, not inside
// WindowTitlebar, so React keeps it mounted across renders and the open dropdown
// doesn't reset while `openMenu` state changes.
function TopMenu({
	id,
	label,
	openMenu,
	setOpenMenu,
	children,
}: {
	id: MenuKey;
	label: string;
	openMenu: MenuKey | null;
	setOpenMenu: (key: MenuKey | null) => void;
	children: React.ReactNode;
}) {
	return (
		// modal={false} so pointer events still reach the sibling triggers while a
		// menu is open — that's what lets hover switch File → Edit like a real menu bar.
		<DropdownMenu modal={false} open={openMenu === id} onOpenChange={(open) => setOpenMenu(open ? id : null)}>
			<DropdownMenuTrigger asChild>
				<button
					className="window-titlebar__menu-btn"
					data-active={openMenu === id ? "" : undefined}
					onMouseEnter={() => setOpenMenu(openMenu === null ? null : id)}
					type="button"
				>
					{label}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="window-titlebar__menu" sideOffset={4}>
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function WindowTitlebar() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const theme = useUiStore((state) => state.theme);
	const [openMenu, setOpenMenu] = useState<MenuKey | null>(null);

	// Electron draws the min/max/close overlay natively and can't read our CSS, so
	// push theme-matched colours to it whenever the theme changes.
	useEffect(() => {
		if (!isWindows) return;
		const overlay =
			theme === "light" ? { color: "#ffffff", symbolColor: "#3f444c" } : { color: "#0f1014", symbolColor: "#c7ccd4" };
		void window.ao?.window?.setOverlay(overlay);
	}, [theme]);

	// Tell main to forget the last-focused panel whenever real shell UI (not this menu) gets focus, so its fallback target doesn't go stale.
	useEffect(() => {
		if (!isWindows) return;
		const onFocusIn = (event: FocusEvent) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest('[class*="window-titlebar"]')) return;
			void window.ao?.menu?.notifyShellFocus();
		};
		document.addEventListener("focusin", onFocusIn);
		return () => document.removeEventListener("focusin", onFocusIn);
	}, []);

	if (!isWindows) return null;

	return (
		<header className="window-titlebar">
			<img alt="" aria-hidden="true" className="window-titlebar__logo" draggable={false} src={aoLogo} />
			<span className="window-titlebar__title">Agent Orchestrator</span>
			<nav className="window-titlebar__menus">
				<TopMenu id="file" label={t("windowTitlebar.menu.file")} openMenu={openMenu} setOpenMenu={setOpenMenu}>
					<DropdownMenuItem onSelect={() => void navigate({ to: "/settings" })}>
						{t("windowTitlebar.items.settings")}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={act("app.quit")}>
						{t("windowTitlebar.items.quit")}
						<DropdownMenuShortcut>Alt+F4</DropdownMenuShortcut>
					</DropdownMenuItem>
				</TopMenu>

				<TopMenu id="edit" label={t("windowTitlebar.menu.edit")} openMenu={openMenu} setOpenMenu={setOpenMenu}>
					<DropdownMenuItem onSelect={act("edit.undo")}>
						{t("windowTitlebar.items.undo")}
						<DropdownMenuShortcut>Ctrl+Z</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("edit.redo")}>
						{t("windowTitlebar.items.redo")}
						<DropdownMenuShortcut>Ctrl+Y</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={act("edit.cut")}>
						{t("windowTitlebar.items.cut")}
						<DropdownMenuShortcut>Ctrl+X</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("edit.copy")}>
						{t("windowTitlebar.items.copy")}
						<DropdownMenuShortcut>Ctrl+C</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("edit.paste")}>
						{t("windowTitlebar.items.paste")}
						<DropdownMenuShortcut>Ctrl+V</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("edit.selectAll")}>
						{t("windowTitlebar.items.selectAll")}
						<DropdownMenuShortcut>Ctrl+A</DropdownMenuShortcut>
					</DropdownMenuItem>
				</TopMenu>

				<TopMenu id="view" label={t("windowTitlebar.menu.view")} openMenu={openMenu} setOpenMenu={setOpenMenu}>
					<DropdownMenuItem onSelect={act("view.reload")}>
						{t("windowTitlebar.items.reload")}
						<DropdownMenuShortcut>Ctrl+R</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("view.devtools")}>
						{t("windowTitlebar.items.toggleDevTools")}
						<DropdownMenuShortcut>Ctrl+Shift+I</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={act("view.zoomIn")}>{t("windowTitlebar.items.zoomIn")}</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("view.zoomOut")}>{t("windowTitlebar.items.zoomOut")}</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("view.zoomReset")}>{t("windowTitlebar.items.resetZoom")}</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={act("view.fullscreen")}>
						{t("windowTitlebar.items.toggleFullScreen")}
						<DropdownMenuShortcut>F11</DropdownMenuShortcut>
					</DropdownMenuItem>
				</TopMenu>

				<TopMenu id="window" label={t("windowTitlebar.menu.window")} openMenu={openMenu} setOpenMenu={setOpenMenu}>
					<DropdownMenuItem onSelect={act("window.minimize")}>{t("windowTitlebar.items.minimize")}</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("window.maximize")}>
						{t("windowTitlebar.items.maximizeRestore")}
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("window.close")}>{t("windowTitlebar.items.close")}</DropdownMenuItem>
				</TopMenu>

				<TopMenu id="help" label={t("windowTitlebar.menu.help")} openMenu={openMenu} setOpenMenu={setOpenMenu}>
					<DropdownMenuItem onSelect={act("help.about")}>{t("windowTitlebar.items.aboutAO")}</DropdownMenuItem>
				</TopMenu>
			</nav>
		</header>
	);
}
