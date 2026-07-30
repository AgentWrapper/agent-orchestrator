import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { useWindowFullScreen } from "../hooks/useWindowFullScreen";
import { isLinuxPlatform } from "../lib/platform";
import { useUiStore } from "../stores/ui-store";

const isLinux = isLinuxPlatform();

/**
 * Shared inset center panel: sidebar-colored outer frame with a bordered inner
 * surface. Used by the shell's app routes (kanban / session), the welcome board,
 * and settings. Chrome lives in `styles.css` (`center-panel-shell` +
 * `center-panel-surface`).
 *
 * `titlebarAlign` (default true) pulls Board/Terminal titles up level with the
 * fixed TitlebarNav cluster (Linux only — macOS mounts the full-width shell
 * topbar above this panel, so the panel keeps its default insets there).
 */
export function CenterPanelShell({
	className,
	children,
	titlebarAlign = true,
}: {
	/** Extra classes on the outer frame. */
	className?: string;
	children: ReactNode;
	/** When false, keep the default panel insets (Settings). */
	titlebarAlign?: boolean;
}) {
	const isSidebarOpen = useUiStore((state) => state.isSidebarOpen);
	const isFullScreen = useWindowFullScreen();
	const align = titlebarAlign && isLinux;
	const titlebarClearance = align && !isSidebarOpen;

	return (
		<div
			className={cn(
				"center-panel-shell",
				align && "center-panel-shell--mac",
				// Linux has no traffic lights, so the sidebar-closed title clears the
				// cluster at its own left edge rather than the macOS offset.
				isLinux && "center-panel-shell--linux",
				titlebarClearance && "center-panel-shell--titlebar-clearance",
				titlebarClearance && isFullScreen && "center-panel-shell--titlebar-clearance-fullscreen",
				align && isFullScreen && "center-panel-shell--fullscreen",
				className,
			)}
		>
			<div className="center-panel-surface">{children}</div>
		</div>
	);
}
