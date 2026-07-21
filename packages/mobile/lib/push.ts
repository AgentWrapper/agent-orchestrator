// Client push-notification plumbing: permission, Expo token acquisition, and
// registration/unregistration with the daemon. Delivery + routing of taps lives
// in PushManager.tsx; this module owns the "get a token and tell the daemon"
// half. See docs/adr/0001-mobile-push-notifications.md (D1, D4, D7, D9).
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Linking, Platform } from "react-native";
import { registerPushDevice, unregisterPushDevice } from "./api";
import type { ServerConfig } from "./config";

// The last successful registration: the Expo token AND the daemon it was
// registered with (host/port/TLS/password). Persisting the daemon — not just the
// token — is what lets us unregister from the *right* daemon after an app restart
// or a config change, so an old daemon can't keep pushing to this device (D7).
// It lives in SecureStore because it contains the connection password.
const REGISTRATION_KEY = "ao.pushRegistration";
// Registrations we still owe an unregister to (the daemon was unreachable when we
// tried). Retried on the next register/foreground so a failed unregister is never
// silently lost — otherwise an old daemon could keep pushing to this device.
const PENDING_UNREG_KEY = "ao.pushPendingUnregister";
// Bound the pending list so a permanently-dead daemon can't grow it forever.
const MAX_PENDING_UNREG = 10;

type Registration = {
	token: string;
	host: string;
	httpPort: string;
	secure: boolean;
	password: string;
};

async function loadRegistration(): Promise<Registration | null> {
	try {
		const raw = await SecureStore.getItemAsync(REGISTRATION_KEY);
		return raw ? (JSON.parse(raw) as Registration) : null;
	} catch {
		return null;
	}
}

async function saveRegistration(reg: Registration): Promise<void> {
	await SecureStore.setItemAsync(REGISTRATION_KEY, JSON.stringify(reg));
}

async function clearRegistration(): Promise<void> {
	await SecureStore.deleteItemAsync(REGISTRATION_KEY);
}

async function loadPendingUnregisters(): Promise<Registration[]> {
	try {
		const raw = await SecureStore.getItemAsync(PENDING_UNREG_KEY);
		return raw ? (JSON.parse(raw) as Registration[]) : [];
	} catch {
		return [];
	}
}

async function savePendingUnregisters(list: Registration[]): Promise<void> {
	if (list.length === 0) {
		await SecureStore.deleteItemAsync(PENDING_UNREG_KEY);
		return;
	}
	await SecureStore.setItemAsync(PENDING_UNREG_KEY, JSON.stringify(list.slice(-MAX_PENDING_UNREG)));
}

// Queue a registration for a later unregister retry (deduped by token+host).
async function queuePendingUnregister(reg: Registration): Promise<void> {
	const list = await loadPendingUnregisters();
	if (list.some((r) => r.token === reg.token && sameDaemon(r, configOf(reg)))) return;
	list.push(reg);
	await savePendingUnregisters(list);
}

// Retry every queued unregister; keep the ones that still fail. Best-effort.
async function flushPendingUnregisters(): Promise<void> {
	const list = await loadPendingUnregisters();
	if (list.length === 0) return;
	const stillPending: Registration[] = [];
	for (const reg of list) {
		try {
			await unregisterPushDevice(configOf(reg), reg.token);
		} catch {
			stillPending.push(reg);
		}
	}
	await savePendingUnregisters(stillPending);
}

// Rebuild a minimal ServerConfig for talking to the daemon a registration names.
// muxPort is unused by the REST calls (register/unregister) so it's left empty.
function configOf(reg: Registration): ServerConfig {
	return { host: reg.host, httpPort: reg.httpPort, muxPort: "", secure: reg.secure, password: reg.password };
}

// Same daemon? Keyed on the fields that address it — host/port/TLS. (The password
// can change without it being a different daemon, so it's not part of identity.)
function sameDaemon(reg: Registration, cfg: ServerConfig): boolean {
	return reg.host === cfg.host && reg.httpPort === cfg.httpPort && !!reg.secure === !!cfg.secure;
}

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

	// Ensure the Android channel exists BEFORE the permission prompt and before
	// any notification could arrive, so a notification is never mis-filed onto an
	// implicit default channel.
	await ensureAndroidChannel();

	const current = await Notifications.getPermissionsAsync();
	let status = current.status;
	if (status !== "granted" && current.canAskAgain) {
		status = (await Notifications.requestPermissionsAsync()).status;
	}
	if (status !== "granted") return null;

	const projectId = easProjectId();
	if (!projectId) {
		// Without a projectId Expo can't mint a token — this is an EAS setup gap,
		// not a runtime error. Warn and no-op so the app still works without push.
		console.warn("[push] no EAS projectId (run `eas init`); skipping push registration");
		return null;
	}

	// Retry any unregisters we still owe from a previous failure.
	await flushPendingUnregisters();

	// If we're now pointed at a different daemon than we last registered with,
	// unregister the token from the OLD daemon first so it stops pushing to this
	// device. This survives app restarts because the old daemon's address +
	// credentials are persisted. If that unregister fails (daemon unreachable),
	// queue it for retry rather than dropping it.
	const prior = await loadRegistration();
	if (prior && !sameDaemon(prior, cfg)) {
		try {
			await unregisterPushDevice(configOf(prior), prior.token);
		} catch {
			await queuePendingUnregister(prior);
		}
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
		await saveRegistration({
			token,
			host: cfg.host,
			httpPort: cfg.httpPort,
			secure: !!cfg.secure,
			password: cfg.password,
		});
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
	const reg = await loadRegistration();
	return {
		supported: Device.isDevice,
		granted: perm.status === "granted",
		canAskAgain: perm.canAskAgain ?? true,
		registered: !!reg,
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

// Best-effort unregister of the last-registered token from the daemon it was
// registered with (D7, disconnect/unpair). Uses the persisted daemon address +
// credentials, so it reaches the correct daemon even after a restart. If the
// unregister fails (daemon unreachable), the target is queued for retry instead
// of being dropped — so the old daemon can't keep pushing to this device. Never
// throws — the caller must not be blocked.
export async function unregisterFromPush(): Promise<void> {
	const reg = await loadRegistration();
	// Clear the active registration up front: the device is disconnecting, so it
	// is no longer "currently registered" regardless of whether the network call
	// below succeeds. The retry is tracked separately in the pending queue.
	await clearRegistration();
	if (!reg) return;
	try {
		await unregisterPushDevice(configOf(reg), reg.token);
	} catch {
		await queuePendingUnregister(reg);
	}
	await flushPendingUnregisters();
}
