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
  return { title: { absolute: `ao | ${projectName} PRs` } };
}

export default async function PullRequestsRoute(props: {
  searchParams: Promise<{ project?: string }>;
}) {
  const searchParams = await props.searchParams;
  const projectFilter = resolveDashboardProjectFilter(searchParams.project);
  const pageData = await getDashboardPageData(projectFilter);

  return (
    <PullRequestsPage
      initialSessions={pageData.sessions}
      projectId={pageData.selectedProjectId}
      projectName={pageData.projectName}
      projects={pageData.projects}
      orchestrators={pageData.orchestrators}
      attentionZones={pageData.attentionZones}
    />
  );
}
