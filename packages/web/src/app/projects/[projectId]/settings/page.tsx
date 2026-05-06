import Link from "next/link";
import { notFound } from "next/navigation";
import { DegradedProjectState } from "@/components/DegradedProjectState";
import { ProjectSettingsForm } from "@/components/ProjectSettingsForm";
import { getProjectRouteData } from "@/lib/project-route-data";

export const dynamic = "force-dynamic";

export default async function ProjectSettingsPage(props: {
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
        heading="This project's settings can't be edited until its config loads cleanly"
      />
    );
  }

  const project = routeData.project;
  if (!project) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-[var(--color-bg-canvas)] px-6 py-10 text-[var(--color-text-primary)]">
      <div className="mx-auto max-w-5xl">
        <nav className="mb-6 flex items-center gap-2 text-sm text-[var(--color-text-tertiary)]">
          <Link href={`/projects/${encodeURIComponent(projectId)}`} className="hover:text-[var(--color-text-primary)]">
            {project.name}
          </Link>
          <span>/</span>
          <span className="text-[var(--color-text-primary)]">Settings</span>
        </nav>

        <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              Project Settings
            </p>
            <h1 className="mt-2 text-3xl font-semibold">{project.name}</h1>
            <p className="mt-2 max-w-3xl text-sm text-[var(--color-text-secondary)]">
              Edit behavior fields for this project without changing which repository identity it points at.
            </p>
          </div>
          <Link
            href={`/projects/${encodeURIComponent(projectId)}`}
            className="rounded-lg border border-[var(--color-border-default)] px-4 py-2 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
          >
            Back to project
          </Link>
        </header>

        <ProjectSettingsForm
          projectId={projectId}
          initialValues={{
            agent: project.agent ?? "",
            runtime: project.runtime ?? "",
            trackerPlugin: project.tracker?.plugin ?? "",
            scmPlugin: project.scm?.plugin ?? "",
            reactions: JSON.stringify(project.reactions ?? {}, null, 2),
            identity: {
              projectId,
              path: project.path,
              repo: project.repo ?? "",
              defaultBranch: project.defaultBranch,
            },
          }}
        />
      </div>
    </div>
  );
}
