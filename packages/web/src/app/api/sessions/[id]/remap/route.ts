import { type NextRequest } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { SessionNotFoundError } from "@aoagents/ao-core";
import {
  getCorrelationId,
  jsonWithCorrelation,
  recordApiObservation,
  resolveProjectIdForSessionId,
} from "@/lib/observability";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }

  try {
    const { config, sessionManager } = await getServices();
    const projectId = resolveProjectIdForSessionId(config, id);
    const opencodeSessionId = await sessionManager.remap(id, true);
    recordApiObservation({
      config,
      method: "POST",
      path: "/api/sessions/[id]/remap",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId,
      sessionId: id,
    });
    return jsonWithCorrelation(
      { ok: true, sessionId: id, opencodeSessionId },
      { status: 200 },
      correlationId,
    );
  } catch (err) {
    const { config } = await getServices().catch(() => ({ config: undefined }));
    const projectId = config ? resolveProjectIdForSessionId(config, id) : undefined;
    if (err instanceof SessionNotFoundError) {
      if (config) {
        recordApiObservation({
          config,
          method: "POST",
          path: "/api/sessions/[id]/remap",
          correlationId,
          startedAt,
          outcome: "failure",
          statusCode: 404,
          projectId,
          sessionId: id,
          reason: err.message,
        });
      }
      return jsonWithCorrelation({ error: err.message }, { status: 404 }, correlationId);
    }
    const msg = err instanceof Error ? err.message : "Failed to remap session";
    if (msg.includes("not using the opencode agent") || msg.includes("mapping is missing")) {
      if (config) {
        recordApiObservation({
          config,
          method: "POST",
          path: "/api/sessions/[id]/remap",
          correlationId,
          startedAt,
          outcome: "failure",
          statusCode: 422,
          projectId,
          sessionId: id,
          reason: msg,
        });
      }
      return jsonWithCorrelation({ error: msg }, { status: 422 }, correlationId);
    }
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/sessions/[id]/remap",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId,
        sessionId: id,
        reason: msg,
      });
    }
    return jsonWithCorrelation({ error: msg }, { status: 500 }, correlationId);
  }
}
