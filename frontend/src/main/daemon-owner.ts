/**
 * Whether the user opted the app's own daemon out of the app-lifetime link via
 * the AO_KEEP_DAEMON env var. When set (truthy: any non-empty value other than
 * "0"/"false"), the app spawns the daemon but does NOT hold the supervisor link,
 * so the daemon survives the window closing and stops only on an explicit
 * `ao stop`. Default (unset) preserves the desktop behavior: the daemon
 * self-stops shortly after the app quits.
 */
export function keepDaemonAlive(env: { AO_KEEP_DAEMON?: string }): boolean {
	const raw = env.AO_KEEP_DAEMON?.trim().toLowerCase();
	return !!raw && raw !== "0" && raw !== "false";
}

/**
 * Whether the app should hold a supervisor link to a daemon it ATTACHED to
 * (did not spawn). Only re-link app-owned daemons (owner === "app"); leave
 * headless `ao start` daemons (owner unset or empty) unlinked so they stay
 * persistent across app quit.
 *
 * When the user set AO_KEEP_DAEMON, never re-link — even an app-owned daemon
 * stays persistent across app quit, so reopening the app does not re-arm the
 * app-lifetime link that would kill it on the next close.
 */
export function shouldLinkOnAttach(owner: string | undefined, env: { AO_KEEP_DAEMON?: string } = {}): boolean {
	if (keepDaemonAlive(env)) return false;
	return owner === "app";
}
