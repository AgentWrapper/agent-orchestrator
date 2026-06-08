/**
 * Integration tests for notifier-slack.
 *
 * Mocks ONLY the I/O boundary: global fetch.
 * Everything else runs for real: config parsing, Block Kit construction, channel routing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NotifyAction, EventPriority } from "@aoagents/ao-core";
import slackPlugin from "@aoagents/ao-plugin-notifier-slack";
import { makeEvent } from "./helpers/event-factory.js";

function mockFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: () => Promise.resolve("ok"),
  });
}

function makeV3Data(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    subject: { session: { id: "app-1", projectId: "my-project" } },
    ...overrides,
  };
}

function getAttachment(body: Record<string, any>): Record<string, any> {
  return body.attachments[0];
}

function getBlocks(body: Record<string, any>): Array<Record<string, any>> {
  return getAttachment(body).blocks;
}

function expectDefined<T>(value: T | undefined): asserts value is T {
  expect(value).toBeDefined();
  if (value === undefined) {
    throw new Error("Expected value to be defined");
  }
}

describe("notifier-slack integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("config -> Block Kit structure", () => {
    it("full event with prUrl + ciStatus produces complete blocks array", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = slackPlugin.create({
        webhookUrl: "https://hooks.slack.com/test",
        channel: "#deploys",
        username: "TestBot",
      });

      await notifier.notify(
        makeEvent({
          priority: "urgent",
          sessionId: "backend-3",
          projectId: "integrator",
          message: "CI is failing on backend-3",
          data: makeV3Data({
            subject: {
              session: { id: "backend-3", projectId: "integrator" },
              pr: { number: 42, url: "https://github.com/org/repo/pull/42" },
            },
            ci: { status: "failing" },
          }),
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const blocks = getBlocks(body);

      // Verify full structure
      expect(body.username).toBe("TestBot");
      expect(body.channel).toBe("#deploys");

      // Block 0: header
      expect(blocks[0].type).toBe("header");
      expect(blocks[0].text.type).toBe("plain_text");
      expect(blocks[0].text.text).toContain(":rotating_light:");
      expect(blocks[0].text.text).toContain("Session Spawned");
      expect(blocks[0].text.emoji).toBe(true);

      // Block 1: message section
      expect(blocks[1].type).toBe("section");
      expect(blocks[1].text.type).toBe("mrkdwn");
      expect(blocks[1].text.text).toBe("CI is failing on backend-3");

      // Field block includes project/session/priority metadata
      expect(blocks[2].type).toBe("section");
      expect(blocks[2].fields[0].text).toContain("*Project*");
      expect(blocks[2].fields[0].text).toContain("integrator");
      expect(blocks[2].fields[2].text).toContain("*Priority*");
      expect(blocks[2].fields[2].text).toContain("Urgent");

      // PR link is rendered as an action button
      const actionsBlock = blocks.find((b: Record<string, unknown>) => b.type === "actions");
      expectDefined(actionsBlock);
      expect(actionsBlock.elements[0].text.text).toBe("View PR");
      expect(actionsBlock.elements[0].url).toBe("https://github.com/org/repo/pull/42");

      // CI status block
      const ciBlock = blocks.find(
        (b: Record<string, unknown>) =>
          b.type === "context" &&
          Array.isArray((b as { elements?: unknown[] }).elements) &&
          typeof (b as { elements: Array<{ text?: string }> }).elements[0]?.text === "string" &&
          (b as { elements: Array<{ text: string }> }).elements[0].text.includes("CI:"),
      );
      expectDefined(ciBlock);
      expect(ciBlock.elements[0].text).toContain(":x:");
      expect(ciBlock.elements[0].text).toContain("failing");

      // Last block: divider
      expect(blocks[blocks.length - 1].type).toBe("divider");
    });

    it("passing CI uses check mark emoji", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = slackPlugin.create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notify(makeEvent({ data: makeV3Data({ ci: { status: "passing" } }) }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const ciBlock = getBlocks(body).find(
        (b: Record<string, unknown>) =>
          b.type === "context" &&
          Array.isArray((b as { elements?: unknown[] }).elements) &&
          typeof (b as { elements: Array<{ text?: string }> }).elements[0]?.text === "string" &&
          (b as { elements: Array<{ text: string }> }).elements[0].text.includes("CI:"),
      );
      expectDefined(ciBlock);
      expect(ciBlock.elements[0].text).toContain(":white_check_mark:");
    });

    it("event without prUrl or ciStatus omits those blocks", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = slackPlugin.create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notify(makeEvent({ data: {} }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Should have: header, message, fields, timestamp context, divider.
      expect(getBlocks(body)).toHaveLength(5);
    });
  });

  describe("priority emoji routing", () => {
    it.each([
      ["urgent", ":rotating_light:"],
      ["action", ":point_right:"],
      ["warning", ":warning:"],
      ["info", ":information_source:"],
    ] as Array<[EventPriority, string]>)(
      "priority %s -> emoji %s",
      async (priority, expectedEmoji) => {
        const fetchMock = mockFetchOk();
        vi.stubGlobal("fetch", fetchMock);

        const notifier = slackPlugin.create({ webhookUrl: "https://hooks.slack.com/test" });
        await notifier.notify(makeEvent({ priority }));

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(getBlocks(body)[0].text.text).toContain(expectedEmoji);
      },
    );
  });

  describe("notifyWithActions full pipeline", () => {
    it("renders URL actions as buttons and callback actions with action_id", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = slackPlugin.create({ webhookUrl: "https://hooks.slack.com/test" });
      const actions: NotifyAction[] = [
        { label: "Merge PR", url: "https://github.com/merge" },
        { label: "Kill Session", callbackEndpoint: "/api/kill/app-1" },
      ];

      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const actionsBlock = getBlocks(body).find(
        (b: Record<string, unknown>) => b.type === "actions",
      );
      expectDefined(actionsBlock);
      expect(actionsBlock.elements).toHaveLength(2);

      // URL button
      expect(actionsBlock.elements[0].type).toBe("button");
      expect(actionsBlock.elements[0].text.text).toBe("Merge PR");
      expect(actionsBlock.elements[0].url).toBe("https://github.com/merge");

      // Callback button
      expect(actionsBlock.elements[1].type).toBe("button");
      expect(actionsBlock.elements[1].action_id).toBe("ao_kill_session_1");
      expect(actionsBlock.elements[1].value).toBe("/api/kill/app-1");
    });

    it("actions without url or callback are filtered out", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = slackPlugin.create({ webhookUrl: "https://hooks.slack.com/test" });
      const actions: NotifyAction[] = [
        { label: "No Link" },
        { label: "Has Link", url: "https://example.com" },
      ];

      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const actionsBlock = getBlocks(body).find(
        (b: Record<string, unknown>) => b.type === "actions",
      );
      expectDefined(actionsBlock);
      expect(actionsBlock.elements).toHaveLength(1);
      expect(actionsBlock.elements[0].text.text).toBe("Has Link");
    });

    it("empty valid actions list produces no actions block", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = slackPlugin.create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notifyWithActions!(makeEvent(), [{ label: "No Link" }]);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const actionsBlock = getBlocks(body).find(
        (b: Record<string, unknown>) => b.type === "actions",
      );
      expect(actionsBlock).toBeUndefined();
    });
  });

  describe("post full pipeline", () => {
    it("sends text with username and channel", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = slackPlugin.create({
        webhookUrl: "https://hooks.slack.com/test",
        channel: "#default-channel",
        username: "CustomBot",
      });
      await notifier.post!("Summary message");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.text).toBe("Summary message");
      expect(body.username).toBe("CustomBot");
      expect(body.channel).toBe("#default-channel");
    });

    it("context channel overrides default channel", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = slackPlugin.create({
        webhookUrl: "https://hooks.slack.com/test",
        channel: "#default",
      });
      await notifier.post!("test", { channel: "#specific" });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.channel).toBe("#specific");
    });
  });

  describe("no-op behavior", () => {
    it("all methods are no-ops when no webhookUrl", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const notifier = slackPlugin.create();
      await notifier.notify(makeEvent());
      await notifier.notifyWithActions!(makeEvent(), [{ label: "Test", url: "https://x.com" }]);
      const result = await notifier.post!("test");

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });

  describe("error propagation", () => {
    it("non-ok response throws with status and body", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = slackPlugin.create({ webhookUrl: "https://hooks.slack.com/test" });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "Slack webhook failed (500): Internal Server Error",
      );
    });
  });

  describe("timestamp formatting", () => {
    it("includes Unix timestamp in Slack date format", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const ts = new Date("2025-06-15T12:00:00Z");
      const notifier = slackPlugin.create({ webhookUrl: "https://hooks.slack.com/test" });
      await notifier.notify(makeEvent({ timestamp: ts }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const contextBlock = getBlocks(body).find(
        (block) =>
          block.type === "context" &&
          block.elements?.[0]?.text?.includes("Sent by Agent Orchestrator"),
      );
      const contextText = contextBlock!.elements[0].text;
      const unixTs = Math.floor(ts.getTime() / 1000);
      expect(contextText).toContain(`<!date^${unixTs}^`);
    });
  });
});
