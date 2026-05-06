import type { Metadata } from "next";

export const dynamic = "force-dynamic";
import { Dashboard } from "@/components/Dashboard";
import {
  getDashboardPageData,
  getDashboardProjectName,
  resolveDashboardProjectFilter,
} from "@/lib/dashboard-page-data";

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const projectName = getDashboardProjectName(projectFilter);
  return { title: { absolute: `ao | ${projectName}` } };
}

export default async function Home(props: { searchParams: Promise<{ project?: string }> }) {
  const searchParams = await props.searchParams;
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const pageData = await getDashboardPageData(projectFilter);

  return (
    <Dashboard
      initialSessions={pageData.sessions}
      projectId={pageData.selectedProjectId}
      projectName={pageData.projectName}
      projects={pageData.projects}
      orchestrators={pageData.orchestrators}
      attentionZones={pageData.attentionZones}
      dashboardLoadError={pageData.dashboardLoadError}
    />
  );
}
