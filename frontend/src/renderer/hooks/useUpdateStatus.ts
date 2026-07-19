import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../main/update-settings";
import { aoBridge } from "../lib/bridge";

/**
 * Live desktop update status: seeded from updates.getStatus, then streamed via
 * the updates:status push channel. Used by the sidebar restart-to-update row
 * and the Global Settings Updates section.
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
