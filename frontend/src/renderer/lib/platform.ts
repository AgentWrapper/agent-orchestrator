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
	// Win/Linux mount ShellTopbar inside the framed center panel. macOS mounts
	// it full-width above the sidebar instead (traffic lights sit inside the
	// bar and the whole strip is the window-drag region), matching the
	// agent-orchestrator reference layout.
	return !isMacPlatform();
}

/**
 * Linux: shell does not mount ShellTopbar (full-height inset panel). The
 * sidebar toggle + history arrows live in the fixed TitlebarNav cluster and
 * board/session actions mount in-panel. macOS uses the full-width shell
 * topbar (see usesFramedAppTopbar); Windows keeps the ShellTopbar under its
 * custom titlebar.
 */
export function hidesShellTopbar(): boolean {
	return isLinuxPlatform();
}

/**
 * Board New task / Orchestrator / bell render in the board body instead of the
 * shell topbar (Linux). macOS/Windows keep those controls in the topbar.
 */
export function usesBoardActionsInPanel(): boolean {
	return hidesShellTopbar();
}
