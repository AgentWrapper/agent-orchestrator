import type { Metadata } from "next";
import { OrchestratorSelector, type Orchestrator } from "@/components/OrchestratorSelector";
import { getServices } from "@/lib/services";
import { getAllProjects } from "@/lib/project-name";
import { generateSessionPrefix } from "@aoagents/ao-core";
import { mapSessionsToOrchestrators } from "@/lib/orchestrator-utils";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const projectId = searchParams.project;
  let projectName = "Orchestrator";
  if (projectId) {
    const projects = getAllProjects();
    const project = projects.find((p) => p.id === projectId);
    if (project) {
      projectName = project.name;
    }
  }
  return { title: { absolute: `ao | ${projectName} - Orchestrator` } };
}

export default async function OrchestratorsRoute(props: {
  searchParams: Promise<{ project?: string }>;
}) {
  const searchParams = await props.searchParams;
  const projectId = searchParams.project;

  if (!projectId) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--color-bg-base)]">
        <div className="text-center">
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">
            Missing Project
          </h1>
          <p className="mt-2 text-[var(--color-text-secondary)]">
            No project specified. Please provide a project parameter.
          </p>
        </div>
      </div>
    );
  }

  let orchestrators: Orchestrator[] = [];
  let projectName = projectId;
  let error: string | null = null;

  try {
    const { config, sessionManager } = await getServices();
    const project = config.projects[projectId];

    if (!project) {
      error = `Project "${projectId}" not found`;
    } else {
      projectName = project.name;
      const sessionPrefix = project.sessionPrefix ?? projectId;
      const allSessions = await sessionManager.list(projectId);
      const allSessionPrefixes = Object.entries(config.projects).map(
        ([, p]) => p.sessionPrefix ?? generateSessionPrefix(p.name ?? ""),
      );
      orchestrators = mapSessionsToOrchestrators(
        allSessions,
        sessionPrefix,
        project.name,
        allSessionPrefixes,
      );
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load orchestrators";
  }

  return (
    <OrchestratorSelector
      orchestrators={orchestrators}
      projectId={projectId}
      projectName={projectName}
      error={error}
    />
  );
}
