import "server-only";

import {
  createCorrelationId,
  createProjectObserver,
  readObservabilitySummary,
  resolveProjectIdForSessionId,
  type OrchestratorConfig,
  type ObservabilitySummary,
} from "@aoagents/ao-core";
import { NextResponse } from "next/server";

let webApiObserver: ReturnType<typeof createProjectObserver> | null | undefined;

interface ApiObservationInput {
  config: OrchestratorConfig;
  method: string;
  path: string;
  correlationId: string;
  projectId?: string;
  sessionId?: string;
  startedAt: number;
  outcome: "success" | "failure";
  statusCode: number;
  reason?: string;
  data?: Record<string, unknown>;
}

export function getCorrelationId(request?: Request): string {
  const headerValue = request?.headers.get("x-correlation-id")?.trim();
  return headerValue && headerValue.length > 0 ? headerValue : createCorrelationId("api");
}

export function jsonWithCorrelation(
  body: unknown,
  init: ResponseInit | undefined,
  correlationId: string,
): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("x-correlation-id", correlationId);
  return response;
}

export function recordApiObservation(input: ApiObservationInput): void {
  try {
    if (webApiObserver === undefined) {
      webApiObserver = createProjectObserver(input.config, "web-api");
    }
    if (!webApiObserver) {
      return;
    }

    const projectId = input.projectId ?? Object.keys(input.config.projects)[0];

    webApiObserver.recordOperation({
      metric: "api_request",
      operation: `${input.method} ${input.path}`,
      outcome: input.outcome,
      correlationId: input.correlationId,
      projectId,
      sessionId: input.sessionId,
      reason: input.reason,
      durationMs: Date.now() - input.startedAt,
      path: input.path,
      data: {
        method: input.method,
        statusCode: input.statusCode,
        ...input.data,
      },
      level: input.outcome === "failure" ? "error" : "info",
    });
  } catch {
    webApiObserver = null;
  }
}

export { resolveProjectIdForSessionId };

export function getObservabilitySummary(config: OrchestratorConfig): ObservabilitySummary {
  try {
    return readObservabilitySummary(config);
  } catch {
    return {
      generatedAt: new Date().toISOString(),
      overallStatus: "warn",
      projects: {},
    };
  }
}
