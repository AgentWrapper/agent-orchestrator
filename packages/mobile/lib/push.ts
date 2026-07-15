// Client push-notification plumbing: permission, Expo token acquisition, and
// registration/unregistration with the daemon. Delivery + routing of taps lives
// in PushManager.tsx; this module owns the "get a token and tell the daemon"
// half. See docs/adr/0001-mobile-push-notifications.md (D1, D4, D7, D9).
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Linking, Platform } from "react-native";
import { registerPushDevice, unregisterPushDevice } from "./api";
import type { ServerConfig } from "./config";

// The last Expo token we registered, kept so we can unregister it on disconnect
// even after the config that registered it is gone.
const LAST_TOKEN_KEY = "ao.pushToken";

// Suppress the OS banner while the app is foregrounded (D9) — the live in-app UI
// is the signal, so a tray banner would be a redundant double-signal. When the
// app is backgrounded/killed the OS shows the notification normally (this handler
// only runs for notifications received while the JS runtime is alive/foreground).
export function configurePushHandler(): void {
	Notifications.setNotificationHandler({
		handleNotification: async () => ({
			shouldShowBanner: false,
			shouldShowList: false,
			shouldPlaySound: false,
			shouldSetBadge: false,
		}),
	});
}

// One high-importance Android channel so `needs_input` actually buzzes (D5).
// No-op on iOS. Safe to call repeatedly.
export async function ensureAndroidChannel(): Promise<void> {
	if (Platform.OS !== "android") return;
	await Notifications.setNotificationChannelAsync("default", {
		name: "Default",
		importance: Notifications.AndroidImportance.HIGH,
		sound: "default",
	});
}

// The EAS projectId is required by getExpoPushTokenAsync. It is written into
// app.json (extra.eas.projectId) by `eas init`; fall back to the runtime
// easConfig for classic builds.
function easProjectId(): string | undefined {
	const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
	return extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

// Request permission (once), acquire the Expo push token, and register it with
// the daemon. Returns the token on success or null when unavailable (simulator,
// permission denied, or no EAS projectId). Idempotent: the daemon upserts by
// token, so this is also the foreground-refresh path (D7).
export async function registerForPush(cfg: ServerConfig): Promise<string | null> {
	// Remote push tokens are only issued on physical devices.
	if (!Device.isDevice) return null;

	const current = await Notifications.getPermissionsAsync();
	let status = current.status;
	if (status !== "granted" && current.canAskAgain) {
		status = (await Notifications.requestPermissionsAsync()).status;
	}
	if (status !== "granted") return null;

	await ensureAndroidChannel();

	const projectId = easProjectId();
	if (!projectId) {
		// Without a projectId Expo can't mint a token — this is an EAS setup gap,
		// not a runtime error. Warn and no-op so the app still works without push.
		console.warn("[push] no EAS projectId (run `eas init`); skipping push registration");
		return null;
	}

	// Acquiring the token can throw when the build lacks push support — most
	// commonly on iOS with no APNs `aps-environment` entitlement (a local dev
	// build not provisioned for push), or on a simulator. Treat that as "push
	// unavailable on this build" and no-op rather than crashing the app.
	try {
		const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
		await registerPushDevice(cfg, {
			token,
			platform: Platform.OS,
			deviceName: Device.deviceName ?? undefined,
		});
		await AsyncStorage.setItem(LAST_TOKEN_KEY, token);
		return token;
	} catch (e) {
		console.warn("[push] could not obtain/register an Expo push token (build not provisioned for push?)", e);
		return null;
	}
}

// Current push state, for the Settings Notifications section.
export type PushStatus = {
	supported: boolean; // remote push only works on a physical device
	granted: boolean; // OS notification permission granted
	canAskAgain: boolean; // false once the user permanently denied (must use system settings)
	registered: boolean; // we hold a token registered with a daemon
};

// Reads the live permission + registration state without prompting.
export async function getPushStatus(): Promise<PushStatus> {
	const perm = await Notifications.getPermissionsAsync();
	const token = await AsyncStorage.getItem(LAST_TOKEN_KEY);
	return {
		supported: Device.isDevice,
		granted: perm.status === "granted",
		canAskAgain: perm.canAskAgain ?? true,
		registered: !!token,
	};
}

// Opens this app's OS settings page so the user can flip notifications back on
// after a permanent denial (the OS won't let us re-prompt in that case).
export async function openNotificationSettings(): Promise<void> {
	try {
		await Linking.openSettings();
	} catch {
		/* best-effort */
	}
}

// Best-effort unregister of the last-registered token from the given daemon
// (D7, disconnect/unpair or switching daemons). Never throws — the caller must
// not be blocked by a failed unregister.
export async function unregisterFromPush(cfg: ServerConfig): Promise<void> {
	try {
		const token = await AsyncStorage.getItem(LAST_TOKEN_KEY);
		if (token) await unregisterPushDevice(cfg, token);
	} catch {
		/* best-effort: the daemon prunes dead tokens on send anyway */
	}
}
