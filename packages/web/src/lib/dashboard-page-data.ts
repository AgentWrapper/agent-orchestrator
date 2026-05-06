import "server-only";

import { cache } from "react";
import {
  type DashboardSession,
  type DashboardOrchestratorLink,
  type DashboardAttentionZoneMode,
} from "@/lib/types";
import { getServices } from "@/lib/services";
import {
  sessionToDashboard,
  enrichSessionPR,
  enrichSessionsMetadataFast,
  listDashboardOrchestrators,
} from "@/lib/serialize";
import { getPrimaryProjectId, getProjectName, getAllProjects, type ProjectInfo } from "@/lib/project-name";
import { filterProjectSessions, filterWorkerSessions } from "@/lib/project-utils";
import { settlesWithin } from "@/lib/async-utils";

const FAST_METADATA_ENRICH_TIMEOUT_MS = 3_000;

/**
 * Normalize thrown values from dashboard SSR into a single-line message for the UI.
 * Avoids dumping stack traces into the banner.
 */
export function formatDashboardLoadError(err: unknown): string {
  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "";

  if (rawMessage.trim()) {
    const firstLine = rawMessage
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (firstLine) return firstLine;
  }
  return "The orchestrator could not load dashboard data. Check your configuration file.";
}

interface DashboardPageData {
  sessions: DashboardSession[];
  orchestrators: DashboardOrchestratorLink[];
  projectName: string;
  projects: ProjectInfo[];
  selectedProjectId?: string;
  attentionZones: DashboardAttentionZoneMode;
  /** Present when services initialization or session listing failed during SSR (distinct from an empty session list). */
  dashboardLoadError?: string;
}

/** Default zone mode when no config is loaded or `dashboard` block is absent. */
export const DEFAULT_ATTENTION_ZONE_MODE: DashboardAttentionZoneMode = "simple";

export const getDashboardProjectName = cache(function getDashboardProjectName(
  projectFilter: string | undefined,
): string {
  if (projectFilter === "all") return "All Projects";
  const projects = getAllProjects();
  if (projectFilter) {
    const selectedProject = projects.find((project) => project.id === projectFilter);
    if (selectedProject) return selectedProject.name;
  }
  return getProjectName();
});

export function resolveDashboardProjectFilter(project?: string): string {
  if (project === "all") return "all";
  const projects = getAllProjects();
  if (project && projects.some((entry) => entry.id === project)) {
    return project;
  }
  return getPrimaryProjectId();
}

export const getDashboardPageData = cache(async function getDashboardPageData(project?: string): Promise<DashboardPageData> {
  const projectFilter = resolveDashboardProjectFilter(project);
  const pageData: DashboardPageData = {
    sessions: [],
    orchestrators: [],
    projectName: getDashboardProjectName(projectFilter),
    projects: getAllProjects(),
    selectedProjectId: projectFilter === "all" ? undefined : projectFilter,
    attentionZones: DEFAULT_ATTENTION_ZONE_MODE,
  };

  let config: Awaited<ReturnType<typeof getServices>>["config"];
  let registry: Awaited<ReturnType<typeof getServices>>["registry"];
  let allSessions: Awaited<ReturnType<Awaited<ReturnType<typeof getServices>>["sessionManager"]["listCached"]>>;

  try {
    const services = await getServices();
    config = services.config;
    registry = services.registry;
    pageData.attentionZones = config.dashboard?.attentionZones ?? DEFAULT_ATTENTION_ZONE_MODE;
    try {
      allSessions = await services.sessionManager.listCached();
    } catch (listErr) {
      pageData.dashboardLoadError = formatDashboardLoadError(listErr);
      return pageData;
    }
  } catch (err) {
    pageData.dashboardLoadError = formatDashboardLoadError(err);
    return pageData;
  }

  const visibleSessions = filterProjectSessions(allSessions, projectFilter, config.projects);
  pageData.orchestrators = listDashboardOrchestrators(visibleSessions, config.projects);

  const coreSessions = filterWorkerSessions(allSessions, projectFilter, config.projects);
  pageData.sessions = coreSessions.map(sessionToDashboard);

  // Fast enrichment: issue labels (sync) + agent summaries (local disk I/O).
  // Keep a hard cap here so a slow local agent plugin can't stall SSR indefinitely.
  try {
    await settlesWithin(
      enrichSessionsMetadataFast(coreSessions, pageData.sessions, config, registry),
      FAST_METADATA_ENRICH_TIMEOUT_MS,
    );
  } catch (err) {
    // Keep the base dashboard data if non-critical enrichment fails.
    console.warn("[dashboard-page-data] metadata fast enrichment failed:", err);
  }

  // PR enrichment from session metadata (no API calls).
  for (let i = 0; i < coreSessions.length; i++) {
    if (!coreSessions[i].pr) continue;
    enrichSessionPR(pageData.sessions[i]);
  }

  return pageData;
});
