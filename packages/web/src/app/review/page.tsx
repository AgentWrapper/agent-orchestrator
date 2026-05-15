import type { Metadata } from "next";
import { ReviewDashboard } from "@/components/ReviewDashboard";
import {
  getReviewPageData,
  getReviewProjectName,
  resolveReviewProjectFilter,
} from "@/lib/review-page-data";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const projectFilter = resolveReviewProjectFilter(searchParams.project);
  const projectName = getReviewProjectName(projectFilter);
  return { title: { absolute: `ao | ${projectName} Reviews` } };
}

export default async function ReviewRoute(props: { searchParams: Promise<{ project?: string }> }) {
  const searchParams = await props.searchParams;
  const projectFilter = resolveReviewProjectFilter(searchParams.project);
  const pageData = await getReviewPageData(projectFilter);

  return (
    <ReviewDashboard
      runs={pageData.runs}
      projectId={pageData.selectedProjectId}
      projectName={pageData.projectName}
      projects={pageData.projects}
      sidebarSessions={pageData.sidebarSessions}
      orchestrators={pageData.orchestrators}
      workerOptions={pageData.workerOptions}
      dashboardLoadError={pageData.dashboardLoadError}
    />
  );
}
