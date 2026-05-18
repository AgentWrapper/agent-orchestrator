import { NextResponse } from "next/server";
import { readArtifacts } from "@aoagents/ao-core";
import { getServices } from "@/lib/services";

/**
 * GET /api/sessions/[id]/artifacts
 *
 * Returns the artifact list for the given session. Reads agent-emitted artifacts
 * from disk, sorted by updatedAt desc.
 *
 * Returns an empty list (not 404) when the session or its project can't be
 * resolved so the dashboard can render gracefully for already-cleaned-up
 * sessions.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: sessionId } = await params;

  const { config, sessionManager } = await getServices();
  const session = await sessionManager.get(sessionId);
  if (!session) {
    return NextResponse.json({ artifacts: [] });
  }

  const project = config.projects[session.projectId];
  if (!project) {
    return NextResponse.json({ artifacts: [] });
  }

  const stored = await readArtifacts(session.projectId, sessionId);
  stored.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  return NextResponse.json({ artifacts: stored });
}
