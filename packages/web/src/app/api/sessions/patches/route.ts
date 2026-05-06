import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getAttentionLevel } from "@/lib/types";
import { filterWorkerSessions } from "@/lib/project-utils";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectFilter = searchParams.get("project");

    const { config, sessionManager } = await getServices();
    const requestedProjectId =
      projectFilter && projectFilter !== "all" && config.projects[projectFilter]
        ? projectFilter
        : undefined;

    const coreSessions = await sessionManager.list(requestedProjectId);
    const visibleSessions = filterWorkerSessions(coreSessions, projectFilter, config.projects);

    // Convert to dashboard format
    const dashboardSessions = visibleSessions.map(sessionToDashboard);

    const attentionZones = config.dashboard?.attentionZones ?? "simple";

    // Extract lightweight patches
    const patches = dashboardSessions.map((session) => ({
      id: session.id,
      status: session.status,
      activity: session.activity,
      attentionLevel: getAttentionLevel(session, attentionZones),
      lastActivityAt: session.lastActivityAt,
    }));

    return Response.json({ sessions: patches });
  } catch (err) {
    console.error("[GET /api/sessions/patches]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to fetch session patches" },
      { status: 500 },
    );
  }
}
