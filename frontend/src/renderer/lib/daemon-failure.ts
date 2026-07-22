import type { DaemonStatus } from "../../shared/daemon-status";

export function daemonFailureMessage(status: DaemonStatus): string {
	if (status.message) return status.message;
	if (status.state === "starting") return "AO daemon is starting.";
	return "AO daemon is not ready.";
}

export function daemonFailureHint(status: DaemonStatus): string {
	switch (status.code) {
		case "binary_missing":
			return "Run npm run build:daemon to rebuild the daemon.";
		case "spawn_failed":
			return "Check the terminal where you ran npm run dev for the underlying OS error.";
		case "exited":
			return "Check the terminal where you ran npm run dev for build or startup errors.";
		case "not_ready":
			return "The daemon has not passed its readiness check yet. Check the development terminal for details.";
		case "not_configured":
			return "Set AO_DAEMON_COMMAND or run the desktop app from a source checkout.";
		case "daemon_unreachable":
		case "identity_mismatch":
			return "Stop the conflicting daemon, then restart the desktop app.";
		default:
			return "Check the terminal where you ran npm run dev for details.";
	}
}
