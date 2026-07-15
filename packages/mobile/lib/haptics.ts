import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

// Thin, best-effort wrapper over expo-haptics. Every call is fire-and-forget: a
// device without a haptic engine (or the web target, where expo-haptics is a
// no-op) must never throw into a press handler. The named API mirrors intent —
// callers ask for `tap`/`select`/`success`, not raw enum members — so the choice
// of impact vs. selection vs. notification lives in exactly one place.

const isWeb = Platform.OS === "web";

function run(fire: () => Promise<void>): void {
	if (isWeb) return;
	// Swallow rejections — haptics are a nicety, never a failure path.
	fire().catch(() => {});
}

export const haptics = {
	// Generic light press — buttons, cards, pull-to-refresh.
	tap() {
		run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
	},
	// A selection change — tabs, filter pills, list-item selection.
	select() {
		run(() => Haptics.selectionAsync());
	},
	// An action succeeded — spawn started, session killed, connection made.
	success() {
		run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
	},
	// A cautionary moment — a destructive confirmation is being raised.
	warning() {
		run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
	},
	// An action failed.
	error() {
		run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
	},
};
