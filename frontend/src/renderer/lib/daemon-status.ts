import { aoBridge } from "./bridge";
import { getApiBaseUrl, setApiBaseUrl } from "./api-client";
import { hasElectronBridge } from "./runtime-environment";
import { parseDaemonProbe } from "../../shared/daemon-attach";
import type { DaemonStatus } from "../../shared/daemon-status";

export type { DaemonStatus };

export function applyDaemonStatus(nextStatus: DaemonStatus): void {
	if (nextStatus.state === "ready" && nextStatus.port) {
		setApiBaseUrl(`http://127.0.0.1:${nextStatus.port}`);
	} else if (nextStatus.state === "ready" && !hasElectronBridge()) {
		setApiBaseUrl("");
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
	if (!hasElectronBridge()) return readBrowserDaemonStatus();
	return aoBridge.daemon.getStatus();
}

async function readBrowserDaemonStatus(): Promise<DaemonStatus> {
	const baseUrl = getApiBaseUrl().replace(/\/+$/, "");
	const healthUrl = `${baseUrl}/healthz`;
	try {
		const response = await fetch(healthUrl, { cache: "no-store" });
		if (!response.ok) {
			return {
				state: "error",
				code: "daemon_unreachable",
				message: `AO daemon health check returned HTTP ${response.status}.`,
			};
		}
		const payload = await response.json().catch(() => null);
		const probe = parseDaemonProbe("healthz", payload);
		if (!probe) {
			return {
				state: "error",
				code: "identity_mismatch",
				message: "AO daemon health check returned an invalid payload.",
			};
		}
		return {
			state: "ready",
			pid: probe.pid,
			executablePath: probe.executablePath,
			workingDirectory: probe.workingDirectory,
		};
	} catch (error) {
		return {
			state: "error",
			code: "daemon_unreachable",
			message: error instanceof Error ? error.message : "AO daemon health check failed.",
		};
	}
}
