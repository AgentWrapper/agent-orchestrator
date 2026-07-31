import AsyncStorage from "@react-native-async-storage/async-storage";
import { ONBOARDING_SKIPPED_KEY } from "./onboarding";

// Storage side of the onboarding gate. Split from `onboarding.ts` so the
// decision logic there stays free of React Native imports and unit-testable —
// the same split as `pushStatus.ts` / `push.ts`.
//
// The flag is not a secret, so AsyncStorage (plaintext app sandbox) is right;
// it must not go to SecureStore, which is reserved for the connection password.

/** Whether the user has dismissed onboarding. Never throws — storage failure reads as "not skipped". */
export async function loadOnboardingSkipped(): Promise<boolean> {
	try {
		return (await AsyncStorage.getItem(ONBOARDING_SKIPPED_KEY)) === "1";
	} catch {
		return false;
	}
}

export async function setOnboardingSkipped(): Promise<void> {
	try {
		await AsyncStorage.setItem(ONBOARDING_SKIPPED_KEY, "1");
	} catch {
		/* a lost flag only means onboarding shows again next launch */
	}
}

/**
 * Cleared on a successful pair. Without this, a user who skipped, then paired,
 * then later cleared their server config would never be offered onboarding
 * again — they'd land on the bare Agents empty state, which is the exact
 * dead end onboarding exists to remove.
 */
export async function clearOnboardingSkipped(): Promise<void> {
	try {
		await AsyncStorage.removeItem(ONBOARDING_SKIPPED_KEY);
	} catch {
		/* ignore */
	}
}
