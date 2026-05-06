import { notFound } from "next/navigation";
import { Dashboard } from "@/components/Dashboard";
import { DegradedProjectState } from "@/components/DegradedProjectState";
import { getDashboardPageData } from "@/lib/dashboard-page-data";
import { getProjectRouteData } from "@/lib/project-route-data";

export const dynamic = "force-dynamic";

export default async function ProjectPage(props: {
  params: Promise<{ projectId: string }>;
}) {
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

  const pageData = await getDashboardPageData(projectId);

  return (
    <div className="min-h-screen bg-[var(--color-bg-canvas)]">
      <Dashboard
        initialSessions={pageData.sessions}
        projectId={pageData.selectedProjectId}
        projectName={pageData.projectName}
        projects={pageData.projects}
        orchestrators={pageData.orchestrators}
        attentionZones={pageData.attentionZones}
      />
    </div>
  );
}
