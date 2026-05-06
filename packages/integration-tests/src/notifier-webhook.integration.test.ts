/**
 * Integration tests for notifier-webhook.
 *
 * Mocks ONLY the I/O boundary: global fetch + vi.useFakeTimers().
 * Everything else runs for real: config parsing, retry logic, payload serialization.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NotifyAction } from "@aoagents/ao-core";
import webhookPlugin from "@aoagents/ao-plugin-notifier-webhook";
import { makeEvent } from "./helpers/event-factory.js";

describe("notifier-webhook integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("payload serialization", () => {
    it("notify serializes event with ISO timestamp and preserves data", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = webhookPlugin.create({ url: "https://example.com/hook" });
      const event = makeEvent({
        type: "ci.failing",
        priority: "action",
        message: "CI check failed",
        data: { checkName: "lint" },
      });
      await notifier.notify(event);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.type).toBe("notification");
      expect(body.event.id).toBe("evt-test-1");
      expect(body.event.type).toBe("ci.failing");
      expect(body.event.priority).toBe("action");
      expect(body.event.sessionId).toBe("app-1");
      expect(body.event.projectId).toBe("my-project");
      expect(body.event.timestamp).toBe("2025-06-15T12:00:00.000Z");
      expect(body.event.message).toBe("CI check failed");
      expect(body.event.data).toEqual({ checkName: "lint" });
    });

    it("notifyWithActions includes actions array in payload", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/merge" },
        { label: "Kill", callbackEndpoint: "/api/kill" },
      ];

      const notifier = webhookPlugin.create({ url: "https://example.com/hook" });
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.type).toBe("notification_with_actions");
      expect(body.actions).toEqual([
        { label: "Merge", url: "https://github.com/merge", callbackEndpoint: undefined },
        { label: "Kill", url: undefined, callbackEndpoint: "/api/kill" },
      ]);
    });

    it("post includes message and context in payload", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = webhookPlugin.create({ url: "https://example.com/hook" });
      await notifier.post!("All sessions done", { projectId: "my-project", channel: "#ops" });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.type).toBe("message");
      expect(body.message).toBe("All sessions done");
      expect(body.context).toEqual({ projectId: "my-project", channel: "#ops" });
    });
  });

  describe("custom headers", () => {
    it("merges custom headers with Content-Type", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = webhookPlugin.create({
        url: "https://example.com/hook",
        headers: { Authorization: "Bearer tok", "X-Custom": "val" },
      });
      await notifier.notify(makeEvent());

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Authorization"]).toBe("Bearer tok");
      expect(headers["X-Custom"]).toBe("val");
    });

    it("ignores non-string header values", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = webhookPlugin.create({
        url: "https://example.com/hook",
        headers: { valid: "yes", invalid: 42 },
      });
      await notifier.notify(makeEvent());

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers["valid"]).toBe("yes");
      expect(headers["invalid"]).toBeUndefined();
    });
  });

  describe("retry timing with fake timers", () => {
    it("retries=2, retryDelayMs=100: 503, 503, 200 -> 3 fetch calls with exponential backoff", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: () => Promise.resolve("unavailable"),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: () => Promise.resolve("unavailable"),
        })
        .mockResolvedValueOnce({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = webhookPlugin.create({
        url: "https://example.com/hook",
        retries: 2,
        retryDelayMs: 100,
      });

      const promise = notifier.notify(makeEvent());

      // First attempt happens immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // First retry after 100ms (100 * 2^0)
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Second retry after 200ms (100 * 2^1)
      await vi.advanceTimersByTimeAsync(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      await promise;
    });

    it("retries=1, retryDelayMs=500: delay * 2^0 = 500ms for first retry", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("error") })
        .mockResolvedValueOnce({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = webhookPlugin.create({
        url: "https://example.com/hook",
        retries: 1,
        retryDelayMs: 500,
      });

      const promise = notifier.notify(makeEvent());

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // At 499ms: not yet retried
      await vi.advanceTimersByTimeAsync(499);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // At 500ms: retry fires
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await promise;
    });
  });

  describe("non-retryable errors", () => {
    it.each([400, 401, 403, 404])(
      "HTTP %d -> single fetch call, immediate rejection",
      async (status) => {
        const fetchMock = vi.fn().mockResolvedValue({
          ok: false,
          status,
          text: () => Promise.resolve("client error"),
        });
        vi.stubGlobal("fetch", fetchMock);

        const notifier = webhookPlugin.create({
          url: "https://example.com/hook",
          retries: 3,
          retryDelayMs: 1,
        });

        await expect(notifier.notify(makeEvent())).rejects.toThrow(
          `Webhook POST failed (${status})`,
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe("retryable errors", () => {
    it("429 is retried", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: () => Promise.resolve("rate limited"),
        })
        .mockResolvedValueOnce({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = webhookPlugin.create({
        url: "https://example.com/hook",
        retries: 1,
        retryDelayMs: 1,
      });
      await notifier.notify(makeEvent());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("network errors (ECONNREFUSED) are retried", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = webhookPlugin.create({
        url: "https://example.com/hook",
        retries: 1,
        retryDelayMs: 1,
      });
      await notifier.notify(makeEvent());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("throws after all retries exhausted", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = webhookPlugin.create({
        url: "https://example.com/hook",
        retries: 2,
        retryDelayMs: 1,
      });

      await expect(notifier.notify(makeEvent())).rejects.toThrow("Webhook POST failed (500)");
      expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    });
  });

  describe("config validation", () => {
    it("throws on non-http(s) URL", () => {
      expect(() => webhookPlugin.create({ url: "ftp://example.com" })).toThrow("must be http(s)");
    });

    it("accepts http URL", () => {
      expect(() => webhookPlugin.create({ url: "http://localhost:3000/hook" })).not.toThrow();
    });

    it("retries defaults to 2 when not specified", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("error"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = webhookPlugin.create({ url: "https://example.com/hook", retryDelayMs: 1 });
      await expect(notifier.notify(makeEvent())).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 default retries
    });

    it("retries=0 means no retries", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("error"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = webhookPlugin.create({
        url: "https://example.com/hook",
        retries: 0,
        retryDelayMs: 1,
      });
      await expect(notifier.notify(makeEvent())).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("no-op behavior", () => {
    it("all methods no-op when no URL configured", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const notifier = webhookPlugin.create();
      await notifier.notify(makeEvent());
      await notifier.notifyWithActions!(makeEvent(), [{ label: "Test" }]);
      const result = await notifier.post!("msg");

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });
});
