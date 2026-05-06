import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrchestratorEvent, NotifyAction, EventPriority } from "@aoagents/ao-core";
import { manifest, create } from "./index.js";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "session.spawned",
    priority: "info",
    sessionId: "app-1",
    projectId: "my-project",
    timestamp: new Date("2025-06-15T12:00:00Z"),
    message: "Session app-1 spawned successfully",
    data: {},
    ...overrides,
  };
}

function mockFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: () => Promise.resolve("ok"),
  });
}

describe("notifier-slack", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("slack");
      expect(manifest.slot).toBe("notifier");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create", () => {
    it("returns a notifier with name 'slack'", () => {
      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      expect(notifier.name).toBe("slack");
    });

    it("warns when no webhookUrl configured", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No webhookUrl configured"));
    });

    it("throws on invalid URL scheme", () => {
      expect(() => create({ webhookUrl: "file:///etc/passwd" })).toThrow("must be http(s)");
    });
  });

  describe("notify", () => {
    it("does nothing when no webhookUrl", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      const notifier = create();
      await notifier.notify(makeEvent());
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("POSTs to the webhook URL", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notify(makeEvent());

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe("https://hooks.slack.com/test");
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("sends JSON with Content-Type header", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notify(makeEvent());

      const opts = fetchMock.mock.calls[0][1];
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("includes username in payload", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.username).toBe("Agent Orchestrator");
    });

    it("uses custom username when configured", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        webhookUrl: "https://hooks.slack.com/test",
        username: "MyBot",
      });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.username).toBe("MyBot");
    });

    it("includes channel when configured", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        webhookUrl: "https://hooks.slack.com/test",
        channel: "#deploys",
      });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.channel).toBe("#deploys");
    });

    it("throws on non-ok response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "Slack webhook failed (500): server error",
      );
    });
  });

  describe("Block Kit formatting", () => {
    it("includes header block with priority emoji and session ID", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notify(makeEvent({ priority: "urgent", sessionId: "backend-3" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const header = body.blocks[0];
      expect(header.type).toBe("header");
      expect(header.text.type).toBe("plain_text");
      expect(header.text.text).toContain(":rotating_light:");
      expect(header.text.text).toContain("backend-3");
    });

    it("uses correct emoji for each priority level", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });

      const priorities: Array<[EventPriority, string]> = [
        ["urgent", ":rotating_light:"],
        ["action", ":point_right:"],
        ["warning", ":warning:"],
        ["info", ":information_source:"],
      ];

      for (const [priority, emoji] of priorities) {
        fetchMock.mockClear();
        await notifier.notify(makeEvent({ priority }));
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.blocks[0].text.text).toContain(emoji);
      }
    });

    it("includes section block with event message", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notify(makeEvent({ message: "CI is green" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const section = body.blocks[1];
      expect(section.type).toBe("section");
      expect(section.text.text).toBe("CI is green");
    });

    it("includes context block with project and priority", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notify(makeEvent({ projectId: "frontend", priority: "action" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const context = body.blocks[2];
      expect(context.type).toBe("context");
      expect(context.elements[0].text).toContain("*Project:* frontend");
      expect(context.elements[0].text).toContain("*Priority:* action");
    });

    it("includes PR link when prUrl is a string in event data", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notify(makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const prBlock = body.blocks.find(
        (b: Record<string, unknown>) =>
          b.type === "section" && (b as any).text?.text?.includes("View Pull Request"),
      );
      expect(prBlock).toBeDefined();
      expect(prBlock.text.text).toContain("https://github.com/org/repo/pull/42");
    });

    it("ignores prUrl when it is not a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notify(makeEvent({ data: { prUrl: 12345 } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const prBlock = body.blocks.find(
        (b: Record<string, unknown>) =>
          b.type === "section" && (b as any).text?.text?.includes("View Pull Request"),
      );
      expect(prBlock).toBeUndefined();
    });

    it("ignores ciStatus when it is not a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notify(makeEvent({ data: { ciStatus: { nested: true } } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const ciBlock = body.blocks.find(
        (b: Record<string, unknown>) =>
          b.type === "context" && (b as any).elements?.[0]?.text?.includes("CI:"),
      );
      expect(ciBlock).toBeUndefined();
    });

    it("includes CI status when ciStatus is a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notify(makeEvent({ data: { ciStatus: "passing" } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const ciBlock = body.blocks.find(
        (b: Record<string, unknown>) =>
          b.type === "context" && (b as any).elements?.[0]?.text?.includes("CI:"),
      );
      expect(ciBlock).toBeDefined();
      expect(ciBlock.elements[0].text).toContain(":white_check_mark:");
    });

    it("uses :x: emoji for failing CI", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notify(makeEvent({ data: { ciStatus: "failing" } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const ciBlock = body.blocks.find(
        (b: Record<string, unknown>) =>
          b.type === "context" && (b as any).elements?.[0]?.text?.includes("CI:"),
      );
      expect(ciBlock.elements[0].text).toContain(":x:");
    });

    it("ends with a divider block", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const lastBlock = body.blocks[body.blocks.length - 1];
      expect(lastBlock.type).toBe("divider");
    });
  });

  describe("notifyWithActions", () => {
    it("includes action buttons with URLs", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/org/repo/pull/42/merge" },
        { label: "Open", url: "https://github.com/org/repo/pull/42" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const actionsBlock = body.blocks.find((b: Record<string, unknown>) => b.type === "actions");
      expect(actionsBlock).toBeDefined();
      expect(actionsBlock.elements).toHaveLength(2);
      expect(actionsBlock.elements[0].type).toBe("button");
      expect(actionsBlock.elements[0].text.text).toBe("Merge");
    });

    it("includes callback-based action buttons", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      const actions: NotifyAction[] = [
        { label: "Kill Session", callbackEndpoint: "/api/sessions/app-1/kill" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const actionsBlock = body.blocks.find((b: Record<string, unknown>) => b.type === "actions");
      expect(actionsBlock.elements[0].action_id).toBe("ao_kill_session_0");
      expect(actionsBlock.elements[0].value).toBe("/api/sessions/app-1/kill");
    });

    it("filters out actions with no url or callback", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      const actions: NotifyAction[] = [
        { label: "No-op" },
        { label: "Merge", url: "https://example.com" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const actionsBlock = body.blocks.find((b: Record<string, unknown>) => b.type === "actions");
      expect(actionsBlock.elements).toHaveLength(1);
      expect(actionsBlock.elements[0].text.text).toBe("Merge");
    });
  });

  describe("post", () => {
    it("sends a text message", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://hooks.slack.com/test" });
      const result = await notifier.post!("Hello from AO");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.text).toBe("Hello from AO");
      expect(result).toBeNull();
    });

    it("uses context channel over default", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        webhookUrl: "https://hooks.slack.com/test",
        channel: "#default",
      });
      await notifier.post!("test", { channel: "#override" });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.channel).toBe("#override");
    });

    it("returns null when no webhookUrl", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create();
      const result = await notifier.post!("test");
      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
