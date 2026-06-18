import { type NextRequest } from "next/server";
import { recordActivityEvent, type OrchestratorConfig } from "@aoagents/ao-core";
import { getServices, getSCM } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";

/** POST /api/prs/:id/merge — Merge a PR */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const startedAt = Date.now();
  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return jsonWithCorrelation({ error: "Invalid PR number" }, { status: 400 }, correlationId);
  }
  const prNumber = Number(id);
  const owner = _request.nextUrl.searchParams.get("owner") ?? undefined;
  const repo = _request.nextUrl.searchParams.get("repo") ?? undefined;

  const prMatches = (p: { number: number; owner?: string; repo?: string }) =>
    p.number === prNumber &&
    (!owner || p.owner?.toLowerCase() === owner.toLowerCase()) &&
    (!repo || p.repo?.toLowerCase() === repo.toLowerCase());

  let configForObservation: OrchestratorConfig | undefined;
  let projectId: string | undefined;
  let sessionId: string | undefined;

  try {
    const { config, registry, sessionManager } = await getServices();
    configForObservation = config;
    const sessions = await sessionManager.list();

    const session = sessions.find(
      (s) => (s.pr && prMatches(s.pr)) || (s.prs ?? []).some(prMatches),
    );
    const targetPR =
      session?.pr && prMatches(session.pr) ? session.pr : (session?.prs ?? []).find(prMatches);
    if (!session || !targetPR) {
      return jsonWithCorrelation({ error: "PR not found" }, { status: 404 }, correlationId);
    }
    projectId = session.projectId;
    sessionId = session.id;

    const project = config.projects[session.projectId];
    const scm = getSCM(registry, project);
    if (!scm) {
      return jsonWithCorrelation(
        { error: "No SCM plugin configured for this project" },
        { status: 500 },
        correlationId,
      );
    }

    // Validate PR is in a mergeable state
    const state = await scm.getPRState(targetPR);
    if (state !== "open") {
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "api",
        kind: "api.pr_merge_rejected",
        level: "warn",
        summary: `PR ${prNumber} merge rejected: state is ${state}`,
        data: { prNumber, prState: state, statusCode: 409 },
      });
      return jsonWithCorrelation(
        { error: `PR is ${state}, not open` },
        { status: 409 },
        correlationId,
      );
    }

    const mergeability = await scm.getMergeability(targetPR);
    if (!mergeability.mergeable) {
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "api",
        kind: "api.pr_merge_rejected",
        level: "warn",
        summary: `PR ${prNumber} merge rejected: not mergeable`,
        data: { prNumber, blockers: mergeability.blockers, statusCode: 422 },
      });
      return jsonWithCorrelation(
        { error: "PR is not mergeable", blockers: mergeability.blockers },
        { status: 422 },
        correlationId,
      );
    }

    await scm.mergePR(targetPR, "squash");
    recordApiObservation({
      config,
      method: "POST",
      path: "/api/prs/[id]/merge",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId: session.projectId,
      sessionId: session.id,
      data: { prNumber },
    });
    recordActivityEvent({
      projectId: session.projectId,
      sessionId: session.id,
      source: "api",
      kind: "api.pr_merge_requested",
      summary: `PR ${prNumber} merge requested`,
      data: { prNumber, method: "squash" },
    });
    return jsonWithCorrelation(
      { ok: true, prNumber, method: "squash" },
      { status: 200 },
      correlationId,
    );
  } catch (err) {
    const config =
      configForObservation ?? (await getServices().catch(() => ({ config: undefined }))).config;
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/prs/[id]/merge",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId,
        sessionId,
        reason: err instanceof Error ? err.message : "Failed to merge PR",
        data: { prNumber },
      });
    }
    const reason = err instanceof Error ? err.message : "Failed to merge PR";
    recordActivityEvent({
      projectId,
      sessionId,
      source: "api",
      kind: "api.pr_merge_failed",
      level: "error",
      summary: `PR ${prNumber} merge failed: ${reason}`,
      data: { prNumber, reason },
    });
    return jsonWithCorrelation(
      { error: err instanceof Error ? err.message : "Failed to merge PR" },
      { status: 500 },
      correlationId,
    );
  }
}
