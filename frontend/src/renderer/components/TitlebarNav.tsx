import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, PanelLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { isMacPlatform } from "../lib/platform";
import { useUiStore } from "../stores/ui-store";

const isMac = isMacPlatform();
const noDragStyle = isMac ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

// macOS-only sidebar chrome cluster (sidebar toggle + history arrows). It stays
// fixed while the sidebar expands, collapses, or appears as a hover preview.
// The installed router has no useCanGoForward, and deriving one as
// `__TSR_index < history.length - 1` (the upstream hook's approach) is wrong
// here: window.history.length also counts entries the router never created —
// the WebContents' initial blank entry, pre-router loads — so the tip of the
// stack still reads as "forward available" and the arrow no-ops. Instead,
// track the highest router index reachable on the live stack: a PUSH discards
// the forward entries (the new index is the tip); BACK/FORWARD/GO only move
// within it. After a mid-stack reload the tip resets to the current entry —
// forward greys out rather than dangle on entries we can no longer see.
function useCanGoForward(): boolean {
	const router = useRouter();
	const [canGoForward, setCanGoForward] = useState(false);
	useEffect(() => {
		let tip = router.history.location.state.__TSR_index;
		return router.history.subscribe(({ location, action }) => {
			const index = location.state.__TSR_index;
			tip = action.type === "PUSH" ? index : Math.max(tip, index);
			setCanGoForward(index < tip);
		});
	}, [router]);
	return canGoForward;
}

export function TitlebarNav({
	historyLocked = false,
	isFullScreen = false,
	onSidebarPreviewEnter,
}: {
	historyLocked?: boolean;
	isFullScreen?: boolean;
	onSidebarPreviewEnter?: React.PointerEventHandler<HTMLButtonElement>;
}) {
	const { isSidebarOpen, toggleSidebar } = useUiStore();
	const router = useRouter();
	const canGoBack = useCanGoBack();
	const canGoForward = useCanGoForward();

	if (!isMac) return null;

	// Stay pinned beside the traffic lights. Nudge down slightly so the
	// toggle/arrows share a centerline with the native dots (y: 12).
	const leftClass = isFullScreen ? "left-titlebar-cluster-left-fullscreen" : "left-titlebar-cluster-left";
	const topClass = isFullScreen ? "top-0" : "top-0.5";

	return (
		<div
			className={`fixed ${topClass} ${leftClass} z-titlebar flex h-traffic-light-clearance items-center gap-1`}
			style={noDragStyle}
		>
			<TitlebarButton
				label={isSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
				onClick={toggleSidebar}
				onPointerEnter={onSidebarPreviewEnter}
				title={`${isSidebarOpen ? "Collapse" : "Expand"} sidebar · ⌘B`}
			>
				<PanelLeft className="size-icon-lg" aria-hidden="true" />
			</TitlebarButton>
			<TitlebarButton
				disabled={historyLocked || !canGoBack}
				label="Go back"
				onClick={() => router.history.back()}
				title="Go back"
			>
				<ArrowLeft className="size-icon-lg" aria-hidden="true" />
			</TitlebarButton>
			<TitlebarButton
				disabled={historyLocked || !canGoForward}
				label="Go forward"
				onClick={() => router.history.forward()}
				title="Go forward"
			>
				<ArrowRight className="size-icon-lg" aria-hidden="true" />
			</TitlebarButton>
		</div>
	);
}

function TitlebarButton({
	label,
	title,
	disabled,
	tabIndex,
	onClick,
	onPointerEnter,
	children,
}: {
	label: string;
	title: string;
	disabled?: boolean;
	tabIndex?: number;
	onClick: () => void;
	onPointerEnter?: React.PointerEventHandler<HTMLButtonElement>;
	children: React.ReactNode;
}) {
	return (
		<button
			aria-label={label}
			aria-disabled={disabled || undefined}
			className="grid size-control-md place-items-center rounded-md text-passive transition-colors hover:bg-interactive-hover hover:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-passive"
			disabled={disabled}
			onClick={onClick}
			onPointerEnter={onPointerEnter}
			style={noDragStyle}
			tabIndex={tabIndex}
			title={title}
			type="button"
		>
			{children}
		</button>
	);
}
