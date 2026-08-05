// Pure decision logic for first-run onboarding. Deliberately free of React
// Native / Expo imports so it can be unit-tested directly (mirroring
// `pushStatus.ts`); the AsyncStorage side lives in `onboardingStore.ts`.

/** Persisted flag: the user dismissed onboarding without pairing. */
export const ONBOARDING_SKIPPED_KEY = "ao.onboardingSkipped";

export type OnboardingInput = {
	// Whether a server is configured. `null` means "not loaded yet".
	configured: boolean | null;
	// Whether the user has dismissed onboarding. `null` means "not loaded yet".
	skipped: boolean | null;
};

/**
 * Should the app take the user to onboarding?
 *
 * Both inputs are read asynchronously (config from AsyncStorage + SecureStore,
 * the flag from AsyncStorage), so either can still be `null` on the first
 * render. Redirecting on incomplete state would yank a paired user onto the
 * welcome screen for a frame on every cold start, so unknown means "do nothing
 * yet" rather than "assume false".
 */
export function shouldOnboard({ configured, skipped }: OnboardingInput): boolean {
	if (configured === null || skipped === null) return false;
	return !configured && !skipped;
}
