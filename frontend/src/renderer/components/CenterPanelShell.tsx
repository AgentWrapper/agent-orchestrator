import type { ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "../lib/utils";
import { useWindowFullScreen } from "../hooks/useWindowFullScreen";
import { isLinuxPlatform, isMacPlatform } from "../lib/platform";
import { useUiStore } from "../stores/ui-store";

// Mirrors CSS token math so Motion can animate between exact pixel values.
// Any token change here must also update styles/tokens.css.
const CONTROL_MD = 28;
const TITLEBAR_CLUSTER_WIDTH = 3 * CONTROL_MD + 2 * 4; // 92
const TITLEBAR_CONTENT_GAP = 12;
const CENTER_PANEL_INSET_MAC = 6;
const CENTER_PANEL_INSET = 24;
const SPACE_TOPBAR_X = 10; // --space-topbar-x

const TITLEBAR_PL_MAC =
	79 + TITLEBAR_CLUSTER_WIDTH + TITLEBAR_CONTENT_GAP - CENTER_PANEL_INSET_MAC; // 177
const TITLEBAR_PL_LINUX =
	6 + TITLEBAR_CLUSTER_WIDTH + TITLEBAR_CONTENT_GAP - CENTER_PANEL_INSET_MAC; // 104
const TITLEBAR_PL_FULLSCREEN =
	CENTER_PANEL_INSET + TITLEBAR_CLUSTER_WIDTH + TITLEBAR_CONTENT_GAP; // 128

const isMac = isMacPlatform();
const isLinux = isLinuxPlatform();

/**
 * Shared inset center panel: sidebar-colored outer frame with a bordered inner
 * surface. Used by the shell's app routes (kanban / session), the welcome board,
 * and settings. Chrome lives in `styles.css` (`center-panel-shell` +
 * `center-panel-surface`).
 *
 * `titlebarAlign` (default true) pulls Board/Terminal titles up level with the
 * fixed TitlebarNav cluster (macOS + Linux).
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
	const align = titlebarAlign && (isMac || isLinux);
	const titlebarClearance = align && !isSidebarOpen;

	// Compute target padding-left for the topbar in px so Motion can tween it.
	let titlebarPL: number = SPACE_TOPBAR_X;
	if (titlebarClearance) {
		if (isFullScreen) {
			titlebarPL = TITLEBAR_PL_FULLSCREEN;
		} else if (isLinux) {
			titlebarPL = TITLEBAR_PL_LINUX;
		} else {
			titlebarPL = TITLEBAR_PL_MAC;
		}
	}

	const spring = { type: "spring", stiffness: 280, damping: 32, mass: 0.8 } as const;

	return (
		<motion.div
			className={cn(
				"center-panel-shell",
				align && "center-panel-shell--mac",
				isLinux && "center-panel-shell--linux",
				align && isFullScreen && "center-panel-shell--fullscreen",
				className,
			)}
			// Animate the CSS variable; .center-panel-titlebar reads it for padding-left.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			animate={{ "--cp-titlebar-pl": `${titlebarPL}px` } as any}
			initial={false}
			transition={spring}
		>
			<div className="center-panel-surface">{children}</div>
		</motion.div>
	);
}
