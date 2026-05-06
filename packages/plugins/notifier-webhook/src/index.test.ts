import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OrchestratorEvent, NotifyAction } from "@aoagents/ao-core";
import { manifest, create } from "./index.js";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "ci.failing",
    priority: "action",
    sessionId: "app-1",
    projectId: "my-project",
    timestamp: new Date("2025-06-15T12:00:00Z"),
    message: "CI check failed on app-1",
    data: { checkName: "lint" },
    ...overrides,
  };
}

describe("notifier-webhook", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("webhook");
      expect(manifest.slot).toBe("notifier");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create", () => {
    it("returns a notifier with name 'webhook'", () => {
      const notifier = create({ url: "https://example.com/hook" });
      expect(notifier.name).toBe("webhook");
    });

    it("warns when no url configured", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No url configured"));
    });

    it("throws on invalid URL scheme", () => {
      expect(() => create({ url: "ftp://example.com" })).toThrow("must be http(s)");
    });

    it("throws on javascript: URL", () => {
      expect(() => create({ url: "javascript:alert(1)" })).toThrow("must be http(s)");
    });

    it("accepts http:// URL", () => {
      expect(() => create({ url: "http://localhost:8080/hook" })).not.toThrow();
    });

    it("accepts https:// URL", () => {
      expect(() => create({ url: "https://example.com/hook" })).not.toThrow();
    });
  });

  describe("notify", () => {
    it("does nothing when no url", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const notifier = create();
      await notifier.notify(makeEvent());
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("POSTs event as JSON to the configured URL", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ url: "https://example.com/hook" });
      await notifier.notify(makeEvent());

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/hook");

      const opts = fetchMock.mock.calls[0][1];
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(opts.body);
      expect(body.type).toBe("notification");
      expect(body.event.id).toBe("evt-1");
      expect(body.event.sessionId).toBe("app-1");
      expect(body.event.type).toBe("ci.failing");
    });

    it("serializes event timestamp as ISO string", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ url: "https://example.com/hook" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.event.timestamp).toBe("2025-06-15T12:00:00.000Z");
    });

    it("includes custom headers", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        url: "https://example.com/hook",
        headers: { Authorization: "Bearer tok123" },
      });
      await notifier.notify(makeEvent());

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers["Authorization"]).toBe("Bearer tok123");
      expect(headers["Content-Type"]).toBe("application/json");
    });
  });

  describe("notifyWithActions", () => {
    it("includes actions in payload", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/pull/1/merge" },
        { label: "Kill", callbackEndpoint: "/api/kill/app-1" },
      ];

      const notifier = create({ url: "https://example.com/hook" });
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.type).toBe("notification_with_actions");
      expect(body.actions).toHaveLength(2);
    });
  });

  describe("post", () => {
    it("sends a plain message with context", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ url: "https://example.com/hook" });
      const result = await notifier.post!("All sessions complete", {
        projectId: "my-project",
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.type).toBe("message");
      expect(body.message).toBe("All sessions complete");
      expect(result).toBeNull();
    });
  });

  describe("retry logic", () => {
    it("retries on 5xx and succeeds", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: () => Promise.resolve("unavailable"),
        })
        .mockResolvedValueOnce({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        url: "https://example.com/hook",
        retries: 2,
        retryDelayMs: 1,
      });
      await notifier.notify(makeEvent());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries on 429 Too Many Requests", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: () => Promise.resolve("rate limited"),
        })
        .mockResolvedValueOnce({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        url: "https://example.com/hook",
        retries: 2,
        retryDelayMs: 1,
      });
      await notifier.notify(makeEvent());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on 400 Bad Request", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve("bad request") });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        url: "https://example.com/hook",
        retries: 2,
        retryDelayMs: 1,
      });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("Webhook POST failed (400)");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on 401 Unauthorized", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("unauthorized") });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        url: "https://example.com/hook",
        retries: 2,
        retryDelayMs: 1,
      });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("Webhook POST failed (401)");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on 403 Forbidden", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve("forbidden") });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        url: "https://example.com/hook",
        retries: 2,
        retryDelayMs: 1,
      });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("Webhook POST failed (403)");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on 404 Not Found", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve("not found") });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        url: "https://example.com/hook",
        retries: 2,
        retryDelayMs: 1,
      });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("Webhook POST failed (404)");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws after all retries exhausted on 5xx", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("error") });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        url: "https://example.com/hook",
        retries: 2,
        retryDelayMs: 1,
      });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "Webhook POST failed (500): error",
      );
      // 1 initial + 2 retries = 3
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("retries on network errors", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        url: "https://example.com/hook",
        retries: 1,
        retryDelayMs: 1,
      });
      await notifier.notify(makeEvent());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("respects retries=0 (no retries)", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("fail") });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        url: "https://example.com/hook",
        retries: 0,
        retryDelayMs: 1,
      });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("Webhook POST failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
