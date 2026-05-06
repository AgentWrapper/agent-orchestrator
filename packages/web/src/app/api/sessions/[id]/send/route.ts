import { type NextRequest } from "next/server";
import { validateIdentifier, validateString, stripControlChars } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { SessionNotFoundError } from "@aoagents/ao-core";
import {
  getCorrelationId,
  jsonWithCorrelation,
  recordApiObservation,
  resolveProjectIdForSessionId,
} from "@/lib/observability";

const MAX_MESSAGE_LENGTH = 10_000;

/** POST /api/sessions/:id/send — Send a message to a session */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const messageErr = validateString(body?.message, "message", MAX_MESSAGE_LENGTH);
  if (messageErr) {
    return jsonWithCorrelation({ error: messageErr }, { status: 400 }, correlationId);
  }

  // Strip control characters to prevent injection when passed to shell-based runtimes
  const message = stripControlChars(String(body?.message ?? ""));

  // Re-validate after stripping — a control-char-only message becomes empty
  if (message.trim().length === 0) {
    return jsonWithCorrelation(
      { error: "message must not be empty after sanitization" },
      { status: 400 },
      correlationId,
    );
  }

  try {
    const { config, sessionManager } = await getServices();
    const projectId = resolveProjectIdForSessionId(config, id);
    await sessionManager.send(id, message);
    recordApiObservation({
      config,
      method: "POST",
      path: "/api/sessions/[id]/send",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId,
      sessionId: id,
      data: { messageLength: message.length },
    });
    return jsonWithCorrelation(
      { ok: true, sessionId: id, message },
      { status: 200 },
      correlationId,
    );
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return jsonWithCorrelation({ error: err.message }, { status: 404 }, correlationId);
    }
    const { config } = await getServices().catch(() => ({ config: undefined }));
    const projectId = config ? resolveProjectIdForSessionId(config, id) : undefined;
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/sessions/[id]/send",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId,
        sessionId: id,
        reason: err instanceof Error ? err.message : "Failed to send message",
        data: { messageLength: message.length },
      });
    }
    const msg = err instanceof Error ? err.message : "Failed to send message";
    return jsonWithCorrelation({ error: msg }, { status: 500 }, correlationId);
  }
}
