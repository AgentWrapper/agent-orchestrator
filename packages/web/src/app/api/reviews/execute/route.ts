import {
  CodeReviewRunNotExecutableError,
  CodeReviewRunNotFoundError,
  createShellCodeReviewRunner,
  executeCodeReviewRun,
  SessionNotFoundError,
} from "@aoagents/ao-core";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { getServices } from "@/lib/services";
import { validateConfiguredProject, validateIdentifier } from "@/lib/validation";

export async function POST(request: Request) {
  const correlationId = getCorrelationId(request);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return jsonWithCorrelation({ error: "Invalid JSON body" }, { status: 400 }, correlationId);
  }

  const projectIdErr = validateIdentifier(body.projectId, "projectId");
  if (projectIdErr) {
    return jsonWithCorrelation({ error: projectIdErr }, { status: 400 }, correlationId);
  }

  const runIdErr = validateIdentifier(body.runId, "runId");
  if (runIdErr) {
    return jsonWithCorrelation({ error: runIdErr }, { status: 400 }, correlationId);
  }

  try {
    const { config, sessionManager } = await getServices();
    const projectId = String(body.projectId);
    const configuredProjectErr = validateConfiguredProject(config.projects, projectId);
    if (configuredProjectErr) {
      return jsonWithCorrelation({ error: configuredProjectErr }, { status: 404 }, correlationId);
    }

    const command = process.env["AO_CODE_REVIEW_COMMAND"];
    const run = await executeCodeReviewRun(
      {
        config,
        sessionManager,
        force: body.force === true,
        ...(command ? { runReviewer: createShellCodeReviewRunner(command) } : {}),
      },
      { projectId, runId: String(body.runId) },
    );

    return jsonWithCorrelation({ run }, { status: 200 }, correlationId);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return jsonWithCorrelation({ error: error.message }, { status: 404 }, correlationId);
    }
    if (error instanceof CodeReviewRunNotFoundError) {
      return jsonWithCorrelation({ error: error.message }, { status: 404 }, correlationId);
    }
    if (error instanceof CodeReviewRunNotExecutableError) {
      return jsonWithCorrelation({ error: error.message }, { status: 409 }, correlationId);
    }

    const message = error instanceof Error ? error.message : "Failed to execute review";
    return jsonWithCorrelation({ error: message }, { status: 500 }, correlationId);
  }
}
