import { NextResponse } from "next/server";
import {
  ConfigNotFoundError,
  getGlobalConfigPath,
  loadConfig,
  recordActivityEvent,
} from "@aoagents/ao-core";
import { invalidatePortfolioServicesCache } from "@/lib/services";

export const dynamic = "force-dynamic";

function loadReloadConfig() {
  const globalConfigPath = getGlobalConfigPath();

  try {
    return loadConfig(globalConfigPath);
  } catch (error) {
    if (error instanceof ConfigNotFoundError) {
      return loadConfig();
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return loadConfig();
    }
    throw error;
  }
}

export async function POST() {
  try {
    invalidatePortfolioServicesCache();
    const config = loadReloadConfig();

    const projectCount = Object.keys(config.projects).length;
    const degradedCount = Object.keys(config.degradedProjects).length;
    recordActivityEvent({
      source: "api",
      kind: "api.config_reloaded",
      summary: `config reloaded: ${projectCount} projects, ${degradedCount} degraded`,
      data: { projectCount, degradedCount },
    });

    return NextResponse.json({
      reloaded: true,
      projectCount,
      degradedCount,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reload projects" },
      { status: 500 },
    );
  }
}
