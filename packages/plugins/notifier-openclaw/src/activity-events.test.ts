/**
 * Regression tests for plugin-internal activity events (issue #1659).
 *
 * Covers notifier.auth_failed (MUST) and notifier.unreachable (SHOULD) —
 * the two failure shapes RCA needs to distinguish.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorEvent } from "@aoagents/ao-core";

const { recordActivityEventMock } = vi.hoisted(() => ({
  recordActivityEventMock: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async () => {
  const actual = (await vi.importActual("@aoagents/ao-core")) as Record<string, unknown>;
  return {
    ...actual,
    recordActivityEvent: recordActivityEventMock,
  };
});

import { create } from "./index.js";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "reaction.escalated",
    priority: "urgent",
    sessionId: "ao-5",
    projectId: "ao",
    timestamp: new Date("2026-03-08T12:00:00Z"),
    message: "Reaction escalated",
    data: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  delete process.env.OPENCLAW_HOOKS_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notifier.auth_failed (MUST emit)", () => {
  it("emits on 401 (distinct from notifier.unreachable on ECONNREFUSED)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("unauthorized") });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ token: "tok", retries: 0 });
    await expect(notifier.notify(makeEvent())).rejects.toThrow(/OpenClaw rejected the auth token/);

    expect(recordActivityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "notifier",
        kind: "notifier.auth_failed",
        level: "error",
        sessionId: "ao-5",
        data: expect.objectContaining({
          plugin: "notifier-openclaw",
          status: 401,
        }),
      }),
    );
  });

  it("emits on 403", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve("forbidden") });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ token: "tok", retries: 0 });
    await expect(notifier.notify(makeEvent())).rejects.toThrow();

    expect(recordActivityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "notifier.auth_failed",
        data: expect.objectContaining({ status: 403 }),
      }),
    );
  });
});

describe("notifier.unreachable (SHOULD emit)", () => {
  it.each(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ENETUNREACH"])(
    "emits on %s (distinct from notifier.auth_failed)",
    async (code) => {
      const fetchMock = vi.fn().mockRejectedValue(new Error(`fetch failed: ${code}`));
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok", retries: 0 });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(/Can't reach OpenClaw gateway/);

      expect(recordActivityEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "notifier",
          kind: "notifier.unreachable",
          level: "warn",
          sessionId: "ao-5",
          data: expect.objectContaining({
            plugin: "notifier-openclaw",
            errorMessage: expect.stringContaining(code),
          }),
        }),
      );

      // Critically: should NOT also fire auth_failed — distinct shapes.
      const authFailedCalls = recordActivityEventMock.mock.calls.filter(
        ([event]) => event.kind === "notifier.auth_failed",
      );
      expect(authFailedCalls).toHaveLength(0);
    },
  );

  it.each(["ETIMEDOUT", "ENOTFOUND", "ENETUNREACH"])(
    "does not emit on transient %s when a retry succeeds",
    async (code) => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error(`fetch failed: ${code}`))
        .mockResolvedValueOnce({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok", retries: 1, retryDelayMs: 0 });
      await notifier.notify(makeEvent());

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const unreachableCalls = recordActivityEventMock.mock.calls.filter(
        ([event]) => event.kind === "notifier.unreachable",
      );
      expect(unreachableCalls).toHaveLength(0);
    },
  );

  it.each(["ETIMEDOUT", "ENOTFOUND", "ENETUNREACH"])(
    "emits on transient %s only after retry budget is exhausted",
    async (code) => {
      const fetchMock = vi.fn().mockRejectedValue(new Error(`fetch failed: ${code}`));
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok", retries: 1, retryDelayMs: 0 });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(/Can't reach OpenClaw gateway/);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const unreachableCalls = recordActivityEventMock.mock.calls.filter(
        ([event]) => event.kind === "notifier.unreachable",
      );
      expect(unreachableCalls).toHaveLength(1);
      expect(unreachableCalls[0]?.[0].data).toMatchObject({
        errorMessage: expect.stringContaining(code),
      });
    },
  );

  it("does not emit unreachable for unrelated network errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed: certificate expired"));
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ token: "tok", retries: 0 });
    await expect(notifier.notify(makeEvent())).rejects.toThrow(/fetch failed: certificate expired/);

    const unreachableCalls = recordActivityEventMock.mock.calls.filter(
      ([event]) => event.kind === "notifier.unreachable",
    );
    expect(unreachableCalls).toHaveLength(0);
  });
});
