import { type NextRequest } from "next/server";
import { IssueNotSpawnableError, recordActivityEvent } from "@aoagents/ao-core";
import { validateIdentifier, validateString, validateConfiguredProject } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";

/** POST /api/spawn — Spawn a new session */
export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return jsonWithCorrelation({ error: "Invalid JSON body" }, { status: 400 }, correlationId);
  }

  const projectErr = validateIdentifier(body.projectId, "projectId");
  if (projectErr) {
    return jsonWithCorrelation({ error: projectErr }, { status: 400 }, correlationId);
  }

  if (body.issueId !== undefined && body.issueId !== null) {
    const issueErr = validateIdentifier(body.issueId, "issueId");
    if (issueErr) {
      return jsonWithCorrelation({ error: issueErr }, { status: 400 }, correlationId);
    }
  }

  // Prompt validated here; sanitized (newline stripping) below after project validation
  if (body.prompt !== undefined && body.prompt !== null) {
    const promptErr = validateString(body.prompt, "prompt", 4096);
    if (promptErr) {
      return jsonWithCorrelation({ error: promptErr }, { status: 400 }, correlationId);
    }
  }

  try {
    const { config, sessionManager } = await getServices();
    const projectId = body.projectId as string;
    const projectErr = validateConfiguredProject(config.projects, projectId);
    if (projectErr) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/spawn",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 404,
        projectId,
        reason: projectErr,
        data: { issueId: body.issueId },
      });
      recordActivityEvent({
        projectId,
        source: "api",
        kind: "api.session_spawn_rejected",
        level: "warn",
        summary: `session spawn rejected: ${projectErr}`,
        data: { reason: "project_not_configured" },
      });
      return jsonWithCorrelation({ error: projectErr }, { status: 404 }, correlationId);
    }

    // Strip newlines from prompt to prevent metadata injection (key=value format uses \n as delimiter)
    const rawPrompt = (body.prompt as string) ?? undefined;
    const prompt = rawPrompt ? rawPrompt.replace(/[\r\n]/g, " ").trim() : undefined;

    const session = await sessionManager.spawn({
      projectId,
      issueId: (body.issueId as string) ?? undefined,
      prompt: prompt || undefined,
    });

    recordApiObservation({
      config,
      method: "POST",
      path: "/api/spawn",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 201,
      projectId: session.projectId,
      sessionId: session.id,
      data: { issueId: session.issueId },
    });
    recordActivityEvent({
      projectId: session.projectId,
      sessionId: session.id,
      source: "api",
      kind: "api.session_spawn_requested",
      summary: `session spawn requested for ${session.projectId}`,
      data: {
        issueId: session.issueId ?? undefined,
        hasPrompt: Boolean(prompt),
      },
    });

    return jsonWithCorrelation(
      { session: sessionToDashboard(session) },
      { status: 201 },
      correlationId,
    );
  } catch (err) {
    const { config } = await getServices().catch(() => ({ config: undefined }));
    const statusCode = err instanceof IssueNotSpawnableError ? 409 : 500;
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/spawn",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode,
        projectId: typeof body.projectId === "string" ? body.projectId : undefined,
        reason: err instanceof Error ? err.message : "Failed to spawn session",
        data: {
          issueId: body.issueId,
          ...(err instanceof IssueNotSpawnableError
            ? { reason: "issue_not_spawnable", issueState: err.state }
            : {}),
        },
      });
    }
    return jsonWithCorrelation(
      { error: err instanceof Error ? err.message : "Failed to spawn session" },
      { status: statusCode },
      correlationId,
    );
  }
}
