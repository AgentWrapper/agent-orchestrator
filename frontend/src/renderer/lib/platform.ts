type NavigatorWithUserAgentData = Navigator & { userAgentData?: { platform?: string } };

function navigatorPlatform(): string {
	if (typeof navigator === "undefined") return "";
	return (navigator as NavigatorWithUserAgentData).userAgentData?.platform ?? navigator.platform ?? "";
}

function navigatorUserAgent(): string {
	if (typeof navigator === "undefined") return "";
	return navigator.userAgent ?? "";
}

export function isMacPlatform(): boolean {
	return /Mac|iPod|iPhone|iPad/.test(navigatorUserAgent()) || /mac/i.test(navigatorPlatform());
}

export function isWindowsPlatform(): boolean {
	return /win/i.test(navigatorPlatform());
}

export function isLinuxPlatform(): boolean {
	return navigatorPlatform().toLowerCase().includes("linux");
}

export function usesFramedAppTopbar(): boolean {
	// Keep this behind a helper even while every desktop platform uses the
	// framed shell: it leaves the legacy full-width topbar path explicit while
	// the cross-platform chrome settles, and keeps platform-specific tests at
	// the behavior boundary instead of scattered through route/components code.
	return true;
}

/**
 * macOS only: shell does not mount ShellTopbar (full-height inset panel).
 * The sidebar toggle + history arrows live in the fixed TitlebarNav cluster and
 * board/session actions mount in-panel, with a traffic-light drag strip for
 * window movement. Win/Linux keep the ShellTopbar spanning the window, with the
 * sidebar hanging below it — two different ways of creating the top gap.
 */
export function hidesShellTopbar(): boolean {
	return isMacPlatform();
}

/**
 * Board New task / Orchestrator / bell render in the board body instead of the
 * framed shell topbar (macOS only). Win/Linux keep those controls in the topbar.
 */
export function usesBoardActionsInPanel(): boolean {
	return hidesShellTopbar();
}
