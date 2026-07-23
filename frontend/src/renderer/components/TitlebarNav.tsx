import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, PanelLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { isMacPlatform } from "../lib/platform";
import { useUiStore } from "../stores/ui-store";

const isMac = isMacPlatform();
const noDragStyle = isMac ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

// macOS-only sidebar chrome cluster (sidebar toggle + history arrows). Lives
// in the Sidebar header below the traffic lights while windowed; in native
// fullscreen the clearance pad drops so this cluster sits near the top edge.
// The toggle is pinned in the icon-rail column so it never moves during
// expand/collapse; history arrows sit absolutely to its right and only fade
// in when expanded.
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

export function TitlebarNav({ historyLocked = false }: { historyLocked?: boolean }) {
	const { isSidebarOpen, toggleSidebar } = useUiStore();
	const router = useRouter();
	const canGoBack = useCanGoBack();
	const canGoForward = useCanGoForward();

	if (!isMac) return null;

	const historyInactive = !isSidebarOpen;

	return (
		<div className="titlebar-nav" style={noDragStyle}>
			{/* Fixed-width slot matches --size-sidebar-icon so the toggle stays
			    put while the sidebar width animates. */}
			<div className="titlebar-nav__toggle-slot">
				<TitlebarButton
					label={isSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
					onClick={toggleSidebar}
					title={`${isSidebarOpen ? "Collapse" : "Expand"} sidebar · ⌘B`}
				>
					<PanelLeft className="size-icon-lg" aria-hidden="true" />
				</TitlebarButton>
			</div>
			{/* Absolute: never takes layout space, so showing/hiding arrows
			    cannot shift the toggle. Fades with expanded chrome. */}
			<div className="titlebar-nav__history sidebar-expanded-chrome" aria-hidden={historyInactive}>
				<TitlebarButton
					disabled={historyInactive || historyLocked || !canGoBack}
					label="Go back"
					onClick={() => router.history.back()}
					tabIndex={historyInactive ? -1 : undefined}
					title="Go back"
				>
					<ArrowLeft className="size-icon-lg" aria-hidden="true" />
				</TitlebarButton>
				<TitlebarButton
					disabled={historyInactive || historyLocked || !canGoForward}
					label="Go forward"
					onClick={() => router.history.forward()}
					tabIndex={historyInactive ? -1 : undefined}
					title="Go forward"
				>
					<ArrowRight className="size-icon-lg" aria-hidden="true" />
				</TitlebarButton>
			</div>
		</div>
	);
}

function TitlebarButton({
	label,
	title,
	disabled,
	tabIndex,
	onClick,
	children,
}: {
	label: string;
	title: string;
	disabled?: boolean;
	tabIndex?: number;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			aria-label={label}
			aria-disabled={disabled || undefined}
			className="grid size-control-md place-items-center rounded-md text-passive transition-colors hover:bg-interactive-hover hover:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-passive"
			disabled={disabled}
			onClick={onClick}
			tabIndex={tabIndex}
			title={title}
			type="button"
		>
			{children}
		</button>
	);
}
