import type { WorkspaceSummary } from "../types/workspace";

// The project a new-session shortcut should target: the route's project, or the
// workspace that owns the currently open session (the worker detail route
// carries only a sessionId in the URL). Undefined means no project is in scope.
export function resolveScopedProjectId(
	params: { projectId?: string; sessionId?: string },
	workspaces: WorkspaceSummary[],
): string | undefined {
	if (params.projectId) return params.projectId;
	if (!params.sessionId) return undefined;
	return workspaces.find((workspace) => workspace.sessions.some((session) => session.id === params.sessionId))?.id;
}

type NewSessionActions = {
	requestNewTask: (projectId: string) => void;
	requestCreateProject: () => void;
};

// Route a new-session request: open the New Task flow for the in-scope project,
// or fall back to the create-project flow when nothing is selected (root board,
// PR list, settings) so the shortcut never dead-ends.
export function dispatchNewSession(scopedProjectId: string | undefined, actions: NewSessionActions): void {
	if (scopedProjectId) {
		actions.requestNewTask(scopedProjectId);
	} else {
		actions.requestCreateProject();
	}
}
