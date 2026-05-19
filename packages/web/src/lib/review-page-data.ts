import "server-only";

import {
  createCodeReviewStore,
  isOrchestratorSession,
  isRestorable,
  isTerminalSession,
  markOutdatedCodeReviewRunsForSession,
} from "@aoagents/ao-core";
import { getServices } from "@/lib/services";
import {
  getAllProjects,
  getPrimaryProjectId,
  getProjectName,
  type ProjectInfo,
} from "@/lib/project-name";
import type { DashboardReviewRun, ReviewWorkerOption } from "@/lib/review-types";
import { listDashboardOrchestrators, sessionToDashboard } from "@/lib/serialize";
import type { DashboardOrchestratorLink, DashboardSession } from "@/lib/types";

interface ReviewPageData {
  runs: DashboardReviewRun[];
  sidebarSessions: DashboardSession[];
  orchestrators: DashboardOrchestratorLink[];
  workerOptions: ReviewWorkerOption[];
  projectName: string;
  projects: ProjectInfo[];
  selectedProjectId?: string;
  dashboardLoadError?: string;
}

function formatReviewLoadError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message.split(/\r?\n/)[0]?.trim() || "Failed to load review data.";
  }
  return "Failed to load review data.";
}

export function getReviewProjectName(projectFilter: string | undefined): string {
  if (projectFilter === "all") return "All Projects";
  const projects = getAllProjects();
  if (projectFilter) {
    const selectedProject = projects.find((project) => project.id === projectFilter);
    if (selectedProject) return selectedProject.name;
  }
  return getProjectName();
}

export function resolveReviewProjectFilter(project?: string): string {
  if (project === "all") return "all";
  const projects = getAllProjects();
  if (project && projects.some((entry) => entry.id === project)) {
    return project;
  }
  return getPrimaryProjectId();
}

export async function getReviewPageData(project?: string): Promise<ReviewPageData> {
  const projectFilter = resolveReviewProjectFilter(project);
  const pageData: ReviewPageData = {
    runs: [],
    sidebarSessions: [],
    orchestrators: [],
    workerOptions: [],
    projectName: getReviewProjectName(projectFilter),
    projects: getAllProjects(),
    selectedProjectId: projectFilter === "all" ? undefined : projectFilter,
  };

  try {
    const { config, sessionManager } = await getServices();
    const projectIds =
      projectFilter === "all"
        ? Object.keys(config.projects)
        : config.projects[projectFilter]
          ? [projectFilter]
          : [];
    const allSessions = await sessionManager.listCached();
    const visibleSessions = allSessions.filter((session) => projectIds.includes(session.projectId));
    const allSessionPrefixes = Object.entries(config.projects).map(
      ([projectId, project]) => project.sessionPrefix ?? projectId,
    );
    const workerSessionsById = new Map(
      visibleSessions
        .filter(
          (session) =>
            !isOrchestratorSession(
              session,
              config.projects[session.projectId]?.sessionPrefix ?? session.projectId,
              allSessionPrefixes,
            ),
        )
        .map((session) => [session.id, session]),
    );
    const workerSessions = [...workerSessionsById.values()];

    pageData.sidebarSessions = visibleSessions.map(sessionToDashboard);
    const visibleSessionsById = new Map(visibleSessions.map((session) => [session.id, session]));
    pageData.orchestrators = listDashboardOrchestrators(visibleSessions, config.projects).map(
      (orchestrator) => {
        const session = visibleSessionsById.get(orchestrator.id);
        return {
          ...orchestrator,
          status: session?.status ?? null,
          activity: session?.activity ?? null,
          runtimeState: session?.lifecycle.runtime.state ?? null,
          hasRuntime: session?.runtimeHandle !== null && session?.runtimeHandle !== undefined,
          isTerminal: session ? isTerminalSession(session) : false,
          isRestorable: session ? isRestorable(session) : false,
        };
      },
    );
    pageData.workerOptions = workerSessions.map((session) => {
      const project = config.projects[session.projectId];
      const title =
        session.metadata["displayName"] ??
        session.metadata["issueTitle"] ??
        session.metadata["pinnedSummary"] ??
        session.agentInfo?.summary ??
        session.branch ??
        session.id;
      return {
        id: session.id,
        projectId: session.projectId,
        projectName: project?.name ?? session.projectId,
        title,
        branch: session.branch ?? null,
        status: session.status,
        activity: session.activity ?? null,
        runtimeState: session.lifecycle.runtime.state,
        hasRuntime: session.runtimeHandle !== null && session.runtimeHandle !== undefined,
        prNumber: session.pr?.number ?? null,
        prUrl: session.pr?.url ?? null,
      };
    });

    const runs: DashboardReviewRun[] = [];

    for (const projectId of projectIds) {
      const project = config.projects[projectId];
      if (!project) continue;
      const store = createCodeReviewStore(projectId);
      const projectWorkers = workerSessions.filter((session) => session.projectId === projectId);

      for (const worker of projectWorkers) {
        await markOutdatedCodeReviewRunsForSession({ store, session: worker });
      }

      runs.push(
        ...store.listRunSummaries().map((run) => {
          const worker = workerSessionsById.get(run.linkedSessionId);
          return {
            ...run,
            projectName: project.name,
            workerTitle:
              worker?.metadata["displayName"] ??
              worker?.metadata["issueTitle"] ??
              worker?.metadata["pinnedSummary"] ??
              worker?.agentInfo?.summary ??
              null,
            workerBranch: worker?.branch ?? null,
            workerPrUrl: worker?.pr?.url ?? run.prUrl ?? null,
            workerStatus: worker?.status ?? null,
            workerActivity: worker?.activity ?? null,
            workerRuntimeState: worker?.lifecycle.runtime.state ?? null,
            workerHasRuntime: worker?.runtimeHandle !== null && worker?.runtimeHandle !== undefined,
          };
        }),
      );
    }

    pageData.runs = runs;
  } catch (err) {
    pageData.dashboardLoadError = formatReviewLoadError(err);
  }

  return pageData;
}
