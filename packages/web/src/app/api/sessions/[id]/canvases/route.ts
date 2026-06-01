import { type NextRequest } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import {
  readCanvases,
  synthesizeGitDiffCanvas,
  SessionNotFoundError,
} from "@aoagents/ao-core";
import {
  getCorrelationId,
  jsonWithCorrelation,
  recordApiObservation,
  resolveProjectIdForSessionId,
} from "@/lib/observability";
import { mergeCanvases } from "./merge";

/** GET /api/sessions/:id/canvases — List canvas artifacts for a session */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const startedAt = Date.now();
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }

  try {
    const { config, sessionManager } = await getServices();
    const session = await sessionManager.get(id);
    if (!session) {
      return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);
    }

    // Trust the SessionManager's authoritative projectId. Falling back to
    // resolveProjectIdForSessionId would mis-route sessions when two project
    // prefixes share a leading substring (e.g. "app" vs "app-api").
    const projectId = session.projectId;
    const project = projectId ? config.projects[projectId] : undefined;

    // A session without a workspacePath (workspace cleaned up, never created)
    // is still a valid session — just one with no canvases. Return empty rather
    // than 404 so the always-mounted CanvasRail shows the empty state.
    const [fileCanvases, synthesized] = session.workspacePath
      ? await Promise.all([
          readCanvases(session.workspacePath),
          project ? synthesizeGitDiffCanvas(session, project) : Promise.resolve(null),
        ])
      : [[], null];

    const canvases = mergeCanvases(synthesized, fileCanvases);

    recordApiObservation({
      config,
      method: "GET",
      path: "/api/sessions/[id]/canvases",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId,
      sessionId: id,
    });
    return jsonWithCorrelation({ canvases }, { status: 200 }, correlationId);
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return jsonWithCorrelation({ error: err.message }, { status: 404 }, correlationId);
    }
    const { config } = await getServices().catch(() => ({ config: undefined }));
    const projectId = config ? resolveProjectIdForSessionId(config, id) : undefined;
    if (config) {
      recordApiObservation({
        config,
        method: "GET",
        path: "/api/sessions/[id]/canvases",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId,
        sessionId: id,
        reason: err instanceof Error ? err.message : "Failed to list canvases",
      });
    }
    const msg = err instanceof Error ? err.message : "Failed to list canvases";
    return jsonWithCorrelation({ error: msg }, { status: 500 }, correlationId);
  }
}
