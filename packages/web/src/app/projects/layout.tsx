import { getDashboardPageData } from "@/lib/dashboard-page-data";
import { ProjectLayoutClient } from "./[projectId]/project-layout-client";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default async function ProjectLayout({ children }: { children: ReactNode }) {
  const pageData = await getDashboardPageData("all");

  return (
    <ProjectLayoutClient
      initialSessions={pageData.sessions}
      initialProjects={pageData.projects}
      initialOrchestrators={pageData.orchestrators}
    >
      {children}
    </ProjectLayoutClient>
  );
}
