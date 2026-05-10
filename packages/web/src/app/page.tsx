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
  return {
    title: { absolute: `ao | ${projectName}` },
    description: `Live AO dashboard for ${projectName} agent sessions, pull requests, and merge status.`,
  };
}

export default async function Home(props: { searchParams: Promise<{ project?: string }> }) {
  const searchParams = await props.searchParams;
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const pageData = await getDashboardPageData(projectFilter);
  const sidebarData = pageData.selectedProjectId
    ? await getDashboardPageData("all")
    : pageData;

  return (
    <Dashboard
      initialSessions={sidebarData.sessions}
      projectId={pageData.selectedProjectId}
      projectName={pageData.projectName}
      projects={pageData.projects}
      orchestrators={sidebarData.orchestrators}
      attentionZones={pageData.attentionZones}
      dashboardLoadError={pageData.dashboardLoadError ?? sidebarData.dashboardLoadError}
    />
  );
}
