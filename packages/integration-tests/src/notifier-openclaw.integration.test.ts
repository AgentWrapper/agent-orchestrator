/**
 * Integration tests for notifier-openclaw.
 *
 * Mocks network boundary only (global fetch + timers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyAction } from "@aoagents/ao-core";
import openClawPlugin from "@aoagents/ao-plugin-notifier-openclaw";
import { makeEvent } from "./helpers/event-factory.js";

describe("notifier-openclaw integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.OPENCLAW_HOOKS_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("notify posts OpenClaw hooks payload with per-session key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = openClawPlugin.create({
      url: "http://127.0.0.1:18789/hooks/agent",
      token: "tok",
      sessionKeyPrefix: "hook:ao:",
    });

    await notifier.notify(
      makeEvent({
        type: "reaction.escalated",
        priority: "urgent",
        sessionId: "ao-12",
        message: "CI failed 5 times",
        data: { attempts: 5, reason: "ci_failed" },
      }),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:18789/hooks/agent");

    const body = JSON.parse(opts.body);
    expect(body.name).toBe("AO");
    expect(body.sessionKey).toBe("hook:ao:ao-12");
    expect(body.wakeMode).toBe("now");
    expect(body.deliver).toBe(true);
    expect(body.message).toContain("[AO URGENT]");
    expect(body.message).toContain("CI failed 5 times");
  });

  it("notifyWithActions formats escalation header/context and appends action labels", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const actions: NotifyAction[] = [{ label: "retry" }, { label: "kill" }];

    const notifier = openClawPlugin.create({ token: "tok" });
    await notifier.notifyWithActions!(
      makeEvent({
        priority: "action",
        type: "ci.failing",
        sessionId: "ao-5",
        message: "CI check failed on app-1",
        data: { checkName: "lint" },
      }),
      actions,
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sessionKey).toBe("hook:ao:ao-5");
    expect(body.message).toContain("[AO ACTION] ao-5 ci.failing");
    expect(body.message).toContain('Context: {"checkName":"lint"}');
    expect(body.message).toContain("Actions available: retry, kill");
  });

  it("uses explicit deliver=true in hooks payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = openClawPlugin.create({
      token: "tok",
      deliver: true,
      wakeMode: "now",
    });
    await notifier.notify(makeEvent({ sessionId: "ao-21" }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.deliver).toBe(true);
    expect(body.wakeMode).toBe("now");
  });

  it("retries 503 then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve("down") })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = openClawPlugin.create({ token: "tok", retries: 1, retryDelayMs: 100 });
    const promise = notifier.notify(makeEvent());

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await promise;
  });
});
