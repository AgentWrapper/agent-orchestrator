import { getAgentActivityView } from "../../lib/session-presentation";
import { cn } from "../../lib/utils";
import type { SessionActivity } from "../../types/workspace";

/**
 * Compact activity metadata for the current session context. The hairline
 * keeps identity and runtime state distinct without turning status into a pill.
 */
export function TopbarActivityStatus({ activity }: { activity?: SessionActivity | null }) {
	const { label, tone, breathe } = getAgentActivityView(activity);

	return (
		<>
			<span aria-hidden="true" className="reverb-topbar__state-divider" />
			<span className="reverb-topbar__activity" style={{ color: tone }}>
				<span aria-hidden="true" className={cn("reverb-topbar__status-dot", breathe && "animate-status-pulse")} />
				{label}
			</span>
		</>
	);
}
