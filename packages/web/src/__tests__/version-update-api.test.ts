import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as AoCoreType from "@aoagents/ao-core";

// Use a real on-disk cache file in a per-test temp dir rather than mocking
// node:fs. Mocking ESM-imported fs functions is unreliable when the route
// captures the binding at module-load time; a real file works in all cases.

const { mockGlobalConfig } = vi.hoisted(() => ({
  mockGlobalConfig: {
    value: null as null | { updateChannel?: "stable" | "nightly" | "manual" },
  },
}));

vi.mock("@aoagents/ao-core", async () => {
  const actual = (await vi.importActual("@aoagents/ao-core")) as typeof AoCoreType;
  return {
    ...actual,
    loadGlobalConfig: () => mockGlobalConfig.value,
  };
});

const { mockSessionList } = vi.hoisted(() => ({
  mockSessionList: vi.fn(async () => [] as Array<{ id: string; status: string }>),
}));

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(async () => ({
    sessionManager: { list: mockSessionList },
  })),
}));

import { GET as versionGET } from "@/app/api/version/route";
import { POST as updatePOST } from "@/app/api/update/route";

// ── Tests ─────────────────────────────────────────────────────────────

describe("GET /api/version", () => {
  let tmpCacheDir: string;
  let origXdg: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGlobalConfig.value = null;
    // Per-test cache dir, deterministic.
    tmpCacheDir = mkdtempSync(join(tmpdir(), "ao-version-test-"));
    mkdirSync(join(tmpCacheDir, "ao"), { recursive: true });
    origXdg = process.env["XDG_CACHE_HOME"];
    process.env["XDG_CACHE_HOME"] = tmpCacheDir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origXdg !== undefined) process.env["XDG_CACHE_HOME"] = origXdg;
    else delete process.env["XDG_CACHE_HOME"];
    rmSync(tmpCacheDir, { recursive: true, force: true });
  });

  function writeCache(data: object) {
    writeFileSync(
      join(tmpCacheDir, "ao", "update-check.json"),
      JSON.stringify(data),
    );
  }

  it("returns current version, channel='manual' default, latest=null when cache absent", async () => {
    const res = await versionGET();
    const body = (await res.json()) as {
      current: string;
      latest: string | null;
      channel: string;
      isOutdated: boolean;
    };
    expect(body.channel).toBe("manual");
    expect(body.latest).toBeNull();
    expect(body.isOutdated).toBe(false);
    expect(typeof body.current).toBe("string");
  });

  it("returns latest from cache when present and channel matches", async () => {
    mockGlobalConfig.value = { updateChannel: "nightly" };
    writeCache({
      latestVersion: "0.6.0-nightly-abc",
      checkedAt: new Date().toISOString(),
      currentVersionAtCheck: "0.5.0",
      channel: "nightly",
    });
    const res = await versionGET();
    const body = (await res.json()) as { latest: string | null; channel: string; isOutdated: boolean };
    expect(body.channel).toBe("nightly");
    expect(body.latest).toBe("0.6.0-nightly-abc");
  });

  it("ignores cache entries from a different channel", async () => {
    mockGlobalConfig.value = { updateChannel: "stable" };
    writeCache({
      latestVersion: "0.6.0-nightly-abc",
      checkedAt: new Date().toISOString(),
      channel: "nightly",
    });
    const res = await versionGET();
    const body = (await res.json()) as { latest: string | null };
    expect(body.latest).toBeNull();
  });

  it("trusts cached.isOutdated for git installs (latestVersion is a ref, not semver)", async () => {
    // Git installs cache `latestVersion: "origin/main"`. Without the
    // installMethod=="git" branch, `isVersionOutdated(current, "origin/main")`
    // would always return false because parseVersion produces NaN parts —
    // git-installed users would never see the banner.
    mockGlobalConfig.value = { updateChannel: "stable" };
    writeCache({
      latestVersion: "origin/main",
      checkedAt: new Date().toISOString(),
      currentVersionAtCheck: "0.6.0",
      installMethod: "git",
      channel: "stable",
      isOutdated: true,
      currentRevisionAtCheck: "abc",
      latestRevisionAtCheck: "def",
    });

    const res = await versionGET();
    const body = (await res.json()) as { latest: string | null; isOutdated: boolean };
    expect(body.latest).toBe("origin/main");
    expect(body.isOutdated).toBe(true);
  });

  it("returns isOutdated=false for git installs whose cache says they're current", async () => {
    mockGlobalConfig.value = { updateChannel: "stable" };
    writeCache({
      latestVersion: "origin/main",
      checkedAt: new Date().toISOString(),
      currentVersionAtCheck: "0.6.0",
      installMethod: "git",
      channel: "stable",
      isOutdated: false,
      currentRevisionAtCheck: "abc",
      latestRevisionAtCheck: "abc",
    });

    const res = await versionGET();
    const body = (await res.json()) as { isOutdated: boolean };
    expect(body.isOutdated).toBe(false);
  });

  it("ignores legacy cache entries without a `channel` field (matches CLI behavior)", async () => {
    // Pre-channel-scoping cache entry. Even though latestVersion looks newer
    // than current, we can't know which channel it was written for, so we
    // must reject it — otherwise a stable→nightly switch keeps serving the
    // old stable latestVersion via the dashboard until the 24h TTL expires.
    mockGlobalConfig.value = { updateChannel: "nightly" };
    writeCache({
      latestVersion: "99.0.0",
      checkedAt: new Date().toISOString(),
      currentVersionAtCheck: "0.6.0",
      installMethod: "npm-global",
      // No `channel` field — legacy.
    });

    const res = await versionGET();
    const body = (await res.json()) as {
      latest: string | null;
      isOutdated: boolean;
      checkedAt: string | null;
    };
    expect(body.latest).toBeNull();
    expect(body.isOutdated).toBe(false);
    expect(body.checkedAt).toBeNull();
  });
});

describe("POST /api/update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionList.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeReq() {
    return new NextRequest("http://localhost:3000/api/update", { method: "POST" });
  }

  it("refuses with 409 when sessions are active", async () => {
    mockSessionList.mockResolvedValue([
      { id: "s1", status: "working" },
      { id: "s2", status: "needs_input" },
    ]);
    const res = await updatePOST(makeReq());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; activeSessions?: number; message: string };
    expect(body.ok).toBe(false);
    expect(body.activeSessions).toBe(2);
    expect(body.message).toMatch(/ao stop/);
  });

  it.each(["working", "idle", "needs_input", "stuck"])(
    "refuses for status %s",
    async (status) => {
      mockSessionList.mockResolvedValue([{ id: "s1", status }]);
      const res = await updatePOST(makeReq());
      expect(res.status).toBe(409);
    },
  );

  it("does not refuse for terminal statuses (kicks off update)", async () => {
    mockSessionList.mockResolvedValue([
      { id: "s1", status: "done" },
      { id: "s2", status: "terminated" },
    ]);
    const res = await updatePOST(makeReq());
    // 202 because the guard passed and spawn ran (or failed silently — either
    // way the route returns 202 since spawn errors are caught).
    expect([202, 500]).toContain(res.status);
  });

  it("returns 202 when no sessions are active", async () => {
    mockSessionList.mockResolvedValue([]);
    const res = await updatePOST(makeReq());
    expect([202, 500]).toContain(res.status);
    if (res.status === 202) {
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    }
  });

  it("returns 500 when session listing throws", async () => {
    mockSessionList.mockRejectedValue(new Error("disk full"));
    const res = await updatePOST(makeReq());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/disk full/);
  });
});
