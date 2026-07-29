import { useEffect, useState } from "react";
import { aoBridge } from "../lib/bridge";
import { isMacPlatform } from "../lib/platform";

/**
 * Whether the Electron BrowserWindow is in native fullscreen. macOS-only: used
 * to drop the traffic-light clearance above TitlebarNav when the lights are gone.
 * No-ops on Win/Linux (TitlebarNav / drag strip are not mounted there).
 */
export function useWindowFullScreen(): boolean {
	const [fullScreen, setFullScreen] = useState(false);
	useEffect(() => {
		if (!isMacPlatform()) return;

		let live = true;
		// Push events bump the version so a late isFullScreen() seed cannot
		// overwrite a newer enter/leave-full-screen notification.
		let version = 0;

		const off = aoBridge.window.onFullScreen((value) => {
			version += 1;
			setFullScreen(value);
		});

		const seedVersion = version;
		void aoBridge.window.isFullScreen().then((value) => {
			if (live && seedVersion === version) setFullScreen(value);
		});

		return () => {
			live = false;
			off?.();
		};
	}, []);
	return fullScreen;
}
