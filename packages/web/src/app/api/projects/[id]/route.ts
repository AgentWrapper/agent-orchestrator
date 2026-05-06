import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import {
  ConfigNotFoundError,
  LocalProjectConfigSchema,
  getProjectDir,
  getGlobalConfigPath,
  loadConfig,
  loadGlobalConfig,
  loadLocalProjectConfigDetailed,
  repairWrappedLocalProjectConfig,
  unregisterProject,
  writeLocalProjectConfig,
  type LocalProjectConfig,
} from "@aoagents/ao-core";
import { revalidatePath } from "next/cache";
import { getServices, invalidatePortfolioServicesCache } from "@/lib/services";

export const dynamic = "force-dynamic";

const IDENTITY_FIELDS = new Set(["projectId", "path", "repo", "defaultBranch"]);

function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function revalidateProjectPaths(projectId: string): void {
  for (const route of ["/", "/orchestrators", "/prs", `/projects/${projectId}`]) {
    try {
      revalidatePath(route);
    } catch {
      // Route tests do not run inside a full Next.js revalidation context.
    }
  }
}

type CleanupWorkspacePlugin = {
  list?: (projectId: string) => Promise<Array<{ path: string }>>;
  destroy?: (workspacePath: string) => Promise<void>;
};

async function cleanupManagedWorkspaces(projectId: string, workspacePluginName: string): Promise<void> {
  const { registry } = await getServices();
  const workspacePlugin = registry.get<CleanupWorkspacePlugin>("workspace", workspacePluginName);
  if (!workspacePlugin?.list || !workspacePlugin.destroy) return;

  const workspaces = await workspacePlugin.list(projectId);
  for (const workspace of workspaces) {
    await workspacePlugin.destroy(workspace.path);
  }
}

function loadProjectRouteConfig() {
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

function getProjectState(projectId: string) {
  const globalConfig = loadGlobalConfig();
  const config = loadProjectRouteConfig();
  return {
    config,
    globalEntry: globalConfig?.projects[projectId] ?? null,
    project: config.projects[projectId] ?? null,
    degradedProject: config.degradedProjects[projectId] ?? null,
  };
}

function degradedPayload(projectId: string, degradedProject: NonNullable<ReturnType<typeof getProjectState>["degradedProject"]>) {
  return {
    error: degradedProject.resolveError,
    projectId,
    degraded: true,
    project: {
      id: projectId,
      name: projectId,
      path: degradedProject.path,
      resolveError: degradedProject.resolveError,
    },
  };
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const state = getProjectState(id);
    if (!state.globalEntry && !state.project && !state.degradedProject) {
      return NextResponse.json({ error: `Unknown project: ${id}` }, { status: 404 });
    }

    if (state.degradedProject) {
      return NextResponse.json(degradedPayload(id, state.degradedProject), { status: 200 });
    }

    return NextResponse.json(
      {
        project: {
          id,
          name: state.project?.name ?? id,
          path: state.globalEntry?.path ?? state.project?.path,
          repo:
            (state.globalEntry?.repo &&
            typeof state.globalEntry.repo === "object" &&
            "owner" in state.globalEntry.repo &&
            "name" in state.globalEntry.repo
              ? `${state.globalEntry.repo.owner}/${state.globalEntry.repo.name}`
              : undefined) ?? "",
          defaultBranch: state.globalEntry?.defaultBranch ?? "main",
          agent: state.project?.agent,
          runtime: state.project?.runtime,
          tracker: state.project?.tracker,
          scm: state.project?.scm,
          reactions: state.project?.reactions,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load project" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const frozen = Object.keys(body).filter((key) => IDENTITY_FIELDS.has(key));
    if (frozen.length > 0) {
      return NextResponse.json(
        { error: `Identity fields are frozen: ${frozen.join(", ")}` },
        { status: 400 },
      );
    }

    const state = getProjectState(id);
    if (!state.globalEntry && !state.project && !state.degradedProject) {
      return NextResponse.json({ error: `Unknown project: ${id}` }, { status: 404 });
    }
    if (state.degradedProject) {
      return NextResponse.json(degradedPayload(id, state.degradedProject), { status: 409 });
    }
    const projectPath = state.globalEntry?.path;
    if (!projectPath) {
      return NextResponse.json({ error: `Project "${id}" is missing a registry path.` }, { status: 409 });
    }

    const localConfigResult = loadLocalProjectConfigDetailed(projectPath);
    if (localConfigResult.kind === "malformed" || localConfigResult.kind === "invalid") {
      return NextResponse.json({ error: localConfigResult.error }, { status: 400 });
    }
    if (localConfigResult.kind === "old-format") {
      return NextResponse.json({ error: localConfigResult.error }, { status: 400 });
    }

    const currentConfig: LocalProjectConfig = localConfigResult.kind === "loaded" ? { ...localConfigResult.config } : {};
    const nextConfig: LocalProjectConfig = {
      ...currentConfig,
    };
    const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

    if (hasOwn("agent")) {
      nextConfig.agent = sanitizeString(body["agent"]);
    }
    if (hasOwn("runtime")) {
      nextConfig.runtime = sanitizeString(body["runtime"]);
    }
    if (hasOwn("tracker")) {
      const nextTracker =
        body["tracker"] && typeof body["tracker"] === "object"
          ? ({
              ...((currentConfig.tracker as Record<string, unknown> | undefined) ?? {}),
              ...(body["tracker"] as Record<string, unknown>),
            } as LocalProjectConfig["tracker"])
          : undefined;
      nextConfig.tracker =
        nextTracker;
    }
    if (hasOwn("scm")) {
      const nextScm =
        body["scm"] && typeof body["scm"] === "object"
          ? ({
              ...((currentConfig.scm as Record<string, unknown> | undefined) ?? {}),
              ...(body["scm"] as Record<string, unknown>),
            } as LocalProjectConfig["scm"])
          : undefined;
      nextConfig.scm =
        nextScm;
    }
    if (hasOwn("reactions")) {
      nextConfig.reactions =
        body["reactions"] && typeof body["reactions"] === "object"
          ? (body["reactions"] as LocalProjectConfig["reactions"])
          : undefined;
    }

    const validated = LocalProjectConfigSchema.parse(nextConfig);
    const localConfigPath =
      "path" in localConfigResult && typeof localConfigResult.path === "string"
        ? localConfigResult.path
        : path.join(projectPath, "agent-orchestrator.yaml");
    writeLocalProjectConfig(projectPath, validated, localConfigPath);
    invalidatePortfolioServicesCache();
    revalidateProjectPaths(id);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update project" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return PATCH(request, context);
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const state = getProjectState(id);
    if (!state.globalEntry && !state.project && !state.degradedProject) {
      return NextResponse.json({ error: `Unknown project: ${id}` }, { status: 404 });
    }

    // Validate the project ID against V2 storage path rules BEFORE handing
    // it to any plugin. A malformed ID (path traversal, illegal characters)
    // must never reach `cleanupManagedWorkspaces`, which calls plugin code
    // that may resolve paths under the project directory.
    let projectDir: string;
    try {
      projectDir = getProjectDir(id);
    } catch {
      return NextResponse.json({ error: `Invalid project ID: ${id}` }, { status: 400 });
    }

    const workspacePluginName = state.project?.workspace ?? state.config.defaults.workspace ?? "worktree";
    await cleanupManagedWorkspaces(id, workspacePluginName);

    const hadStorageDir = existsSync(projectDir);
    if (hadStorageDir) {
      rmSync(projectDir, { recursive: true, force: true });
    }
    unregisterProject(id);
    invalidatePortfolioServicesCache();
    revalidateProjectPaths(id);

    return NextResponse.json({
      ok: true,
      projectId: id,
      removedStorageDir: hadStorageDir,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete project" },
      { status: 500 },
    );
  }
}

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const state = getProjectState(id);
    if (!state.globalEntry && !state.project && !state.degradedProject) {
      return NextResponse.json({ error: `Unknown project: ${id}` }, { status: 404 });
    }
    if (!state.degradedProject) {
      return NextResponse.json({ error: "Project does not need repair." }, { status: 400 });
    }

    const isWrappedConfigError = state.degradedProject.resolveError.includes("wrapped projects: format");
    if (!isWrappedConfigError) {
      return NextResponse.json(
        { error: "Automatic repair is not available for this degraded config." },
        { status: 400 },
      );
    }

    repairWrappedLocalProjectConfig(id, state.degradedProject.path);
    invalidatePortfolioServicesCache();
    revalidateProjectPaths(id);

    return NextResponse.json({ ok: true, repaired: true, projectId: id });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to repair project" },
      { status: 500 },
    );
  }
}
