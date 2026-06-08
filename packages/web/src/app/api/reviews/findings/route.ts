import { createCodeReviewStore } from "@aoagents/ao-core";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { getServices } from "@/lib/services";
import { validateConfiguredProject, validateIdentifier } from "@/lib/validation";

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId");
  const runId = searchParams.get("runId");

  const projectIdErr = validateIdentifier(projectId, "projectId");
  if (projectIdErr) {
    return jsonWithCorrelation({ error: projectIdErr }, { status: 400 }, correlationId);
  }

  const runIdErr = validateIdentifier(runId, "runId");
  if (runIdErr) {
    return jsonWithCorrelation({ error: runIdErr }, { status: 400 }, correlationId);
  }

  try {
    const { config } = await getServices();
    const safeProjectId = String(projectId);
    const safeRunId = String(runId);
    const configuredProjectErr = validateConfiguredProject(config.projects, safeProjectId);
    if (configuredProjectErr) {
      return jsonWithCorrelation({ error: configuredProjectErr }, { status: 404 }, correlationId);
    }

    const store = createCodeReviewStore(safeProjectId);
    const run = store.getRun(safeRunId);
    if (!run) {
      return jsonWithCorrelation(
        { error: `Review run not found: ${safeRunId}` },
        { status: 404 },
        correlationId,
      );
    }

    return jsonWithCorrelation(
      {
        run,
        findings: store.listFindings({ runId: safeRunId }),
      },
      { status: 200 },
      correlationId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load review findings";
    return jsonWithCorrelation({ error: message }, { status: 500 }, correlationId);
  }
}
