import { useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { initMobileTelemetry, mobileTelemetry, telemetryActiveStorage } from "./telemetry/runtime";

// Headless. Mounted once in the app shell beside PushManager. Initialises the
// PostHog client and emits the daily-active heartbeat on launch and on each
// return to the foreground (which catches a UTC-day rollover while the app was
// backgrounded). The reservation caps it to once per UTC day regardless.
export function TelemetryManager() {
	useEffect(() => {
		initMobileTelemetry();
		void mobileTelemetry()?.active(telemetryActiveStorage);

		const onChange = (state: AppStateStatus) => {
			if (state === "active") void mobileTelemetry()?.active(telemetryActiveStorage);
		};
		const sub = AppState.addEventListener("change", onChange);
		return () => sub.remove();
	}, []);

	return null;
}
