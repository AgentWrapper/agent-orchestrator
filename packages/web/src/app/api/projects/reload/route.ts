import { NextResponse } from "next/server";
import { ConfigNotFoundError, getGlobalConfigPath, loadConfig } from "@aoagents/ao-core";
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

    return NextResponse.json({
      reloaded: true,
      projectCount: Object.keys(config.projects).length,
      degradedCount: Object.keys(config.degradedProjects).length,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reload projects" },
      { status: 500 },
    );
  }
}
