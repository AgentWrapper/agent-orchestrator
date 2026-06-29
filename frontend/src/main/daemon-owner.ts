/**
 * Whether the app should hold a supervisor link to a daemon it ATTACHED to
 * (did not spawn). Only re-link app-owned daemons (owner === "app"); leave
 * headless `ao start` daemons (owner unset or empty) unlinked so they stay
 * persistent across app quit.
 */
export function shouldLinkOnAttach(owner: string | undefined): boolean {
	return owner === "app";
}
