import { useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useWorkspaceQuery } from "./useWorkspaceQuery";
import {
	findProjectOrchestrator,
	isOrchestratorSession,
	type WorkspaceSession,
	type WorkspaceSummary,
} from "../types/workspace";
import type { ReverbTopbarModel, ReverbTopbarSurface } from "../components/topbar/topbar-model";

export type ReverbTopbarSurfaceOverride = Extract<
	ReverbTopbarSurface,
	"global-settings" | "project-settings" | "standalone-terminals"
>;

export interface ReverbTopbarScope {
	model: ReverbTopbarModel;
	session?: WorkspaceSession;
	project?: WorkspaceSummary;
	orchestrator?: WorkspaceSession;
	sessionId?: string;
	projectId?: string;
	projectLabel: string;
	isSessionRoute: boolean;
	isProjectBoardRoute: boolean;
	isRootBoardRoute: boolean;
	isOrchestrator: boolean;
}

/**
 * Route/workspace adapter for Reverb's shared top bar.
 *
 * The URL remains the selection source of truth and the session's actual
 * workspace always wins over a project id from the route. This hook only
 * derives display context; mutations and action handlers stay with the host.
 */
export function useReverbTopbarModel(surfaceOverride?: ReverbTopbarSurfaceOverride): ReverbTopbarScope {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const params = useParams({ strict: false }) as { projectId?: string; sessionId?: string };
	const workspaces = useWorkspaceQuery().data ?? [];
	const session = params.sessionId
		? workspaces.flatMap((workspace) => workspace.sessions).find((candidate) => candidate.id === params.sessionId)
		: undefined;
	const isSessionRoute = Boolean(params.sessionId);
	const projectId = session?.workspaceId ?? params.projectId;
	const project = projectId ? workspaces.find((workspace) => workspace.id === projectId) : undefined;
	const projectLabel = project?.name ?? session?.workspaceName ?? "";
	const orchestrator = projectId ? findProjectOrchestrator(workspaces, projectId) : undefined;
	const isOrchestrator = session ? isOrchestratorSession(session) : false;
	const isProjectBoardRoute = !surfaceOverride && !isSessionRoute && Boolean(projectId);
	const isRootBoardRoute = !surfaceOverride && !isSessionRoute && !isProjectBoardRoute;
	const openHome = () => void navigate({ to: "/" });
	const openProject = () => {
		if (!projectId) return;
		void navigate({ to: "/projects/$projectId", params: { projectId } });
	};

	let model: ReverbTopbarModel;

	if (surfaceOverride === "global-settings") {
		model = {
			surface: "global-settings",
			breadcrumbs: [{ id: "settings", label: t("settings.title") }],
		};
	} else if (surfaceOverride === "project-settings") {
		model = {
			surface: "project-settings",
			breadcrumbs: [
				...(projectLabel ? [{ id: "project", label: projectLabel, onClick: openProject }] : []),
				{ id: "settings", label: t("settings.title") },
			],
		};
	} else if (surfaceOverride === "standalone-terminals") {
		model = {
			surface: "standalone-terminals",
			breadcrumbs: [
				{ id: "reverb", label: "Reverb", onClick: openHome },
				{ id: "terminals", label: t("workbench.terminals") },
			],
		};
	} else if (isSessionRoute) {
		const sessionContextLabel =
			projectLabel || session?.workspaceName || (isOrchestrator ? t("shell.orchestrator") : session?.title) || "Session unavailable";
		model = {
			surface: isOrchestrator ? "orchestrator-session" : "worker-session",
			breadcrumbs: session
				? [
						{
							id: "session",
							label: sessionContextLabel,
							title: sessionContextLabel,
						},
					]
				: [{ id: "session-unavailable", label: "Session unavailable" }],
			contextAriaLabel: session ? (isOrchestrator ? "Orchestrator activity" : "Worker context") : undefined,
		};
	} else if (isProjectBoardRoute) {
		model = {
			surface: "project-board",
			breadcrumbs: [{ id: "board", label: t("shell.board") }],
		};
	} else {
		model = {
			surface: "global-board",
			breadcrumbs: [{ id: "board", label: t("shell.board") }],
		};
	}

	return {
		model,
		session,
		project,
		orchestrator,
		sessionId: params.sessionId,
		projectId,
		projectLabel,
		isSessionRoute,
		isProjectBoardRoute,
		isRootBoardRoute,
		isOrchestrator,
	};
}
