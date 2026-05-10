import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Dashboard } from "@/components/Dashboard";
import { DegradedProjectState } from "@/components/DegradedProjectState";
import { getDashboardPageData } from "@/lib/dashboard-page-data";
import { getProjectRouteData } from "@/lib/project-route-data";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  params: Promise<{ projectId: string }>;
}): Promise<Metadata> {
  const { projectId } = await props.params;
  const routeData = await getProjectRouteData(projectId);
  const projectName = routeData?.project?.name ?? routeData?.projectId ?? projectId;
  return {
    title: { absolute: `ao | ${projectName}` },
    description: `Live AO dashboard for ${projectName} agent sessions, pull requests, and merge status.`,
  };
}

export default async function ProjectPage(props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params;
  const routeData = await getProjectRouteData(projectId);

  if (!routeData) {
    notFound();
  }

  if (routeData.degradedProject) {
    return (
      <DegradedProjectState
        projectId={routeData.projectId}
        resolveError={routeData.degradedProject.resolveError}
        projectPath={routeData.degradedProject.path}
      />
    );
  }

  const pageData = await getDashboardPageData("all");
  const projectName = routeData.project?.name ?? routeData.projectId;

  return (
    <div className="min-h-screen bg-[var(--color-bg-canvas)]">
      <Dashboard
        initialSessions={pageData.sessions}
        projectId={routeData.projectId}
        projectName={projectName}
        projects={pageData.projects}
        orchestrators={pageData.orchestrators}
        attentionZones={pageData.attentionZones}
        dashboardLoadError={pageData.dashboardLoadError}
      />
    </div>
  );
}
