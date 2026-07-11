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
 * (did not spawn). The decision is read from the daemon's durable owner record
 * in running.json — NOT the current Electron process env, which can differ
 * across launches (a cross-launch regression: a daemon spawned keep-alive must
 * stay unlinked even when the app is later reopened without AO_KEEP_DAEMON).
 * Only a normal app-owned daemon ("app") is linked; a keep-alive daemon
 * ("persistent") and headless `ao start` daemons (owner unset/empty) stay
 * persistent across app quit.
 */
export function shouldLinkOnAttach(owner: string | undefined): boolean {
	return owner === "app";
}
