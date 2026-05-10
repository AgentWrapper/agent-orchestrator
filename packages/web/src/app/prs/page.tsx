import type { Metadata } from "next";
import { PullRequestsPage } from "@/components/PullRequestsPage";
import {
  getDashboardPageData,
  getDashboardProjectName,
  resolveDashboardProjectFilter,
} from "@/lib/dashboard-page-data";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const projectName = getDashboardProjectName(projectFilter);
  return {
    title: { absolute: `ao | ${projectName} PRs` },
    description: `Pull requests opened by AO agents for ${projectName}.`,
  };
}

export default async function PullRequestsRoute(props: {
  searchParams: Promise<{ project?: string }>;
}) {
  const searchParams = await props.searchParams;
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const pageData = await getDashboardPageData("all");
  const selectedProjectId = projectFilter === "all" ? undefined : projectFilter;

  return (
    <PullRequestsPage
      initialSessions={pageData.sessions}
      projectId={selectedProjectId}
      projectName={getDashboardProjectName(projectFilter)}
      projects={pageData.projects}
      orchestrators={pageData.orchestrators}
      attentionZones={pageData.attentionZones}
    />
  );
}
