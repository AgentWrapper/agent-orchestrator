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
  const pageData = await getDashboardPageData("all");
  const selectedProjectId = projectFilter === "all" ? undefined : projectFilter;

  return (
    <Dashboard
      initialSessions={pageData.sessions}
      projectId={selectedProjectId}
      projectName={getDashboardProjectName(projectFilter)}
      projects={pageData.projects}
      orchestrators={pageData.orchestrators}
      attentionZones={pageData.attentionZones}
      dashboardLoadError={pageData.dashboardLoadError}
    />
  );
}
