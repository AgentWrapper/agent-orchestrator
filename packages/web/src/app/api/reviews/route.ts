import {
  CodeReviewInvalidSessionError,
  SessionNotFoundError,
  triggerCodeReviewForSession,
} from "@aoagents/ao-core";
import { getReviewPageData, resolveReviewProjectFilter } from "@/lib/review-page-data";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { getServices } from "@/lib/services";
import { stripControlChars, validateIdentifier, validateString } from "@/lib/validation";

const MAX_REVIEW_SUMMARY_LENGTH = 2_000;

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const { searchParams } = new URL(request.url);
  const projectFilter = resolveReviewProjectFilter(searchParams.get("project") ?? undefined);
  const pageData = await getReviewPageData(projectFilter);

  if (pageData.dashboardLoadError) {
    return jsonWithCorrelation(
      {
        error: pageData.dashboardLoadError,
        runs: pageData.runs,
      },
      { status: 500 },
      correlationId,
    );
  }

  return jsonWithCorrelation(
    {
      runs: pageData.runs,
      workerOptions: pageData.workerOptions,
      orchestrators: pageData.orchestrators,
      projectName: pageData.projectName,
      selectedProjectId: pageData.selectedProjectId ?? null,
    },
    { status: 200 },
    correlationId,
  );
}

export async function POST(request: Request) {
  const correlationId = getCorrelationId(request);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return jsonWithCorrelation({ error: "Invalid JSON body" }, { status: 400 }, correlationId);
  }

  const sessionIdErr = validateIdentifier(body.sessionId, "sessionId");
  if (sessionIdErr) {
    return jsonWithCorrelation({ error: sessionIdErr }, { status: 400 }, correlationId);
  }

  let summary: string | undefined;
  if (body.summary !== undefined) {
    const summaryErr = validateString(body.summary, "summary", MAX_REVIEW_SUMMARY_LENGTH);
    if (summaryErr) {
      return jsonWithCorrelation({ error: summaryErr }, { status: 400 }, correlationId);
    }
    summary = stripControlChars(String(body.summary));
  }

  try {
    const { config, sessionManager } = await getServices();
    const run = await triggerCodeReviewForSession(
      { config, sessionManager },
      {
        sessionId: String(body.sessionId),
        requestedBy: "web",
        summary,
      },
    );

    return jsonWithCorrelation({ run }, { status: 201 }, correlationId);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return jsonWithCorrelation({ error: error.message }, { status: 404 }, correlationId);
    }
    if (error instanceof CodeReviewInvalidSessionError) {
      return jsonWithCorrelation({ error: error.message }, { status: 400 }, correlationId);
    }

    const message = error instanceof Error ? error.message : "Failed to request review";
    return jsonWithCorrelation({ error: message }, { status: 500 }, correlationId);
  }
}
