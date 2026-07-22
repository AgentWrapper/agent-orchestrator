// Headless component mounted once under the root layout. It owns the runtime
// side of push notifications: register after pairing (+ refresh on foreground),
// unregister when switching/leaving a daemon, and route notification taps
// (warm + cold start). See docs/adr/0001-mobile-push-notifications.md (D6, D7, D9).
import * as Notifications from "expo-notifications";
import { useRootNavigationState, useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { markNotificationRead } from "./api";
import { configurePushHandler, ensureAndroidChannel, registerForPush, unregisterFromPush } from "./push";
import { useApp } from "./store";

// Set the foreground presentation policy before any notification can arrive.
configurePushHandler();

type PushData = {
	type?: string;
	sessionId?: string;
	projectId?: string;
	prUrl?: string;
	notificationId?: string;
};

export function PushManager(): null {
	const { config, configured, connection } = useApp();
	const router = useRouter();
	const navState = useRootNavigationState();

	const handledColdStart = useRef(false);
	const wasConfigured = useRef(false);

	// Create the Android channel once at startup.
	useEffect(() => {
		void ensureAndroidChannel();
	}, []);

	// When the user clears the server config (unpairs), unregister this device's
	// token from the daemon it was registered with, so that daemon stops pushing
	// to a phone that's no longer watching it. Uses the persisted daemon creds.
	useEffect(() => {
		if (wasConfigured.current && !configured) {
			void unregisterFromPush();
		}
		wasConfigured.current = configured;
	}, [configured]);

	// Register after a successful pairing/connection (D7: only prompt once the
	// feature is meaningful) and refresh on every foreground while connected.
	// registerForPush persists the daemon it registered with and, when the config
	// points at a different daemon, unregisters the old one first — so switching
	// daemons (even across app restarts) is handled inside push.ts, not here.
	useEffect(() => {
		if (!config || connection !== "open") return;
		const safeRegister = () => {
			registerForPush(config).catch((e) => console.warn("[push] registration failed", e));
		};
		safeRegister();
		const sub = AppState.addEventListener("change", (s) => {
			if (s === "active") safeRegister();
		});
		return () => sub.remove();
	}, [config, connection]);

	// Route notification taps: warm via the response listener, cold start via
	// getLastNotificationResponseAsync (the listener alone misses the launch tap).
	useEffect(() => {
		if (!navState?.key) return; // wait until navigation is ready to accept routes

		const handle = (resp: Notifications.NotificationResponse | null) => {
			if (!resp) return;
			route((resp.notification.request.content.data ?? {}) as PushData);
		};

		if (!handledColdStart.current) {
			handledColdStart.current = true;
			void Notifications.getLastNotificationResponseAsync().then(handle);
		}
		const sub = Notifications.addNotificationResponseReceivedListener(handle);
		return () => sub.remove();
		// route() reads the latest config via ref-free closure; re-bind when it changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [navState?.key, config]);

	function route(data: PushData) {
		// Best-effort mark-read so unread counts stay consistent with the dashboard.
		if (config && data.notificationId) {
			markNotificationRead(config, data.notificationId).catch(() => {});
		}
		if (data.type === "needs_input" && data.sessionId) {
			// The session screen handles a terminated/missing session itself
			// (offers Restore), so navigate straight in.
			router.navigate(`/session/${data.sessionId}`);
			return;
		}
		// PR notifications (ready_to_merge / pr_merged / pr_closed_unmerged) → PRs tab.
		router.navigate("/prs");
	}

	return null;
}
