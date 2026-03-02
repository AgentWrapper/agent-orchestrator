import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

/** GET /api/config/projects — Return the list of configured projects */
export async function GET() {
  try {
    const { config } = await getServices();
    const projects = Object.entries(config.projects).map(([id, project]) => ({
      id,
      name: project.name,
    }));
    return NextResponse.json({ projects });
  } catch {
    return NextResponse.json({ projects: [] });
  }
}
