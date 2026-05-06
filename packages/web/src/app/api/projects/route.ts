import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import {
  detectDefaultBranchFromDir,
  generateExternalId,
  getGlobalConfigPath,
  loadConfig,
  migrateToGlobalConfig,
  registerProjectInGlobalConfig,
} from "@aoagents/ao-core";
import { revalidatePath } from "next/cache";
import { getAllProjects } from "@/lib/project-name";
import { invalidatePortfolioServicesCache } from "@/lib/services";

export const dynamic = "force-dynamic";

function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function expandHomePath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

function isGitRepository(projectPath: string): boolean {
  return existsSync(join(projectPath, ".git"));
}

function revalidatePortfolioPaths(projectId: string): void {
  for (const route of ["/", "/orchestrators", "/prs", `/projects/${projectId}`]) {
    try {
      revalidatePath(route);
    } catch {
      // Route tests do not run inside a full Next.js revalidation context.
    }
  }
}

function buildSeedLocalConfig(projectPath: string): { defaultBranch: string } {
  const defaultBranch = detectDefaultBranchFromDir(projectPath);
  return { defaultBranch };
}

function seedGlobalRegistryFromCurrentConfig(): void {
  const globalConfigPath = getGlobalConfigPath();
  if (existsSync(globalConfigPath)) {
    return;
  }

  try {
    const config = loadConfig();
    if (resolve(config.configPath) === resolve(globalConfigPath)) {
      return;
    }

    migrateToGlobalConfig(config.configPath, globalConfigPath);
  } catch {
    // If there is no current config, or it is already flat/non-migratable,
    // continue and let the new project create the canonical registry directly.
  }
}

export async function GET() {
  try {
    const projects = getAllProjects();
    return NextResponse.json({ projects });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load projects" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawPath = sanitizeString(body["path"]);
  if (!rawPath) {
    return NextResponse.json({ error: "Repository path is required." }, { status: 400 });
  }
  const resolvedPath = resolve(expandHomePath(rawPath));
  const projectId = sanitizeString(body["projectId"]) ?? (basename(resolvedPath) || "project");
  const name = sanitizeString(body["name"]) ?? (basename(resolvedPath) || projectId);
  if (!isGitRepository(resolvedPath)) {
    return NextResponse.json(
      { error: "Repository path must point to a git repository." },
      { status: 400 },
    );
  }

  try {
    seedGlobalRegistryFromCurrentConfig();
    const registeredProjectId = registerProjectInGlobalConfig(
      projectId,
      name ?? projectId,
      resolvedPath,
      buildSeedLocalConfig(resolvedPath),
    );
    invalidatePortfolioServicesCache();
    revalidatePortfolioPaths(registeredProjectId);
    return NextResponse.json({ ok: true, projectId: registeredProjectId }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add project";

    // Detect project collision errors and return a structured 409 so the
    // AddProjectModal can display the collision UI (open existing / use suggested ID).
    const pathAlreadyRegistered = message.match(
      /^Project "([^"]+)" is already registered at/,
    );
    const idAlreadyRegistered = message.match(
      /^Project id "([^"]+)" is already registered for/,
    );

    if (pathAlreadyRegistered) {
      const existingProjectId = pathAlreadyRegistered[1];
      const suggestedProjectId = generateExternalId(resolvedPath);
      return NextResponse.json(
        {
          error: message,
          existingProjectId,
          suggestedProjectId,
          suggestion: "choose-project-id" as const,
        },
        { status: 409 },
      );
    }

    if (idAlreadyRegistered) {
      const existingProjectId = idAlreadyRegistered[1];
      const suggestedProjectId = generateExternalId(resolvedPath);
      return NextResponse.json(
        {
          error: message,
          existingProjectId,
          suggestedProjectId,
          suggestion: "choose-project-id" as const,
        },
        { status: 409 },
      );
    }

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
