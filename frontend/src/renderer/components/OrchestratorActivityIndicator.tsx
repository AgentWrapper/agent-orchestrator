import type { WorkspaceSession } from "../types/workspace";
import { getAgentActivityView } from "../lib/session-presentation";
import { cn } from "../lib/utils";

export function OrchestratorActivityIndicator({ session }: { session: WorkspaceSession }) {
	const activity = getAgentActivityView(session.activity);

	return <span aria-hidden="true" className={cn("size-dot-sm shrink-0 rounded-full", activity.indicatorClassName)} />;
}
