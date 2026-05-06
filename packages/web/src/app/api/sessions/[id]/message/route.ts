import { type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import { stripControlChars, validateIdentifier, validateString } from "@/lib/validation";
import { SessionNotFoundError } from "@aoagents/ao-core";
import {
  getCorrelationId,
  jsonWithCorrelation,
  recordApiObservation,
  resolveProjectIdForSessionId,
} from "@/lib/observability";

const MAX_MESSAGE_LENGTH = 10_000;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  try {
    const { id } = await params;

    // Validate session ID to prevent injection
    const idErr = validateIdentifier(id, "id");
    if (idErr) {
      return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
    }

    // Parse JSON with explicit error handling
    let body: Record<string, unknown> | null;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonWithCorrelation(
        { error: "Invalid JSON in request body" },
        { status: 400 },
        correlationId,
      );
    }

    // Validate message is a non-empty string within length limit
    const messageErr = validateString(body?.message, "message", MAX_MESSAGE_LENGTH);
    if (messageErr) {
      return jsonWithCorrelation({ error: messageErr }, { status: 400 }, correlationId);
    }

    // Type guard: ensure message is actually a string
    const rawMessage = body?.message;
    if (typeof rawMessage !== "string") {
      return jsonWithCorrelation(
        { error: "message must be a string" },
        { status: 400 },
        correlationId,
      );
    }

    // Strip control characters to prevent injection when passed to shell-based runtimes
    const message = stripControlChars(rawMessage);

    // Re-validate after stripping — a control-char-only message becomes empty
    if (message.trim().length === 0) {
      return jsonWithCorrelation(
        { error: "message must not be empty after sanitization" },
        { status: 400 },
        correlationId,
      );
    }

    const { config, sessionManager } = await getServices();
    const projectId = resolveProjectIdForSessionId(config, id);
    try {
      await sessionManager.send(id, message);
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/sessions/[id]/message",
        correlationId,
        startedAt,
        outcome: "success",
        statusCode: 200,
        projectId,
        sessionId: id,
        data: { messageLength: message.length },
      });
      return jsonWithCorrelation({ success: true }, { status: 200 }, correlationId);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/sessions/[id]/message",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: err instanceof SessionNotFoundError ? 404 : 500,
        projectId,
        sessionId: id,
        reason: errorMsg,
        data: { messageLength: message.length },
      });
      if (err instanceof SessionNotFoundError) {
        return jsonWithCorrelation({ error: err.message }, { status: 404 }, correlationId);
      }
      console.error("Failed to send message:", errorMsg);
      return jsonWithCorrelation(
        { error: `Failed to send message: ${errorMsg}` },
        { status: 500 },
        correlationId,
      );
    }
  } catch (error) {
    console.error("Failed to send message:", error);
    const { config } = await getServices().catch(() => ({ config: undefined }));
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/sessions/[id]/message",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        reason: error instanceof Error ? error.message : "Internal server error",
      });
    }
    return jsonWithCorrelation({ error: "Internal server error" }, { status: 500 }, correlationId);
  }
}
