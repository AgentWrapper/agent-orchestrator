import type { WorkspaceSession } from "../types/workspace";
import { getSessionDotView } from "../lib/session-presentation";
import { cn } from "../lib/utils";

export function OrchestratorActivityIndicator({ session }: { session: WorkspaceSession }) {
	const dot = getSessionDotView(session);

	return <span aria-hidden="true" className={cn("size-dot-sm shrink-0 rounded-full", dot.className)} />;
}
