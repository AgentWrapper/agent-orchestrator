import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../main/update-settings";
import { aoBridge } from "../lib/bridge";

/**
 * Live desktop update status: seeded from updates.getStatus, then streamed via
 * the updates:status push channel. Used by the sidebar restart-to-update row
 * and the Global Settings Updates section.
 *
 * Deliberately carries no telemetry. Two components mount this hook, so each
 * would report the same outcome, and the statuses it sees are the UI's view:
 * the main process suppresses them for automatic checks. Update telemetry is
 * owned by the main process and subscribed once in lib/update-telemetry.ts.
 */
export function useUpdateStatus(): UpdateStatus {
	const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
	useEffect(() => {
		let live = true;
		void aoBridge.updates.getStatus().then((s) => {
			if (live) setStatus(s);
		});
		const off = aoBridge.updates.onStatus(setStatus);
		return () => {
			live = false;
			off?.();
		};
	}, []);
	return status;
}
