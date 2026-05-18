import { type NextRequest, NextResponse } from "next/server";
import { generateOrchestratorPrompt, recordActivityEvent } from "@aoagents/ao-core";
import { getServices } from "@/lib/services";
import { validateIdentifier, validateConfiguredProject } from "@/lib/validation";

function classifySpawnError(
  projectId: string,
  error: unknown,
): {
  status: number;
  payload: Record<string, unknown>;
} {
  const message = error instanceof Error ? error.message : "Failed to spawn orchestrator";

  if (
    message.includes("already exists and is still registered with git") ||
    message.includes("outside AO-managed worktree directories") ||
    message.includes('Found multiple worktrees for orchestrator branch "')
  ) {
    return {
      status: 409,
      payload: {
        error: [
          `AO found an older orchestrator workspace for "${projectId}" but could not safely reuse it automatically.`,
          "Your repository is safe.",
          "Review the existing workspace, then either reuse it manually or remove it and create a fresh orchestrator workspace.",
        ].join(" "),
        code: "orchestrator_workspace_conflict",
        recovery: "reuse-or-recreate-workspace",
      },
    };
  }

  return {
    status: 500,
    payload: { error: message },
  };
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectErr = validateIdentifier(body.projectId, "projectId");
  if (projectErr) {
    return NextResponse.json({ error: projectErr }, { status: 400 });
  }

  const clean = body.clean === true;

  try {
    const { config, sessionManager } = await getServices();
    const projectId = body.projectId as string;
    const configProjectErr = validateConfiguredProject(config.projects, projectId);
    if (configProjectErr) {
      return NextResponse.json({ error: configProjectErr }, { status: 404 });
    }
    const project = config.projects[projectId];

    const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
    const session = clean
      ? await sessionManager.relaunchOrchestrator({ projectId, systemPrompt })
      : await sessionManager.spawnOrchestrator({ projectId, systemPrompt });

    recordActivityEvent({
      projectId,
      sessionId: session.id,
      source: "api",
      kind: "api.orchestrator_spawn_requested",
      summary: `orchestrator spawn requested for ${projectId}`,
    });

    return NextResponse.json(
      {
        orchestrator: {
          id: session.id,
          projectId,
          projectName: project.name,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    const classified = classifySpawnError(body.projectId as string, err);
    return NextResponse.json(classified.payload, { status: classified.status });
  }
}
