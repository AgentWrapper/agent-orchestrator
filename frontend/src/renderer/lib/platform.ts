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
 * macOS: shell does not mount ShellTopbar (full-height inset panel + drag
 * strip). SessionView mounts the same topbar in-panel for session actions.
 */
export function hidesShellTopbar(): boolean {
	return isMacPlatform();
}

/**
 * Board New task / Orchestrator / bell render in the board body instead of the
 * framed shell topbar (macOS). Win/Linux keep those controls in the topbar.
 */
export function usesBoardActionsInPanel(): boolean {
	return hidesShellTopbar();
}
