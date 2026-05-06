import { type NextRequest, NextResponse } from "next/server";
import { getVerifyIssues, getServices } from "@/lib/services";
import { validateConfiguredProject } from "@/lib/validation";
import type { Tracker } from "@aoagents/ao-core";

export const dynamic = "force-dynamic";

/**
 * GET /api/verify — List issues with `merged-unverified` label
 */
export async function GET() {
  try {
    const issues = await getVerifyIssues();
    return NextResponse.json({ issues });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch verify issues" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/verify — Verify or fail an issue
 * Body: { issueId: string, projectId: string, action: "verify" | "fail", comment?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as
      | {
          issueId?: string;
          projectId?: string;
          action?: "verify" | "fail";
          comment?: string;
        }
      | null;
    if (!body) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const { issueId, projectId, action, comment } = body as {
      issueId: string;
      projectId: string;
      action: "verify" | "fail";
      comment?: string;
    };

    if (!issueId || !projectId || !action) {
      return NextResponse.json(
        { error: "Missing required fields: issueId, projectId, action" },
        { status: 400 },
      );
    }

    if (action !== "verify" && action !== "fail") {
      return NextResponse.json(
        { error: 'action must be "verify" or "fail"' },
        { status: 400 },
      );
    }

    const { config, registry } = await getServices();
    const projectErr = validateConfiguredProject(config.projects, projectId);
    if (projectErr) {
      return NextResponse.json({ error: projectErr }, { status: 404 });
    }
    const project = config.projects[projectId];
    if (!project.tracker?.plugin) {
      return NextResponse.json({ error: `Project ${projectId} has no tracker` }, { status: 422 });
    }

    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker?.updateIssue) {
      return NextResponse.json({ error: "Tracker does not support updateIssue" }, { status: 500 });
    }

    if (action === "verify") {
      await tracker.updateIssue(
        issueId,
        {
          state: "closed",
          labels: ["verified", "agent:done"],
          removeLabels: ["merged-unverified"],
          comment: comment || "Verified — fix confirmed on staging.",
        },
        project,
      );
    } else {
      await tracker.updateIssue(
        issueId,
        {
          labels: ["verification-failed"],
          removeLabels: ["merged-unverified"],
          comment: comment || "Verification failed — problem persists on staging.",
        },
        project,
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update issue" },
      { status: 500 },
    );
  }
}
