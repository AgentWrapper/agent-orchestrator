import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { getServices } from "@/lib/services";
import { NextResponse, type NextRequest } from "next/server";

/**
 * GET /api/agentmesh/tasks/:id
 *
 * Get details for a specific task
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  const { id: taskId } = await params;

  try {
    const { coordinationService } = await getServices();
    const task = coordinationService.getTask(taskId);

    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    return jsonWithCorrelation(task, undefined, correlationId);
  } catch (error) {
    console.error("Error in GET /api/agentmesh/tasks/:id:", error);

    return NextResponse.json({ error: "Failed to get task" }, { status: 500 });
  }
}

/**
 * DELETE /api/agentmesh/tasks/:id
 *
 * Delete a task
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const correlationId = getCorrelationId(request);
  const { id: taskId } = await params;

  try {
    const { coordinationService } = await getServices();
    coordinationService.deleteTask(taskId);

    return jsonWithCorrelation(
      {
        taskId,
        message: "Task deleted",
      },
      undefined,
      correlationId,
    );
  } catch (error) {
    console.error("Error in DELETE /api/agentmesh/tasks/:id:", error);

    return NextResponse.json({ error: "Failed to delete task" }, { status: 500 });
  }
}
