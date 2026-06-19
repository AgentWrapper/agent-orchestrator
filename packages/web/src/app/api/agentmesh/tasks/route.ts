import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { getServices } from "@/lib/services";
import { NextResponse, type NextRequest } from "next/server";

function slugifyBranchSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function resolveTaskBranch(input: {
  title: string;
  issueId?: string;
  requestedBranch?: string;
  defaultBranch: string;
}): string {
  const requestedBranch = input.requestedBranch?.trim();
  if (requestedBranch && requestedBranch !== input.defaultBranch) {
    return requestedBranch;
  }

  const stem = slugifyBranchSegment(input.issueId ?? input.title) || "task";
  return `task/${stem}-${Date.now().toString(36)}`;
}

/**
 * GET /api/agentmesh/tasks
 *
 * List all AgentMesh tasks
 */
export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);

  try {
    const { coordinationService } = await getServices();
    const tasks = coordinationService.listTasks();

    return jsonWithCorrelation(
      {
        tasks,
        count: tasks.length,
      },
      undefined,
      correlationId,
    );
  } catch (error) {
    console.error("Error in GET /api/agentmesh/tasks:", error);

    return NextResponse.json({ error: "Failed to list tasks" }, { status: 500 });
  }
}

/**
 * POST /api/agentmesh/tasks
 *
 * Create a new AgentMesh task
 */
export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);

  try {
    const body = await request.json();
    const { title, description, role, priority, projectId, branch, issueId } = body;
    const { config, coordinationService } = await getServices();
    const resolvedProjectId = projectId || "default";
    const defaultBranch = config.projects[resolvedProjectId]?.defaultBranch || "main";

    const task = await coordinationService.createTask({
      title,
      description: description || "",
      role: role || "builder",
      priority: priority || "medium",
      projectId: resolvedProjectId,
      branch: resolveTaskBranch({
        title,
        issueId,
        requestedBranch: branch,
        defaultBranch,
      }),
      issueId,
    });

    return jsonWithCorrelation(task, undefined, correlationId);
  } catch (error) {
    console.error("Error in POST /api/agentmesh/tasks:", error);

    return NextResponse.json({ error: "Failed to create task" }, { status: 500 });
  }
}
