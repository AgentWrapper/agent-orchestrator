import "server-only";

import { cache } from "react";
import type { DegradedProjectEntry, ProjectConfig } from "@aoagents/ao-core";
import { getServices } from "@/lib/services";
import { getAllProjects, type ProjectInfo } from "@/lib/project-name";

export interface ProjectRouteData {
  projectId: string;
  project: ProjectConfig | null;
  degradedProject: DegradedProjectEntry | null;
  projects: ProjectInfo[];
}

export const getProjectRouteData = cache(async function getProjectRouteData(
  projectId: string,
): Promise<ProjectRouteData | null> {
  const { config } = await getServices();

  const project = config.projects[projectId] ?? null;
  const degradedProject = config.degradedProjects[projectId] ?? null;
  if (!project && !degradedProject) {
    return null;
  }

  return {
    projectId,
    project,
    degradedProject,
    projects: getAllProjects(),
  };
});
