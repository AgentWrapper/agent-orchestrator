import { describe, it, expect, vi, afterEach } from "vitest";

const { mockExistsSync, mockSpawnSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockSpawnSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  };
});

import {
  detectOpenClawInstallation,
  probeGateway,
  validateToken,
} from "../../src/lib/openclaw-probe.js";

describe("openclaw-probe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
    mockSpawnSync.mockReset();
    mockSpawnSync.mockReturnValue({ status: 1, stdout: "" });
  });

  describe("probeGateway", () => {
    it("returns reachable:true on 200", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const result = await probeGateway("http://127.0.0.1:18789");

      expect(result.reachable).toBe(true);
      expect(result.httpStatus).toBe(200);
      expect(result.error).toBeUndefined();
    });

    it("returns reachable:true even on non-200 (gateway is up)", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ status: 404, ok: false });
      vi.stubGlobal("fetch", fetchMock);

      const result = await probeGateway("http://127.0.0.1:18789");

      expect(result.reachable).toBe(true);
      expect(result.httpStatus).toBe(404);
    });

    it("returns reachable:false on ECONNREFUSED", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));
      vi.stubGlobal("fetch", fetchMock);

      const result = await probeGateway("http://127.0.0.1:18789");

      expect(result.reachable).toBe(false);
      expect(result.error).toContain("not reachable");
    });

    it("returns reachable:false on timeout", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("The operation was aborted"));
      vi.stubGlobal("fetch", fetchMock);

      const result = await probeGateway("http://127.0.0.1:18789", 100);

      expect(result.reachable).toBe(false);
      expect(result.error).toContain("timed out");
    });

    it("strips trailing slashes from URL", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
      vi.stubGlobal("fetch", fetchMock);

      await probeGateway("http://127.0.0.1:18789///");

      expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:18789");
    });

    it("uses default URL when none provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
      vi.stubGlobal("fetch", fetchMock);

      await probeGateway();

      expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:18789");
    });

    it("strips /hooks/agent when probing a hooks URL", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
      vi.stubGlobal("fetch", fetchMock);

      await probeGateway("http://127.0.0.1:18789/hooks/agent");

      expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:18789");
    });
  });

  describe("detectOpenClawInstallation", () => {
    it("reports missing when binary/config are absent and gateway is down", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      vi.stubGlobal("fetch", fetchMock);

      const result = await detectOpenClawInstallation();

      expect(result.state).toBe("missing");
      expect(result.binaryPath).toBeUndefined();
      expect(result.configPath).toBeUndefined();
    });

    it("reports installed-but-stopped when binary exists but gateway is down", async () => {
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "/usr/local/bin/openclaw\n" });
      const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      vi.stubGlobal("fetch", fetchMock);

      const result = await detectOpenClawInstallation();

      expect(result.state).toBe("installed-but-stopped");
      expect(result.binaryPath).toBe("/usr/local/bin/openclaw");
    });

    it("reports running when gateway is reachable", async () => {
      mockSpawnSync.mockReturnValue({ status: 0, stdout: "/usr/local/bin/openclaw\n" });
      mockExistsSync.mockReturnValue(true);
      const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const result = await detectOpenClawInstallation();

      expect(result.state).toBe("running");
      expect(result.configPath).toContain(".openclaw");
      expect(result.configPath).toContain("openclaw.json");
    });
  });

  describe("validateToken", () => {
    it("returns valid:true on 200", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      const result = await validateToken("http://127.0.0.1:18789", "good-token");

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("sends Bearer token in Authorization header", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      await validateToken("http://127.0.0.1:18789", "my-secret");

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers["Authorization"]).toBe("Bearer my-secret");
    });

    it("appends /hooks/agent if not in URL", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      await validateToken("http://127.0.0.1:18789", "tok");

      expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:18789/hooks/agent");
    });

    it("does not double-append /hooks/agent", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      await validateToken("http://127.0.0.1:18789/hooks/agent", "tok");

      expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:18789/hooks/agent");
    });

    it("returns valid:false with message on 401", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
      vi.stubGlobal("fetch", fetchMock);

      const result = await validateToken("http://127.0.0.1:18789", "bad-token");

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Token rejected");
    });

    it("returns valid:false with message on 403", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403 });
      vi.stubGlobal("fetch", fetchMock);

      const result = await validateToken("http://127.0.0.1:18789", "bad-token");

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Token rejected");
    });

    it("returns valid:false with body on unexpected status", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("internal error"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await validateToken("http://127.0.0.1:18789", "tok");

      expect(result.valid).toBe(false);
      expect(result.error).toContain("500");
      expect(result.error).toContain("internal error");
    });

    it("returns valid:false on ECONNREFUSED", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      vi.stubGlobal("fetch", fetchMock);

      const result = await validateToken("http://127.0.0.1:18789", "tok");

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Can't reach");
    });

    it("returns valid:false on timeout", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("The operation was aborted"));
      vi.stubGlobal("fetch", fetchMock);

      const result = await validateToken("http://127.0.0.1:18789", "tok", 100);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("timed out");
    });

    it("sends a test payload with correct structure", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      await validateToken("http://127.0.0.1:18789", "tok");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.message).toContain("Connection test");
      expect(body.name).toBe("AO");
      expect(body.sessionKey).toBe("hook:ao:setup-test");
      expect(body.wakeMode).toBe("now");
      expect(body.deliver).toBe(false);
    });
  });
});
