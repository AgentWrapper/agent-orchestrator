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

/**
 * Dot-only activity signal for controls that already name the agent. The
 * surrounding button supplies the accessible activity label; this keeps the
 * Kanban action compact while preserving the same live pulse semantics as a
 * session identity.
 */
export function TopbarActivityDot({ activity }: { activity?: SessionActivity | null }) {
	const { label, tone, breathe } = getAgentActivityView(activity);

	return (
		<span className="reverb-topbar__button-activity" data-activity={label} style={{ color: tone }} title={label}>
			<span aria-hidden="true" className={cn("reverb-topbar__status-dot", breathe && "animate-status-pulse")} />
		</span>
	);
}
