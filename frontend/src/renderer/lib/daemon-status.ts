import { aoBridge } from "./bridge";
import { setApiBaseUrl } from "./api-client";

export type DaemonStatus = Awaited<ReturnType<typeof aoBridge.daemon.getStatus>>;

let lastDaemonMessage: string | undefined;

export function applyDaemonStatus(nextStatus: DaemonStatus): void {
	lastDaemonMessage = nextStatus.message;
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

export function getLastDaemonMessage(): string | undefined {
	return lastDaemonMessage;
}
