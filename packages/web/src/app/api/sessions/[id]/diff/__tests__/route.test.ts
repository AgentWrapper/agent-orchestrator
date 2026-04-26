import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

const WORKSPACE = "/fake/workspace";

vi.mock("@/lib/observability", () => ({
  getCorrelationId: vi.fn(() => "test-correlation-id"),
  jsonWithCorrelation: vi.fn(
    (data: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      json: async () => data,
      headers: new Headers(init?.headers ?? {}),
    })
  ),
}));

vi.mock("@/app/api/sessions/[id]/_fs", () => ({
  readFileSync: vi.fn(),
  statSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
  readdirSync: vi.fn(),
}));
vi.mock("@/app/api/sessions/[id]/_child-process", () => ({ spawnSync: vi.fn(), execSync: vi.fn() }));
vi.mock("@/app/api/sessions/[id]/_crypto", () => ({
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => "abcdef1234567890"),
  })),
}));

vi.mock("@/app/api/sessions/[id]/_workspace", () => ({
  resolveWorkspace: vi.fn(async (id: string) =>
    id === "test-session"
      ? { ok: true, realRoot: WORKSPACE }
      : { ok: false, reason: "not_found" }
  ),
  resolveWorkspaceFile: vi.fn((root: string, rel: string) => {
    const full = join(root, rel);
    const sep = root.endsWith("/") ? root : root + "/";
    if (full !== root && !full.startsWith(sep)) return null;
    return { fullPath: full, exists: true };
  }),
  resolveBaseRef: vi.fn(() => ({ baseRef: "origin/main", mergeBase: "abc123deadbeef" })),
}));

import { readFileSync, statSync } from "@/app/api/sessions/[id]/_fs";
import { spawnSync } from "@/app/api/sessions/[id]/_child-process";
import { GET } from "../[...path]/route";

function makeRequest(etag?: string, scope?: "local" | "branch") {
  const headers = new Headers();
  if (etag) headers.set("if-none-match", etag);
  const url = scope ? `http://localhost?scope=${scope}` : "http://localhost";
  return new Request(url, { headers });
}

function makeParams(id: string, path: string[]) {
  return { params: Promise.resolve({ id, path }) };
}

function mockSpawnOnce(stdout: string, status = 0) {
  return {
    stdout,
    stderr: "",
    status,
    error: undefined,
    pid: 1,
    output: [],
    signal: null,
  } as unknown as ReturnType<typeof spawnSync>;
}

describe("GET /api/sessions/[id]/diff/[...path]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns diff for modified file", async () => {
    vi.mocked(spawnSync)
      // getPathGitStatus (git status -z --porcelain=v1)
      .mockReturnValueOnce(mockSpawnOnce("M  src/index.ts\0"))
      // git diff HEAD
      .mockReturnValueOnce(mockSpawnOnce("@@ -1,3 +1,4 @@\n line1\n+added\n line2\n"));

    const res = await GET(
      makeRequest() as Parameters<typeof GET>[0],
      makeParams("test-session", ["src", "index.ts"]) as Parameters<typeof GET>[1]
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.status).toBe("M");
    expect(typeof data.diff).toBe("string");
    expect(data.content).toBeNull();
  });

  it("returns content for untracked file", async () => {
    vi.mocked(spawnSync).mockReturnValueOnce(mockSpawnOnce("?? newfile.ts\0"));

    vi.mocked(statSync).mockReturnValue({
      size: 50,
      mtimeMs: 111111,
      mtime: new Date(),
      isFile: () => true,
    } as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockReturnValue("new file content" as unknown as Buffer);

    const res = await GET(
      makeRequest() as Parameters<typeof GET>[0],
      makeParams("test-session", ["newfile.ts"]) as Parameters<typeof GET>[1]
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.status).toBe("?");
    expect(data.content).toBe("new file content");
    expect(data.diff).toBeNull();
  });

  it("returns 403 for traversal attempt", async () => {
    const res = await GET(
      makeRequest() as Parameters<typeof GET>[0],
      makeParams("test-session", ["..", "..", "etc", "passwd"]) as Parameters<typeof GET>[1]
    );
    expect(res.status).toBe(403);
  });

  it("returns 422 for binary extension", async () => {
    const res = await GET(
      makeRequest() as Parameters<typeof GET>[0],
      makeParams("test-session", ["image.png"]) as Parameters<typeof GET>[1]
    );
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe("binary");
  });

  it("returns 422 when diff exceeds 512KB", async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(mockSpawnOnce("M  big.ts\0"))
      .mockReturnValueOnce(mockSpawnOnce("x".repeat(600 * 1024)));

    const res = await GET(
      makeRequest() as Parameters<typeof GET>[0],
      makeParams("test-session", ["big.ts"]) as Parameters<typeof GET>[1]
    );
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe("diff_too_large");
  });

  it("scope=branch uses mergeBase as diff ref", async () => {
    vi.mocked(spawnSync)
      // resolveBaseRef → spawnSync is mocked at module level, but resolveBaseRef is mocked via _workspace
      // getPathGitStatus
      .mockReturnValueOnce(mockSpawnOnce("M  src/index.ts\0"))
      // git diff <mergeBase> -- src/index.ts
      .mockReturnValueOnce(mockSpawnOnce("@@ -1,3 +1,5 @@\n line1\n+added\n+added2\n line2\n"));

    const res = await GET(
      makeRequest(undefined, "branch") as Parameters<typeof GET>[0],
      makeParams("test-session", ["src", "index.ts"]) as Parameters<typeof GET>[1]
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.diff).toContain("+added");
  });

  it("scope=branch falls back to HEAD when resolveBaseRef returns null", async () => {
    const { resolveBaseRef } = await import("@/app/api/sessions/[id]/_workspace");
    vi.mocked(resolveBaseRef).mockReturnValueOnce(null);

    vi.mocked(spawnSync)
      .mockReturnValueOnce(mockSpawnOnce("M  src/index.ts\0"))
      .mockReturnValueOnce(mockSpawnOnce("@@ -1 +1 @@\n line\n"));

    const res = await GET(
      makeRequest(undefined, "branch") as Parameters<typeof GET>[0],
      makeParams("test-session", ["src", "index.ts"]) as Parameters<typeof GET>[1]
    );
    expect(res.status).toBe(200);
  });
});
