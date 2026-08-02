import type { DaemonStatus } from "../../shared/daemon-status";
import { t } from "../i18n";
import { activeLocale } from "../stores/locale-store";

export function daemonFailureMessage(status: DaemonStatus): string {
	// Prefer the daemon-provided English diagnostic when present.
	if (status.message) return status.message;
	const locale = activeLocale();
	if (status.state === "starting") return t(locale, "daemon.message.starting");
	return t(locale, "daemon.message.notReady");
}

export function daemonFailureTitle(status: DaemonStatus): string {
	const locale = activeLocale();
	switch (status.code) {
		case "not_ready":
		case "port_unconfirmed":
			return t(locale, "daemon.title.notReady");
		case "not_configured":
			return t(locale, "daemon.title.notConfigured");
		case "daemon_unreachable":
			return t(locale, "daemon.title.unreachable");
		case "identity_mismatch":
			return t(locale, "daemon.title.identityMismatch");
		case "binary_missing":
			return t(locale, "daemon.title.binaryMissing");
		case "spawn_failed":
		case "exited":
		default:
			return t(locale, "daemon.title.failed");
	}
}

export function daemonFailureHint(status: DaemonStatus): string {
	const locale = activeLocale();
	switch (status.code) {
		case "binary_missing":
			return t(locale, "daemon.hint.binaryMissing");
		case "spawn_failed":
		case "exited":
			return "";
		case "not_ready":
			return t(locale, "daemon.hint.notReady");
		case "not_configured":
			return t(locale, "daemon.hint.notConfigured");
		case "daemon_unreachable":
		case "identity_mismatch":
			return t(locale, "daemon.hint.conflict");
		default:
			return t(locale, "daemon.hint.default");
	}
}
