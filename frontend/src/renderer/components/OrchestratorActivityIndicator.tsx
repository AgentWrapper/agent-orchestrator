import type { WorkspaceSession } from "../types/workspace";
import { getAgentActivityView, getSessionDotView } from "../lib/session-presentation";
import { cn } from "../lib/utils";

export function OrchestratorActivityIndicator({ session }: { session: WorkspaceSession }) {
	const activity = getAgentActivityView(session.activity);
	const dot = getSessionDotView(session);

	return (
		<span
			aria-label={`Orchestrator activity: ${activity.label}`}
			className={cn("size-dot-sm shrink-0 rounded-full", dot.className)}
			role="status"
		/>
	);
}
