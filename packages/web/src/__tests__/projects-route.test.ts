import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  generateExternalId,
  loadGlobalConfig,
  registerProjectInGlobalConfig,
} from "@aoagents/ao-core";

const invalidatePortfolioServicesCache = vi.fn();

vi.mock("@/lib/services", () => ({
  invalidatePortfolioServicesCache,
}));

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3000/api/projects", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/projects", () => {
  let oldGlobalConfig: string | undefined;
  let oldConfigPath: string | undefined;
  let tempRoot: string;
  let configPath: string;

  beforeEach(() => {
    vi.resetModules();
    invalidatePortfolioServicesCache.mockReset();
    oldGlobalConfig = process.env["AO_GLOBAL_CONFIG"];
    oldConfigPath = process.env["AO_CONFIG_PATH"];
    tempRoot = mkdtempSync(path.join(tmpdir(), "ao-projects-route-"));
    configPath = path.join(tempRoot, "config.yaml");
    process.env["AO_GLOBAL_CONFIG"] = configPath;
    process.env["AO_CONFIG_PATH"] = configPath;
  });

  afterEach(() => {
    if (oldGlobalConfig === undefined) {
      delete process.env["AO_GLOBAL_CONFIG"];
    } else {
      process.env["AO_GLOBAL_CONFIG"] = oldGlobalConfig;
    }
    if (oldConfigPath === undefined) {
      delete process.env["AO_CONFIG_PATH"];
    } else {
      process.env["AO_CONFIG_PATH"] = oldConfigPath;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("returns projects as an array and includes degraded entries with resolveError", async () => {
    const healthyDir = path.join(tempRoot, "healthy");
    const brokenDir = path.join(tempRoot, "broken");
    mkdirSync(healthyDir, { recursive: true });
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, "agent-orchestrator.yaml"), "agent: [broken\n");

    const healthyId = registerProjectInGlobalConfig("healthy", "Healthy", healthyDir);
    const brokenId = registerProjectInGlobalConfig("broken", "Broken", brokenDir);

    const { GET } = await import("@/app/api/projects/route");
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projects: expect.arrayContaining([
        expect.objectContaining({ id: healthyId, name: "Healthy" }),
        expect.objectContaining({
          id: brokenId,
          name: brokenId,
          resolveError: expect.any(String),
        }),
      ]),
    });
  });

  it("reads projects from the canonical global config even when AO_CONFIG_PATH points elsewhere", async () => {
    const healthyDir = path.join(tempRoot, "healthy");
    mkdirSync(healthyDir, { recursive: true });
    const healthyId = registerProjectInGlobalConfig("healthy", "Healthy", healthyDir);

    const ambientConfigPath = path.join(tempRoot, "ambient-config.yaml");
    writeFileSync(
      ambientConfigPath,
      [
        "projects:",
        "  ambient-only:",
        '    name: "Ambient Only"',
        `    path: ${JSON.stringify(path.join(tempRoot, "ambient-only"))}`,
        '    storageKey: "ambient-only"',
        "",
      ].join("\n"),
    );
    process.env["AO_CONFIG_PATH"] = ambientConfigPath;

    const { GET } = await import("@/app/api/projects/route");
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projects: [expect.objectContaining({ id: healthyId, name: "Healthy" })],
    });
  });

  it("registers a project and invalidates services cache", async () => {
    const repoDir = path.join(tempRoot, "demo");
    mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    writeFileSync(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/trunk\n");
    mkdirSync(path.join(repoDir, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(path.join(repoDir, ".git", "refs", "remotes", "origin", "trunk"), "abc\n");
    writeFileSync(
      path.join(repoDir, ".git", "config"),
      '[remote "origin"]\n  url = git@github.com:acme/demo.git\n',
    );

    const { POST } = await import("@/app/api/projects/route");
    const response = await POST(makeRequest({ projectId: "demo", name: "Demo", path: repoDir }));

    expect(response.status).toBe(201);
    await expect(response.clone().json()).resolves.toEqual({
      ok: true,
      projectId: generateExternalId(realpathSync(repoDir), "git@github.com:acme/demo.git"),
    });
    expect(invalidatePortfolioServicesCache).toHaveBeenCalledTimes(1);

    expect(readFileSync(configPath, "utf-8").length).toBeGreaterThan(0);
    const saved = loadGlobalConfig(configPath);
    expect(
      saved?.projects[generateExternalId(realpathSync(repoDir), "git@github.com:acme/demo.git")]
        ?.defaultBranch,
    ).toBe("trunk");
  });

  it("migrates the current local config into the global registry before adding a new project", async () => {
    const currentRepoDir = path.join(tempRoot, "current");
    const addedRepoDir = path.join(tempRoot, "added");
    mkdirSync(path.join(currentRepoDir, ".git"), { recursive: true });
    mkdirSync(path.join(addedRepoDir, ".git"), { recursive: true });
    writeFileSync(
      path.join(currentRepoDir, ".git", "config"),
      '[remote "origin"]\n  url = git@github.com:acme/current.git\n',
    );
    writeFileSync(
      path.join(addedRepoDir, ".git", "config"),
      '[remote "origin"]\n  url = git@github.com:acme/added.git\n',
    );
    writeFileSync(path.join(addedRepoDir, ".git", "HEAD"), "ref: refs/heads/master\n");
    mkdirSync(path.join(addedRepoDir, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(path.join(addedRepoDir, ".git", "refs", "remotes", "origin", "master"), "abc\n");

    const localConfigPath = path.join(currentRepoDir, "agent-orchestrator.yaml");
    writeFileSync(
      localConfigPath,
      [
        "port: 3000",
        "projects:",
        "  current:",
        "    name: Current",
        `    path: ${currentRepoDir}`,
        "    defaultBranch: main",
        "    sessionPrefix: current",
        "    agent: codex",
        "",
      ].join("\n"),
    );
    process.env["AO_CONFIG_PATH"] = localConfigPath;

    const { POST } = await import("@/app/api/projects/route");
    const response = await POST(
      makeRequest({ projectId: "added", name: "Added", path: addedRepoDir }),
    );

    expect(response.status).toBe(201);
    const saved = loadGlobalConfig(configPath);
    expect(saved?.projects["current"]).toMatchObject({
      path: currentRepoDir,
      displayName: "Current",
      sessionPrefix: "current",
    });
    const addedId = generateExternalId(realpathSync(addedRepoDir), "git@github.com:acme/added.git");
    expect(saved?.projects[addedId]).toMatchObject({
      path: realpathSync(addedRepoDir),
      displayName: "Added",
      defaultBranch: "master",
    });
    expect(readFileSync(localConfigPath, "utf-8")).not.toContain("projects:");
    expect(readFileSync(localConfigPath, "utf-8")).toContain("agent: codex");
  });

  it("rejects non-repository directories", async () => {
    const repoDir = path.join(tempRoot, "downloads");
    mkdirSync(repoDir, { recursive: true });

    const { POST } = await import("@/app/api/projects/route");
    const response = await POST(
      makeRequest({ projectId: "downloads", name: "Downloads", path: repoDir }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Repository path must point to a git repository.",
    });
  });

  it("reconnects to the existing project ID when the same path is registered again", async () => {
    const repoDir = path.join(tempRoot, "demo");
    const aliasDir = path.join(tempRoot, "demo-alias");
    mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    writeFileSync(
      path.join(repoDir, ".git", "config"),
      '[remote "origin"]\n  url = git@github.com:acme/demo.git\n',
    );
    symlinkSync(repoDir, aliasDir);

    const { POST } = await import("@/app/api/projects/route");
    const firstResponse = await POST(
      makeRequest({ projectId: "existing-app", name: "Existing", path: repoDir }),
    );
    const firstBody = (await firstResponse.json()) as { projectId: string };

    const response = await POST(
      makeRequest({ projectId: "second-app", name: "Second", path: aliasDir }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      projectId: firstBody.projectId,
    });
  });

  it("registers same-basename projects with distinct hashed IDs", async () => {
    const repoA = path.join(tempRoot, "company-a", "agent-orchestrator");
    const repoB = path.join(tempRoot, "company-b", "agent-orchestrator");
    mkdirSync(path.join(repoA, ".git"), { recursive: true });
    mkdirSync(path.join(repoB, ".git"), { recursive: true });
    writeFileSync(
      path.join(repoA, ".git", "config"),
      '[remote "origin"]\n  url = git@github.com:acme/agent-orchestrator-a.git\n',
    );
    writeFileSync(
      path.join(repoB, ".git", "config"),
      '[remote "origin"]\n  url = git@github.com:acme/agent-orchestrator-b.git\n',
    );

    const { POST } = await import("@/app/api/projects/route");
    await POST(makeRequest({ projectId: "agent-orchestrator", name: "AO A", path: repoA }));

    const response = await POST(
      makeRequest({ projectId: "agent-orchestrator", name: "AO B", path: repoB }),
    );

    const idA = generateExternalId(
      realpathSync(repoA),
      "git@github.com:acme/agent-orchestrator-a.git",
    );
    const idB = generateExternalId(
      realpathSync(repoB),
      "git@github.com:acme/agent-orchestrator-b.git",
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      projectId: idB,
    });
    const saved = loadGlobalConfig(configPath);
    expect(saved?.projects[idA]).toMatchObject({
      path: realpathSync(repoA),
      displayName: "AO A",
    });
    expect(saved?.projects[idB]).toMatchObject({
      path: realpathSync(repoB),
      displayName: "AO B",
    });
  });

  it("ignores suffix allocation flags and returns the hashed project ID", async () => {
    const repoA = path.join(tempRoot, "company-a", "agent-orchestrator");
    const repoB = path.join(tempRoot, "company-b", "agent-orchestrator");
    mkdirSync(path.join(repoA, ".git"), { recursive: true });
    mkdirSync(path.join(repoB, ".git"), { recursive: true });
    writeFileSync(
      path.join(repoA, ".git", "config"),
      '[remote "origin"]\n  url = git@github.com:acme/agent-orchestrator-a.git\n',
    );
    writeFileSync(
      path.join(repoB, ".git", "config"),
      '[remote "origin"]\n  url = git@github.com:acme/agent-orchestrator-b.git\n',
    );

    const { POST } = await import("@/app/api/projects/route");
    await POST(makeRequest({ projectId: "agent-orchestrator", name: "AO A", path: repoA }));

    const response = await POST(
      makeRequest({
        projectId: "agent-orchestrator",
        name: "AO B",
        path: repoB,
        useDefaultProjectId: true,
      }),
    );

    expect(response.status).toBe(201);
    const idB = generateExternalId(
      realpathSync(repoB),
      "git@github.com:acme/agent-orchestrator-b.git",
    );
    await expect(response.json()).resolves.toMatchObject({
      projectId: idB,
    });
    const saved = loadGlobalConfig(configPath);
    expect(saved?.projects[idB]).toMatchObject({
      path: realpathSync(repoB),
      displayName: "AO B",
      sessionPrefix: "ao-1",
    });
  });
});

describe("POST /api/projects/reload", () => {
  let oldGlobalConfig: string | undefined;
  let oldConfigPath: string | undefined;
  let tempRoot: string;
  let configPath: string;

  beforeEach(() => {
    vi.resetModules();
    invalidatePortfolioServicesCache.mockReset();
    oldGlobalConfig = process.env["AO_GLOBAL_CONFIG"];
    oldConfigPath = process.env["AO_CONFIG_PATH"];
    tempRoot = mkdtempSync(path.join(tmpdir(), "ao-projects-reload-"));
    configPath = path.join(tempRoot, "config.yaml");
    process.env["AO_GLOBAL_CONFIG"] = configPath;
    process.env["AO_CONFIG_PATH"] = configPath;
  });

  afterEach(() => {
    if (oldGlobalConfig === undefined) {
      delete process.env["AO_GLOBAL_CONFIG"];
    } else {
      process.env["AO_GLOBAL_CONFIG"] = oldGlobalConfig;
    }
    if (oldConfigPath === undefined) {
      delete process.env["AO_CONFIG_PATH"];
    } else {
      process.env["AO_CONFIG_PATH"] = oldConfigPath;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("returns project and degraded counts after reload", async () => {
    const healthyDir = path.join(tempRoot, "healthy");
    const brokenDir = path.join(tempRoot, "broken");
    mkdirSync(healthyDir, { recursive: true });
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, "agent-orchestrator.yaml"), "agent: [broken\n");

    registerProjectInGlobalConfig("healthy", "Healthy", healthyDir);
    registerProjectInGlobalConfig("broken", "Broken", brokenDir);

    const { POST } = await import("@/app/api/projects/reload/route");
    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      reloaded: true,
      projectCount: 1,
      degradedCount: 1,
    });
    expect(invalidatePortfolioServicesCache).toHaveBeenCalledTimes(1);
  });

  it("reload reads counts from the canonical global config even when AO_CONFIG_PATH diverges", async () => {
    const healthyDir = path.join(tempRoot, "healthy");
    mkdirSync(healthyDir, { recursive: true });
    registerProjectInGlobalConfig("healthy", "Healthy", healthyDir);

    const ambientConfigPath = path.join(tempRoot, "ambient-config.yaml");
    writeFileSync(
      ambientConfigPath,
      [
        "projects:",
        "  ambient-only:",
        '    name: "Ambient Only"',
        `    path: ${JSON.stringify(path.join(tempRoot, "ambient-only"))}`,
        '    storageKey: "ambient-only"',
        "",
      ].join("\n"),
    );
    process.env["AO_CONFIG_PATH"] = ambientConfigPath;

    const { POST } = await import("@/app/api/projects/reload/route");
    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      reloaded: true,
      projectCount: 1,
      degradedCount: 0,
    });
  });

  it("falls back to the repo-local config when the canonical global registry does not exist yet", async () => {
    const localOnlyDir = path.join(tempRoot, "local-only");
    mkdirSync(localOnlyDir, { recursive: true });

    const localConfigPath = path.join(localOnlyDir, "agent-orchestrator.yaml");
    writeFileSync(
      localConfigPath,
      [
        "projects:",
        "  local-only:",
        '    name: "Local Only"',
        `    path: ${JSON.stringify(localOnlyDir)}`,
        '    storageKey: "local-only"',
        "",
      ].join("\n"),
    );
    process.env["AO_CONFIG_PATH"] = localConfigPath;

    const { POST } = await import("@/app/api/projects/reload/route");
    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      reloaded: true,
      projectCount: 1,
      degradedCount: 0,
    });
    expect(invalidatePortfolioServicesCache).toHaveBeenCalledTimes(1);
  });
});
