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
}));

vi.mock("@/app/api/sessions/[id]/_crypto", () => ({
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => "abcdef1234567890abcdef"),
  })),
}));

import { readFileSync, statSync } from "@/app/api/sessions/[id]/_fs";
import { GET } from "../[...path]/route";

function makeRequest(etag?: string) {
  const headers = new Headers();
  if (etag) headers.set("if-none-match", etag);
  return new Request("http://localhost", { headers });
}

function makeParams(id: string, path: string[]) {
  return { params: Promise.resolve({ id, path }) };
}

describe("GET /api/sessions/[id]/files/[...path]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(statSync).mockReturnValue({
      size: 100,
      mtimeMs: 1234567890,
      mtime: new Date(1234567890),
      isFile: () => true,
    } as ReturnType<typeof statSync>);
    vi.mocked(readFileSync).mockReturnValue("file content here" as unknown as Buffer);
  });

  it("returns file content for a valid path", async () => {
    const res = await GET(
      makeRequest() as Parameters<typeof GET>[0],
      makeParams("test-session", ["src", "index.ts"]) as Parameters<typeof GET>[1]
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.content).toBe("file content here");
    expect(data.path).toBe("src/index.ts");
  });

  it("returns 403 for path traversal attempt", async () => {
    const res = await GET(
      makeRequest() as Parameters<typeof GET>[0],
      makeParams("test-session", ["..", "..", "etc", "passwd"]) as Parameters<typeof GET>[1]
    );
    expect(res.status).toBe(403);
  });

  it("returns 422 for binary extension", async () => {
    vi.mocked(statSync).mockReturnValue({
      size: 1024,
      mtimeMs: 1234567890,
      mtime: new Date(),
      isFile: () => true,
    } as ReturnType<typeof statSync>);

    const res = await GET(
      makeRequest() as Parameters<typeof GET>[0],
      makeParams("test-session", ["image.png"]) as Parameters<typeof GET>[1]
    );
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe("binary");
  });

  it("returns 304 when ETag matches", async () => {
    // ETag is content-hashed; createHash mock returns a fixed digest.
    const etag = `"h-${"abcdef1234567890abcdef".slice(0, 16)}"`;
    const res = await GET(
      makeRequest(etag) as Parameters<typeof GET>[0],
      makeParams("test-session", ["src", "index.ts"]) as Parameters<typeof GET>[1]
    );
    expect(res.status).toBe(304);
  });
});
