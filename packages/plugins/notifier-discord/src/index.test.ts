import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyAction, OrchestratorEvent } from "@aoagents/ao-core";
import { create, manifest } from "./index.js";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "reaction.escalated",
    priority: "urgent",
    sessionId: "ao-5",
    projectId: "ao",
    timestamp: new Date("2026-03-20T12:00:00Z"),
    message: "CI failed after 5 retries",
    data: { attempts: 5, reason: "ci_failed" },
    ...overrides,
  };
}

describe("notifier-discord", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has correct manifest", () => {
    expect(manifest.name).toBe("discord");
    expect(manifest.slot).toBe("notifier");
  });

  it("posts to Discord webhook URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ webhookUrl: "https://discord.com/api/webhooks/123/abc" });
    await notifier.notify(makeEvent());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://discord.com/api/webhooks/123/abc");
  });

  it("sends Discord embed with correct structure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ webhookUrl: "https://discord.com/api/webhooks/123/abc" });
    await notifier.notify(makeEvent());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.username).toBe("Agent Orchestrator");
    expect(body.embeds).toHaveLength(1);

    const embed = body.embeds[0];
    expect(embed.title).toContain("ao-5");
    expect(embed.title).toContain("reaction.escalated");
    expect(embed.description).toBe("CI failed after 5 retries");
    expect(embed.color).toBe(0xed4245); // red for urgent
    expect(embed.timestamp).toBe("2026-03-20T12:00:00.000Z");
    expect(embed.footer.text).toBe("Agent Orchestrator");
  });

  it("includes project and priority fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ webhookUrl: "https://discord.com/api/webhooks/123/abc" });
    await notifier.notify(makeEvent());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const fields = body.embeds[0].fields;
    expect(fields).toContainEqual(expect.objectContaining({ name: "Project", value: "ao" }));
    expect(fields).toContainEqual(expect.objectContaining({ name: "Priority", value: "urgent" }));
  });

  it("includes PR link when available", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ webhookUrl: "https://discord.com/api/webhooks/123/abc" });
    await notifier.notify(makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const prField = body.embeds[0].fields.find((f: { name: string }) => f.name === "Pull Request");
    expect(prField.value).toContain("https://github.com/org/repo/pull/42");
  });

  it("includes CI status when available", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ webhookUrl: "https://discord.com/api/webhooks/123/abc" });
    await notifier.notify(makeEvent({ data: { ciStatus: "passing" } }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const ciField = body.embeds[0].fields.find((f: { name: string }) => f.name === "CI");
    expect(ciField.value).toContain("passing");
  });

  it("notifyWithActions includes action links", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ webhookUrl: "https://discord.com/api/webhooks/123/abc" });
    const actions: NotifyAction[] = [
      { label: "View PR", url: "https://github.com/org/repo/pull/42" },
      { label: "retry" },
    ];
    await notifier.notifyWithActions!(makeEvent(), actions);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const actionsField = body.embeds[0].fields.find((f: { name: string }) => f.name === "Actions");
    expect(actionsField.value).toContain("View PR");
    expect(actionsField.value).toContain("retry");
  });

  it("post sends plain content message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ webhookUrl: "https://discord.com/api/webhooks/123/abc" });
    await notifier.post!("Session ao-5 completed successfully");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toBe("Session ao-5 completed successfully");
    expect(body.embeds).toBeUndefined();
  });

  it("uses custom username when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ webhookUrl: "https://discord.com/api/webhooks/123/abc", username: "AO Bot" });
    await notifier.notify(makeEvent());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.username).toBe("AO Bot");
  });

  it("includes avatar_url when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
      avatarUrl: "https://example.com/avatar.png",
    });
    await notifier.notify(makeEvent());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.avatar_url).toBe("https://example.com/avatar.png");
  });

  it("includes thread_id when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
      threadId: "1234567890",
    });
    await notifier.notify(makeEvent());

    // Discord requires thread_id as a URL query param, not in the JSON body
    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toBe("https://discord.com/api/webhooks/123/abc?thread_id=1234567890");
  });

  it("is a no-op when webhookUrl not configured", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create();
    await notifier.notify(makeEvent());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No webhookUrl configured"));
  });

  it("uses correct color for each priority", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ webhookUrl: "https://discord.com/api/webhooks/123/abc" });

    await notifier.notify(makeEvent({ priority: "info" }));
    let body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.embeds[0].color).toBe(0x57f287); // green

    await notifier.notify(makeEvent({ priority: "warning" }));
    body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.embeds[0].color).toBe(0xfee75c); // yellow
  });

  it("handles 204 No Content as success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ webhookUrl: "https://discord.com/api/webhooks/123/abc" });
    await expect(notifier.notify(makeEvent())).resolves.toBeUndefined();
  });

  it("retries on 5xx response", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve("down") })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
      retries: 1,
      retryDelayMs: 50,
    });
    const promise = notifier.notify(makeEvent());

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await promise;
    vi.useRealTimers();
  });

  it("does not retry on 4xx response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("unauthorized") });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
      retries: 2,
      retryDelayMs: 1,
    });
    await expect(notifier.notify(makeEvent())).rejects.toThrow("Discord webhook failed (401)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
