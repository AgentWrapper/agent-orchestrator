// Shared cloud sign-in state. Clerk's `isSignedIn` lives inside CloudAuthBridge
// (a React component); the rest of the renderer — notably the non-React
// cloud-session registry (cloud-sessions.ts) — needs to read it to gate
// control-plane calls. This tiny module store bridges that: CloudAuthBridge is
// the sole writer; anyone can read `isCloudSignedIn()` or subscribe.
//
// Semantics: `true` only once Clerk has resolved a signed-in session. It starts
// `false` (Clerk loading / signed out / not configured), so cloud calls stay
// gated off until a real session exists.

let signedIn = false;
const listeners = new Set<() => void>();

/** Whether a Clerk cloud session is active. */
export function isCloudSignedIn(): boolean {
	return signedIn;
}

/** Set by CloudAuthBridge when Clerk's `isSignedIn` changes. Notifies subscribers
 *  only on an actual transition. */
export function setCloudSignedIn(next: boolean): void {
	if (next === signedIn) return;
	signedIn = next;
	listeners.forEach((l) => l());
}

/** Subscribe to sign-in transitions (useSyncExternalStore-compatible). */
export function subscribeCloudAuth(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}
