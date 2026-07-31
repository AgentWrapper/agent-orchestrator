import { useEffect, useRef, useState } from "react";
import type { UpdateStatus } from "../../main/update-settings";
import { aoBridge } from "../lib/bridge";
import { captureUpdateStatusTransition } from "../lib/update-telemetry";

/**
 * Live desktop update status: seeded from updates.getStatus, then streamed via
 * the updates:status push channel. Used by the sidebar restart-to-update row
 * and the Global Settings Updates section.
 */
export function useUpdateStatus(): UpdateStatus {
	const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
	// Two components mount this hook (the sidebar row and the settings section),
	// and both would otherwise report the same transition. The ref is module-free
	// per hook instance, so the shared reservation in captureRendererEvent is what
	// actually collapses the duplicate; this only avoids the obvious repeat.
	const lastReported = useRef<UpdateStatus | null>(null);
	useEffect(() => {
		let live = true;
		const observe = (next: UpdateStatus) => {
			if (!live) return;
			setStatus(next);
			const previous = lastReported.current;
			lastReported.current = next;
			void captureUpdateStatusTransition(previous, next);
		};
		void aoBridge.updates.getStatus().then(observe);
		const off = aoBridge.updates.onStatus(observe);
		return () => {
			live = false;
			off?.();
		};
	}, []);
	return status;
}
