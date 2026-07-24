import type { DaemonStatus } from "../../shared/daemon-status";

export function daemonFailureMessage(status: DaemonStatus): string {
	if (status.message) return status.message;
	if (status.state === "starting") return "AO daemon is starting.";
	return "AO daemon is not ready.";
}

export function daemonFailureTitle(status: DaemonStatus): string {
	switch (status.code) {
		case "not_ready":
		case "port_unconfirmed":
			return "AO daemon is not ready yet";
		case "not_configured":
			return "AO daemon is not configured";
		case "daemon_unreachable":
			return "AO daemon is unreachable";
		case "identity_mismatch":
			return "AO daemon identity check failed";
		case "binary_missing":
			return "AO daemon binary is missing";
		case "spawn_failed":
		case "exited":
		default:
			return "AO daemon failed to start";
	}
}

export function daemonFailureHint(status: DaemonStatus): string {
	switch (status.code) {
		case "binary_missing":
			return "Run npm run build:daemon to rebuild the daemon.";
		case "spawn_failed":
		case "exited":
			return "";
		case "not_ready":
			return "The daemon has not passed its readiness check yet. Open details below for more information.";
		case "not_configured":
			return "Set AO_DAEMON_COMMAND or run the desktop app from a source checkout.";
		case "daemon_unreachable":
		case "identity_mismatch":
			return "Stop the conflicting daemon, then restart the desktop app.";
		default:
			return "Check the terminal where you ran npm run dev for details.";
	}
}
