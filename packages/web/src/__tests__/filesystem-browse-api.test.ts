import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as browseGET } from "@/app/api/filesystem/browse/route";
import { GET as legacyBrowseGET } from "@/app/api/browse-directory/route";

function makeRequest(rawUrl: string): NextRequest {
  return new NextRequest(new URL(rawUrl, "http://localhost:3000"));
}

describe("/api/filesystem/browse", () => {
  let originalHome: string | undefined;
  let homeDir: string;
  let outsideDir: string;

  beforeEach(() => {
    originalHome = process.env["HOME"];
    homeDir = mkdtempSync(path.join(tmpdir(), "ao-home-"));
    outsideDir = mkdtempSync(path.join(tmpdir(), "ao-outside-"));
    process.env["HOME"] = homeDir;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }

    rmSync(homeDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("browses HOME without requiring an environment flag", async () => {
    const response = await browseGET(makeRequest("/api/filesystem/browse?path=~"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ entries: [] });
  });

  it("returns 400 when the requested path contains ..", async () => {
    const response = await browseGET(
      makeRequest("/api/filesystem/browse?path=projects/../secrets"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "path outside allowed root" });
  });

  it("returns 400 for an absolute path outside HOME", async () => {
    const response = await browseGET(makeRequest("/api/filesystem/browse?path=/etc"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "path outside allowed root" });
  });

  it("returns 400 for a symlink inside HOME that points outside", async () => {
    const outsideRepo = path.join(outsideDir, "external-repo");
    mkdirSync(outsideRepo);
    symlinkSync(outsideRepo, path.join(homeDir, "external-link"));

    const response = await browseGET(makeRequest("/api/filesystem/browse?path=~/external-link"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "path outside allowed root" });
  });

  it("returns 400 for a restricted path inside HOME", async () => {
    mkdirSync(path.join(homeDir, ".ssh"));

    const response = await browseGET(makeRequest("/api/filesystem/browse?path=~/.ssh"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "path is restricted" });
  });

  it("returns minimal metadata only for a valid path inside HOME", async () => {
    const repoDir = path.join(homeDir, "repo");
    const plainDir = path.join(homeDir, "notes");
    const filePath = path.join(homeDir, "README.md");
    const hiddenDir = path.join(homeDir, ".agents");
    const hiddenFile = path.join(homeDir, ".env");

    mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    writeFileSync(path.join(repoDir, "agent-orchestrator.yaml"), "defaults: {}\n");
    mkdirSync(plainDir);
    writeFileSync(filePath, "# hi\n");
    mkdirSync(hiddenDir);
    writeFileSync(hiddenFile, "SECRET=1\n");
    mkdirSync(path.join(homeDir, ".aws"));

    const response = await browseGET(makeRequest("/api/filesystem/browse?path=~"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entries: Array<Record<string, unknown>>;
    };

    expect(body).toEqual({
      entries: [
        {
          name: "notes",
          isDirectory: true,
          isGitRepo: false,
          hasLocalConfig: false,
        },
        {
          name: "repo",
          isDirectory: true,
          isGitRepo: true,
          hasLocalConfig: true,
        },
        {
          name: "README.md",
          isDirectory: false,
          isGitRepo: false,
          hasLocalConfig: false,
        },
      ],
    });

    for (const entry of body.entries) {
      expect(entry).not.toHaveProperty("size");
      expect(entry).not.toHaveProperty("mtime");
      expect(entry).not.toHaveProperty("mode");
      expect(entry).not.toHaveProperty("target");
      expect(entry).not.toHaveProperty("symlinkTarget");
      expect(Object.keys(entry).sort()).toEqual([
        "hasLocalConfig",
        "isDirectory",
        "isGitRepo",
        "name",
      ]);
    }

    expect(body.entries.map((entry) => entry.name)).not.toContain(".agents");
    expect(body.entries.map((entry) => entry.name)).not.toContain(".env");
  });

  it("redirects the legacy browse endpoint to the new route", async () => {
    const response = await legacyBrowseGET(makeRequest("/api/browse-directory?path=~/repo"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/api/filesystem/browse?path=~/repo",
    );
  });
});
