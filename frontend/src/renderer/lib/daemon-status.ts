import { aoBridge } from "./bridge";
import { setApiBaseUrl, setDaemonUnavailableMessage } from "./api-client";

export type DaemonStatus = Awaited<ReturnType<typeof aoBridge.daemon.getStatus>>;

export function applyDaemonStatus(nextStatus: DaemonStatus): void {
	if (nextStatus.state === "ready" && nextStatus.port) {
		setDaemonUnavailableMessage(null);
		setApiBaseUrl(`http://127.0.0.1:${nextStatus.port}`);
	} else {
		// Keep the specific failure reason (identity mismatch, exit code, …) so
		// the api-client's 503 short-circuit surfaces it instead of the generic
		// "AO daemon is not ready." (#2481). Set it before the base URL so
		// listeners reacting to the change never see a stale reason.
		setDaemonUnavailableMessage(nextStatus.message ?? null);
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
