import { aoBridge } from "./bridge";
import { setApiBaseUrl } from "./api-client";
import { safeDaemonStatusDetail, type DaemonFailureCode } from "../../shared/daemon-status";
import type { TFunction } from "i18next";

export type DaemonStatus = Awaited<ReturnType<typeof aoBridge.daemon.getStatus>>;

const DAEMON_CODE_KEYS = {
	not_configured: "daemonStatus.codes.notConfigured",
	daemon_unreachable: "daemonStatus.codes.daemonUnreachable",
	binary_missing: "daemonStatus.codes.binaryMissing",
	spawn_failed: "daemonStatus.codes.spawnFailed",
	exited: "daemonStatus.codes.exited",
	port_unconfirmed: "daemonStatus.codes.portUnconfirmed",
	not_ready: "daemonStatus.codes.notReady",
	identity_mismatch: "daemonStatus.codes.identityMismatch",
	remote_host_required: "daemonStatus.codes.remoteHostRequired",
	remote_port_invalid: "daemonStatus.codes.remotePortInvalid",
	remote_password_required: "daemonStatus.codes.remotePasswordRequired",
	remote_bad_password: "daemonStatus.codes.remoteBadPassword",
	remote_rate_limited: "daemonStatus.codes.remoteRateLimited",
	remote_http_error: "daemonStatus.codes.remoteHttpError",
	remote_forwarder_bind_failed: "daemonStatus.codes.remoteForwarderBindFailed",
	remote_config_save_failed: "daemonStatus.codes.remoteConfigSaveFailed",
} as const satisfies Record<DaemonFailureCode, string>;

const EXTERNAL_DETAIL_CODES = new Set<string>(["daemon_unreachable", "spawn_failed", "remote_config_save_failed"]);

export function daemonStatusMessage(status: DaemonStatus, t: TFunction, fallback: string): string {
	const code = typeof status.code === "string" ? status.code : undefined;
	if (!code) return fallback;
	const knownCode = Object.hasOwn(DAEMON_CODE_KEYS, code);
	let summary: string;
	if (code === "binary_missing" && status.executablePath) {
		summary = t("daemonStatus.binaryMissingAt", { path: status.executablePath });
	} else if (code === "exited" && status.signal) {
		summary = t("daemonStatus.exitedWithSignal", { signal: status.signal });
	} else if (code === "exited" && typeof status.exitCode === "number") {
		summary = t("daemonStatus.exitedWithCode", { code: status.exitCode });
	} else if (code === "remote_http_error" && typeof status.httpStatus === "number") {
		summary = t("daemonStatus.remoteHTTP", { status: status.httpStatus });
	} else {
		summary = knownCode ? t(DAEMON_CODE_KEYS[code as DaemonFailureCode]) : fallback;
	}

	if (!EXTERNAL_DETAIL_CODES.has(code) && knownCode) return summary;
	const detail = safeDaemonStatusDetail(status.message);
	return detail ? t("daemonStatus.withDetail", { summary, detail }) : summary;
}

export function applyDaemonStatus(nextStatus: DaemonStatus): void {
	if (nextStatus.state === "ready" && nextStatus.port) {
		setApiBaseUrl(`http://127.0.0.1:${nextStatus.port}`);
	} else {
		setApiBaseUrl(null);
	}
}

export async function refreshDaemonStatus(): Promise<DaemonStatus> {
	const nextStatus = await readDaemonStatus();
	applyDaemonStatus(nextStatus);
	return nextStatus;
}

export function readDaemonStatus(): Promise<DaemonStatus> {
	return aoBridge.daemon.getStatus();
}
