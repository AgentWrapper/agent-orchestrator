/** One tab in the session pane strip: pinned session tabs, then shell tabs. */
export type TerminalStripTab =
	| { kind: "session"; sessionId: string }
	| { kind: "shell"; handleId: string };

export function buildTerminalStripTabs(sessionIds: string[], shellHandleIds: string[]): TerminalStripTab[] {
	return [
		...sessionIds.map((sessionId) => ({ kind: "session" as const, sessionId })),
		...shellHandleIds.map((handleId) => ({ kind: "shell" as const, handleId })),
	];
}

function stripTabKey(tab: TerminalStripTab): string {
	return tab.kind === "session" ? `session:${tab.sessionId}` : `shell:${tab.handleId}`;
}

/** Tab immediately to the left of `closed` in the strip, if any. */
export function previousTerminalStripTab(
	tabs: TerminalStripTab[],
	closed: TerminalStripTab,
): TerminalStripTab | undefined {
	const closedKey = stripTabKey(closed);
	const index = tabs.findIndex((tab) => stripTabKey(tab) === closedKey);
	if (index <= 0) return undefined;
	return tabs[index - 1];
}

/** Tab immediately to the left of the shell at `handleId`, if any. */
export function previousShellStripTab(shellHandleIds: string[], handleId: string): string | undefined {
	const index = shellHandleIds.indexOf(handleId);
	if (index <= 0) return undefined;
	return shellHandleIds[index - 1];
}

/**
 * Neighbor to activate after closing `handleId`: prefer the tab to the left,
 * otherwise the tab to the right (so closing the first tab does not blank the pane).
 */
export function adjacentShellStripTab(shellHandleIds: string[], handleId: string): string | undefined {
	const index = shellHandleIds.indexOf(handleId);
	if (index < 0) return undefined;
	if (index > 0) return shellHandleIds[index - 1];
	return shellHandleIds[index + 1];
}
