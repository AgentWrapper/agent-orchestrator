import { type NextRequest } from "next/server";
import { queryActivityEvents } from "@aoagents/ao-core";
import { getServices } from "@/lib/services";
import { validateIdentifier } from "@/lib/validation";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";
import type { DashboardActivityEvent } from "@/lib/types";

const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 200;

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(parsed, MAX_LIMIT));
}

function parseEventData(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }

  try {
    const { searchParams } = new URL(request.url);
    const limit = parseLimit(searchParams.get("limit"));
    const { config, sessionManager } = await getServices();
    const session = await sessionManager.get(id);
    if (!session) {
      return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);
    }

    const events: DashboardActivityEvent[] = queryActivityEvents({
      projectId: session.projectId,
      sessionId: id,
      limit,
    }).map((event) => ({
      id: event.id,
      ts: event.ts,
      tsEpoch: event.tsEpoch,
      projectId: event.projectId,
      sessionId: event.sessionId,
      source: event.source,
      kind: event.kind,
      level: event.level,
      summary: event.summary,
      data: parseEventData(event.data),
    }));

    recordApiObservation({
      config,
      method: "GET",
      path: "/api/sessions/[id]/events",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId: session.projectId,
      sessionId: id,
      data: { eventCount: events.length, limit },
    });

    return jsonWithCorrelation({ events }, { status: 200 }, correlationId);
  } catch (error) {
    const { config, sessionManager } = await getServices().catch(() => ({
      config: undefined,
      sessionManager: undefined,
    }));
    const session = sessionManager ? await sessionManager.get(id).catch(() => null) : null;
    if (config) {
      recordApiObservation({
        config,
        method: "GET",
        path: "/api/sessions/[id]/events",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId: session?.projectId,
        sessionId: id,
        reason: error instanceof Error ? error.message : "Failed to load session events",
      });
    }
    return jsonWithCorrelation(
      { error: "Failed to load session events" },
      { status: 500 },
      correlationId,
    );
  }
}
