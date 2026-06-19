import { getServices } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { NextResponse, type NextRequest } from "next/server";

/**
 * GET /api/agents
 *
 * List registered agent plugins.
 * Returns all available agent adapters with their metadata.
 */
export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const { registry } = await getServices();

  try {
    // Get all agent plugins from the registry
    const agentPlugins = registry.list("agent");

    const agents = agentPlugins.map((plugin) => ({
      name: plugin.name,
      description: plugin.description,
      version: plugin.version,
      slot: plugin.slot,
    }));

    return jsonWithCorrelation(
      {
        agents,
        count: agents.length,
      },
      undefined,
      correlationId,
    );
  } catch (error) {
    console.error("Error in GET /api/agents:", error);

    return NextResponse.json({ error: "Failed to list agent plugins" }, { status: 500 });
  }
}
