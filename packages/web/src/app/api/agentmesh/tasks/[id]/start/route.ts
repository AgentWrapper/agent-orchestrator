import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { getServices } from "@/lib/services";
import { NextResponse, type NextRequest } from "next/server";

/**
 * POST /api/agentmesh/tasks/:id/start
 *
 * Start the builder phase for a task
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  const { id: taskId } = await params;

  try {
    const { coordinationService } = await getServices();
    await coordinationService.startBuilder(taskId);

    return jsonWithCorrelation(
      {
        taskId,
        status: "building",
        message: "Builder phase started",
      },
      undefined,
      correlationId,
    );
  } catch (error) {
    console.error("Error in POST /api/agentmesh/tasks/:id/start:", error);

    return NextResponse.json({ error: "Failed to start task" }, { status: 500 });
  }
}
