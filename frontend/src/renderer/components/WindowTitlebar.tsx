import { useNavigate } from "@tanstack/react-router";
import { PanelLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useResolvedTheme, useUiStore } from "../stores/ui-store";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

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
	const navigate = useNavigate();
	const theme = useResolvedTheme();
	const { isSidebarOpen, toggleSidebar } = useUiStore();
	const [openMenu, setOpenMenu] = useState<MenuKey | null>(null);

	// Electron draws the min/max/close overlay natively and can't read our CSS, so
	// push theme-matched colours to it whenever the theme changes.
	useEffect(() => {
		if (!isWindows) return;
		// Keep in sync with --color-bg-sidebar (tokens.css) — the titlebar paints
		// that colour, so the native buttons must match it.
		const overlay =
			theme === "light" ? { color: "#fcfcfc", symbolColor: "#3f444c" } : { color: "#17181c", symbolColor: "#c7ccd4" };
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
			{/* Sidebar collapse toggle — same ui-store path as the macOS TitlebarNav
			    cluster, so it stays in sync with the SidebarProvider. The brand
			    logo + name stay in the sidebar header instead of duplicating here. */}
			<button
				aria-label={isSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
				className="window-titlebar__toggle"
				onClick={toggleSidebar}
				title={`${isSidebarOpen ? "Collapse" : "Expand"} sidebar · Ctrl+B`}
				type="button"
			>
				<PanelLeft aria-hidden="true" className="window-titlebar__toggle-icon" />
			</button>
			<nav className="window-titlebar__menus">
				<TopMenu id="file" label="File" openMenu={openMenu} setOpenMenu={setOpenMenu}>
					<DropdownMenuItem onSelect={() => void navigate({ to: "/settings" })}>Settings</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={act("app.quit")}>
						Quit
						<DropdownMenuShortcut>Alt+F4</DropdownMenuShortcut>
					</DropdownMenuItem>
				</TopMenu>

				<TopMenu id="edit" label="Edit" openMenu={openMenu} setOpenMenu={setOpenMenu}>
					<DropdownMenuItem onSelect={act("edit.undo")}>
						Undo
						<DropdownMenuShortcut>Ctrl+Z</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("edit.redo")}>
						Redo
						<DropdownMenuShortcut>Ctrl+Y</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={act("edit.cut")}>
						Cut
						<DropdownMenuShortcut>Ctrl+X</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("edit.copy")}>
						Copy
						<DropdownMenuShortcut>Ctrl+C</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("edit.paste")}>
						Paste
						<DropdownMenuShortcut>Ctrl+V</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("edit.selectAll")}>
						Select All
						<DropdownMenuShortcut>Ctrl+A</DropdownMenuShortcut>
					</DropdownMenuItem>
				</TopMenu>

				<TopMenu id="view" label="View" openMenu={openMenu} setOpenMenu={setOpenMenu}>
					<DropdownMenuItem onSelect={act("view.reload")}>
						Reload
						<DropdownMenuShortcut>Ctrl+R</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("view.devtools")}>
						Toggle DevTools
						<DropdownMenuShortcut>Ctrl+Shift+I</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={act("view.zoomIn")}>Zoom In</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("view.zoomOut")}>Zoom Out</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("view.zoomReset")}>Reset Zoom</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={act("view.fullscreen")}>
						Toggle Full Screen
						<DropdownMenuShortcut>F11</DropdownMenuShortcut>
					</DropdownMenuItem>
				</TopMenu>

				<TopMenu id="window" label="Window" openMenu={openMenu} setOpenMenu={setOpenMenu}>
					<DropdownMenuItem onSelect={act("window.minimize")}>Minimize</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("window.maximize")}>Maximize / Restore</DropdownMenuItem>
					<DropdownMenuItem onSelect={act("window.close")}>Close</DropdownMenuItem>
				</TopMenu>

				<TopMenu id="help" label="Help" openMenu={openMenu} setOpenMenu={setOpenMenu}>
					<DropdownMenuItem onSelect={act("help.shortcuts")}>
						Keyboard shortcuts
						<DropdownMenuShortcut>Ctrl+/</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={act("help.about")}>About Agent Orchestrator</DropdownMenuItem>
				</TopMenu>
			</nav>
		</header>
	);
}
