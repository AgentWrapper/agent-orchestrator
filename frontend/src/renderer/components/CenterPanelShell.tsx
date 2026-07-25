import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { useWindowFullScreen } from "../hooks/useWindowFullScreen";
import { isMacPlatform } from "../lib/platform";
import { useUiStore } from "../stores/ui-store";

const isMac = isMacPlatform();

/**
 * Shared inset center panel: sidebar-colored outer frame with a bordered inner
 * surface. Used by the shell's app routes (kanban / session), the welcome board,
 * and settings. Chrome lives in `styles.css` (`center-panel-shell` +
 * `center-panel-surface`).
 *
 * `titlebarAlign` (default true) pulls Board/Terminal titles into the macOS
 * traffic-light band.
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
	const align = titlebarAlign && isMac;
	const titlebarClearance = align && !isSidebarOpen;

	return (
		<div
			className={cn(
				"center-panel-shell",
				align && "center-panel-shell--mac",
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
