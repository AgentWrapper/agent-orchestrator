import { beforeEach, describe, expect, it, vi } from "vitest";

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
  readdirSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));
vi.mock("@/app/api/sessions/[id]/_child-process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock("@/app/api/sessions/[id]/_crypto", () => ({
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => "abcdef1234567890abcdef"),
  })),
}));

vi.mock("@/app/api/sessions/[id]/_workspace", () => ({
  resolveWorkspace: vi.fn(async (id: string) =>
    id === "test-session"
      ? { ok: true, realRoot: WORKSPACE }
      : { ok: false, reason: "not_found" }
  ),
  resolveBaseRef: vi.fn(() => ({ baseRef: "origin/main", mergeBase: "abc123" })),
}));

import { readdirSync } from "@/app/api/sessions/[id]/_fs";
import { execSync, spawnSync } from "@/app/api/sessions/[id]/_child-process";
import { GET } from "../route";

function makeRequest(url = "http://localhost/api/sessions/test/files") {
  return new Request(url) as Parameters<typeof GET>[0];
}

function makeRequestWithScope(scope: "local" | "branch") {
  return new Request(`http://localhost/api/sessions/test/files?scope=${scope}`) as Parameters<typeof GET>[0];
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/sessions/[id]/files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readdirSync).mockReturnValue([]);
  });

  it("returns tree and gitStatus for a valid session", async () => {
    vi.mocked(readdirSync).mockReturnValueOnce([
      { name: "src", isDirectory: () => true, isFile: () => false } as ReturnType<typeof readdirSync>[number],
      { name: "index.ts", isDirectory: () => false, isFile: () => true } as ReturnType<typeof readdirSync>[number],
    ]);
    vi.mocked(execSync).mockReturnValue("M  src/file.ts\0" as unknown as Buffer);

    const res = await GET(makeRequest() as Parameters<typeof GET>[0], makeParams("test-session") as Parameters<typeof GET>[1]);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toHaveProperty("tree");
    expect(data).toHaveProperty("gitStatus");
  });

  it("ignores node_modules and .git directories", async () => {
    vi.mocked(readdirSync).mockReturnValueOnce([
      { name: "node_modules", isDirectory: () => true, isFile: () => false } as ReturnType<typeof readdirSync>[number],
      { name: ".git", isDirectory: () => true, isFile: () => false } as ReturnType<typeof readdirSync>[number],
      { name: "src", isDirectory: () => true, isFile: () => false } as ReturnType<typeof readdirSync>[number],
    ]);
    vi.mocked(execSync).mockReturnValue("" as unknown as Buffer);

    const res = await GET(makeRequest() as Parameters<typeof GET>[0], makeParams("test-session") as Parameters<typeof GET>[1]);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.tree.some((n: { name: string }) => n.name === "node_modules")).toBe(false);
    expect(data.tree.some((n: { name: string }) => n.name === ".git")).toBe(false);
  });

  it("sorts directories before files", async () => {
    vi.mocked(readdirSync).mockReturnValueOnce([
      { name: "zebra.ts", isDirectory: () => false, isFile: () => true } as ReturnType<typeof readdirSync>[number],
      { name: "alpha-dir", isDirectory: () => true, isFile: () => false } as ReturnType<typeof readdirSync>[number],
    ]);
    vi.mocked(execSync).mockReturnValue("" as unknown as Buffer);

    const res = await GET(makeRequest() as Parameters<typeof GET>[0], makeParams("test-session") as Parameters<typeof GET>[1]);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.tree[0].type).toBe("directory");
    expect(data.tree[1].type).toBe("file");
  });

  it("parses NUL-separated rename records as new-path only", async () => {
    vi.mocked(readdirSync).mockReturnValue([]);
    // Rename: "R  new/path\0old/path\0"
    vi.mocked(execSync).mockReturnValue(
      "R  renamed/new.ts\0renamed/old.ts\0M  src/file.ts\0" as unknown as Buffer
    );

    const res = await GET(makeRequest() as Parameters<typeof GET>[0], makeParams("test-session") as Parameters<typeof GET>[1]);
    const data = await res.json();

    expect(res.status).toBe(200);
    // Keyed on NEW path, not "old -> new" string.
    expect(data.gitStatus["renamed/new.ts"]).toBe("R");
    expect(data.gitStatus["renamed/old.ts"]).toBeUndefined();
    expect(data.gitStatus["src/file.ts"]).toBe("M");
  });

  it("returns 404 for unknown session", async () => {
    const res = await GET(makeRequest() as Parameters<typeof GET>[0], makeParams("unknown") as Parameters<typeof GET>[1]);
    expect(res.status).toBe(404);
  });

  it("scope=local returns local git status with scope in payload", async () => {
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(execSync).mockReturnValue("M  src/file.ts\0" as unknown as Buffer);

    const res = await GET(makeRequestWithScope("local"), makeParams("test-session") as Parameters<typeof GET>[1]);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.scope).toBe("local");
    expect(data).toHaveProperty("baseRef");
  });

  it("scope=branch calls spawnSync for branch-relative status and includes baseRef", async () => {
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(execSync).mockReturnValue("" as unknown as Buffer);
    // getBranchGitStatus uses spawnSync
    vi.mocked(spawnSync).mockReturnValue({
      stdout: "M\0src/file.ts\0",
      stderr: "",
      status: 0,
      error: undefined,
      pid: 1,
      output: [],
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>);

    const res = await GET(makeRequestWithScope("branch"), makeParams("test-session") as Parameters<typeof GET>[1]);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.scope).toBe("branch");
    expect(data.baseRef).toBe("origin/main");
  });

  it("scope=branch falls back to local when resolveBaseRef returns null", async () => {
    const { resolveBaseRef } = await import("@/app/api/sessions/[id]/_workspace");
    vi.mocked(resolveBaseRef).mockReturnValueOnce(null);
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(execSync).mockReturnValue("M  src/file.ts\0" as unknown as Buffer);

    const res = await GET(makeRequestWithScope("branch"), makeParams("test-session") as Parameters<typeof GET>[1]);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.baseRef).toBeNull();
  });
});
