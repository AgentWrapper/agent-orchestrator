import { type NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { validateString, validateConfiguredProject } from "@/lib/validation";
import type { Tracker } from "@aoagents/ao-core";

export const dynamic = "force-dynamic";

/**
 * GET /api/issues — List open issues from all configured trackers.
 * Query params: ?state=open|closed|all&label=agent:backlog&project=Saas-code
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const state = (searchParams.get("state") ?? "open") as "open" | "closed" | "all";
  const label = searchParams.get("label") ?? undefined;
  const projectFilter = searchParams.get("project") ?? undefined;

  try {
    const { config, registry } = await getServices();
    const allIssues: Array<{ projectId: string; id: string; title: string; url: string; state: string; labels: string[] }> = [];

    for (const [projectId, project] of Object.entries(config.projects)) {
      if (projectFilter && projectId !== projectFilter) continue;
      if (!project.tracker?.plugin) continue;

      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (!tracker?.listIssues) continue;

      try {
        const issues = await tracker.listIssues(
          { state, labels: label ? [label] : undefined, limit: 50 },
          project,
        );
        for (const issue of issues) {
          allIssues.push({ projectId, ...issue });
        }
      } catch {
        // Skip unavailable trackers
      }
    }

    return NextResponse.json({ issues: allIssues });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch issues" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/issues — Create a new issue and optionally add to backlog.
 * Body: { projectId, title, description, addToBacklog?: boolean }
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const titleErr = validateString(body.title, "title", 200);
  if (titleErr) {
    return NextResponse.json({ error: titleErr }, { status: 400 });
  }

  const projectId = body.projectId as string;
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  try {
    const { config, registry } = await getServices();
    const projectErr = validateConfiguredProject(config.projects, projectId);
    if (projectErr) {
      return NextResponse.json({ error: projectErr }, { status: 404 });
    }
    const project = config.projects[projectId];

    if (!project.tracker?.plugin) {
      return NextResponse.json({ error: "No tracker configured for this project" }, { status: 422 });
    }

    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker?.createIssue) {
      return NextResponse.json({ error: "Tracker does not support issue creation" }, { status: 422 });
    }

    const labels = body.addToBacklog ? ["agent:backlog"] : [];
    const issue = await tracker.createIssue(
      {
        title: body.title as string,
        description: (body.description as string) ?? "",
        labels,
      },
      project,
    );

    return NextResponse.json({ issue: { projectId, ...issue } }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create issue" },
      { status: 500 },
    );
  }
}
