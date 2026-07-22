"use client";

import { useSyncExternalStore } from "react";
import { getDownloadTarget, isMacDesktop } from "./desktop-downloads";

/*
 * Client-only platform detection via useSyncExternalStore: the server snapshot
 * (null / false) renders the portable fallback, and React swaps to the detected
 * platform right after hydration — no setState-in-effect flash on mount.
 *
 * Snapshots are cached at module scope: navigator.platform never changes during
 * a page lifetime, and useSyncExternalStore requires stable snapshot references.
 */
let cachedTarget: ReturnType<typeof getDownloadTarget> | undefined;
let cachedMac: boolean | undefined;

function subscribe() {
	return () => {};
}

function getTargetSnapshot() {
	if (cachedTarget === undefined) {
		cachedTarget = getDownloadTarget(navigator);
	}
	return cachedTarget;
}

function getMacSnapshot() {
	if (cachedMac === undefined) {
		cachedMac = isMacDesktop(navigator);
	}
	return cachedMac;
}

function getServerTargetSnapshot() {
	return null;
}

function getServerMacSnapshot() {
	return false;
}

/** Platform-specific direct download ({ label, href }) or null on portable/unknown devices. */
export function useDownloadTarget() {
	return useSyncExternalStore(subscribe, getTargetSnapshot, getServerTargetSnapshot);
}

/** True on macOS desktops (where the brew cask install command applies). */
export function useIsMacDesktop() {
	return useSyncExternalStore(subscribe, getMacSnapshot, getServerMacSnapshot);
}
