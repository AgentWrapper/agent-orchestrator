import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — Health check endpoint
 *
 * Returns 200 when the server is running and core services are available.
 * Returns 503 when services fail to initialize.
 */
export async function GET() {
  try {
    const { config } = await getServices();
    const projectCount = Object.keys(config.projects).length;

    return NextResponse.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      projects: projectCount,
    });
  } catch (err) {
    return NextResponse.json(
      {
        status: "error",
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : "Services unavailable",
      },
      { status: 503 },
    );
  }
}
