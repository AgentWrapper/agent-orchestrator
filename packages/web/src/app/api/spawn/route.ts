import { type NextRequest } from "next/server";
import { validateIdentifier, validateString, validateConfiguredProject } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";
import type { BasePromptMode } from "@aoagents/ao-core";

const VALID_BASE_PROMPT_MODES = ["default", "planning", "custom"] as const;

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

  // Validate agent
  if (body.agent !== undefined && body.agent !== null) {
    if (typeof body.agent !== "string" || body.agent.trim().length === 0) {
      return jsonWithCorrelation(
        { error: "agent must be a non-empty string" },
        { status: 400 },
        correlationId,
      );
    }
  }

  // Validate basePromptMode
  if (body.basePromptMode !== undefined && body.basePromptMode !== null) {
    if (!VALID_BASE_PROMPT_MODES.includes(body.basePromptMode as BasePromptMode)) {
      return jsonWithCorrelation(
        { error: "basePromptMode must be one of: default, planning, custom" },
        { status: 400 },
        correlationId,
      );
    }
  }

  // Validate basePromptCustom (required when mode is "custom")
  const basePromptMode = (body.basePromptMode as BasePromptMode) ?? undefined;
  if (basePromptMode === "custom") {
    if (
      !body.basePromptCustom ||
      typeof body.basePromptCustom !== "string" ||
      body.basePromptCustom.trim().length === 0
    ) {
      return jsonWithCorrelation(
        { error: "basePromptCustom is required when basePromptMode is custom" },
        { status: 400 },
        correlationId,
      );
    }
    if (body.basePromptCustom.length > 8192) {
      return jsonWithCorrelation(
        { error: "basePromptCustom must be at most 8192 characters" },
        { status: 400 },
        correlationId,
      );
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
      return jsonWithCorrelation({ error: projectErr }, { status: 404 }, correlationId);
    }

    // Strip newlines from prompt to prevent metadata injection (key=value format uses \n as delimiter)
    const rawPrompt = (body.prompt as string) ?? undefined;
    const prompt = rawPrompt ? rawPrompt.replace(/[\r\n]/g, " ").trim() : undefined;

    // Sanitize basePromptCustom: preserve \n \r \t, strip other C0 control chars
    const rawCustom =
      typeof body.basePromptCustom === "string" ? body.basePromptCustom : undefined;
    // Strip C0 control chars (except \t \n \r) and DEL using charCode filtering
    const basePromptCustom = rawCustom
      ? [...rawCustom]
          .filter((ch) => {
            const code = ch.charCodeAt(0);
            return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
          })
          .join("")
          .trim()
      : undefined;

    const agent = typeof body.agent === "string" ? body.agent.trim() || undefined : undefined;

    const session = await sessionManager.spawn({
      projectId,
      issueId: (body.issueId as string) ?? undefined,
      prompt: prompt || undefined,
      agent,
      basePromptMode,
      basePromptCustom: basePromptCustom || undefined,
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

    return jsonWithCorrelation(
      { session: sessionToDashboard(session) },
      { status: 201 },
      correlationId,
    );
  } catch (err) {
    const { config } = await getServices().catch(() => ({ config: undefined }));
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/spawn",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId: typeof body.projectId === "string" ? body.projectId : undefined,
        reason: err instanceof Error ? err.message : "Failed to spawn session",
        data: { issueId: body.issueId },
      });
    }
    return jsonWithCorrelation(
      { error: err instanceof Error ? err.message : "Failed to spawn session" },
      { status: 500 },
      correlationId,
    );
  }
}
