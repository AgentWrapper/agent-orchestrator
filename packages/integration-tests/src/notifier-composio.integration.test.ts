/**
 * Integration tests for notifier-composio.
 *
 * Uses _clientOverride to inject a mock Composio client at the I/O boundary.
 * Everything else runs for real: config parsing, tool slug routing, message formatting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NotifyAction } from "@aoagents/ao-core";
import composioPlugin from "@aoagents/ao-plugin-notifier-composio";
import { makeEvent } from "./helpers/event-factory.js";

const mockExecuteAction = vi.fn().mockResolvedValue({ successful: true });
const mockClient = { executeAction: mockExecuteAction };

describe("notifier-composio integration", () => {
  const originalEnv = process.env.COMPOSIO_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.COMPOSIO_API_KEY;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.COMPOSIO_API_KEY = originalEnv;
    } else {
      delete process.env.COMPOSIO_API_KEY;
    }
  });

  describe("config -> tool slug routing", () => {
    it("slack app routes to SLACK_SEND_MESSAGE with channel", async () => {
      const notifier = composioPlugin.create({
        composioApiKey: "key",
        defaultApp: "slack",
        channelName: "#deploys",
        _clientOverride: mockClient,
      });
      await notifier.notify(makeEvent());

      expect(mockExecuteAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "SLACK_SEND_MESSAGE",
          params: expect.objectContaining({
            channel: "#deploys",
          }),
        }),
      );
    });

    it("discord app routes to DISCORD_SEND_MESSAGE with channel_id", async () => {
      const notifier = composioPlugin.create({
        composioApiKey: "key",
        defaultApp: "discord",
        channelId: "1234567890",
        _clientOverride: mockClient,
      });
      await notifier.notify(makeEvent());

      expect(mockExecuteAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "DISCORD_SEND_MESSAGE",
          params: expect.objectContaining({
            channel_id: "1234567890",
          }),
        }),
      );
    });

    it("gmail app routes to GMAIL_SEND_EMAIL with to/subject/body", async () => {
      const notifier = composioPlugin.create({
        composioApiKey: "key",
        defaultApp: "gmail",
        emailTo: "admin@example.com",
        _clientOverride: mockClient,
      });
      await notifier.notify(makeEvent());

      expect(mockExecuteAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "GMAIL_SEND_EMAIL",
          params: expect.objectContaining({
            to: "admin@example.com",
            subject: "Agent Orchestrator Notification",
          }),
        }),
      );
    });
  });

  describe("message formatting pipeline", () => {
    it("includes priority emoji, event type, session ID, and message", async () => {
      const notifier = composioPlugin.create({
        composioApiKey: "key",
        _clientOverride: mockClient,
      });
      await notifier.notify(
        makeEvent({ priority: "urgent", type: "ci.failing", sessionId: "app-5" }),
      );

      const text = mockExecuteAction.mock.calls[0][0].params.text as string;
      expect(text).toContain("\u{1F6A8}"); // urgent emoji
      expect(text).toContain("ci.failing");
      expect(text).toContain("app-5");
    });

    it("includes PR URL when present in event data", async () => {
      const notifier = composioPlugin.create({
        composioApiKey: "key",
        _clientOverride: mockClient,
      });
      await notifier.notify(makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/99" } }));

      const text = mockExecuteAction.mock.calls[0][0].params.text as string;
      expect(text).toContain("https://github.com/org/repo/pull/99");
    });

    it("omits PR URL when not a string", async () => {
      const notifier = composioPlugin.create({
        composioApiKey: "key",
        _clientOverride: mockClient,
      });
      await notifier.notify(makeEvent({ data: { prUrl: 123 } }));

      const text = mockExecuteAction.mock.calls[0][0].params.text as string;
      expect(text).not.toContain("PR:");
    });
  });

  describe("notifyWithActions pipeline", () => {
    it("includes action labels and URLs in message text", async () => {
      const notifier = composioPlugin.create({
        composioApiKey: "key",
        _clientOverride: mockClient,
      });
      const actions: NotifyAction[] = [
        { label: "Merge PR", url: "https://github.com/merge" },
        { label: "Kill Session", callbackEndpoint: "/api/kill" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const text = mockExecuteAction.mock.calls[0][0].params.text as string;
      expect(text).toContain("Merge PR: https://github.com/merge");
      expect(text).toContain("- Kill Session");
    });
  });

  describe("post pipeline", () => {
    it("sends plain text with channel override", async () => {
      const notifier = composioPlugin.create({
        composioApiKey: "key",
        channelName: "#default",
        _clientOverride: mockClient,
      });
      await notifier.post!("All sessions complete", { channel: "#override" });

      const args = mockExecuteAction.mock.calls[0][0].params;
      expect(args.text).toBe("All sessions complete");
      expect(args.channel).toBe("#override");
    });

    it("returns null", async () => {
      const notifier = composioPlugin.create({
        composioApiKey: "key",
        _clientOverride: mockClient,
      });
      const result = await notifier.post!("test");
      expect(result).toBeNull();
    });
  });

  describe("error handling", () => {
    it("unsuccessful result throws descriptive error", async () => {
      const failClient = {
        executeAction: vi.fn().mockResolvedValue({
          successful: false,
          error: "Channel not found",
        }),
      };

      const notifier = composioPlugin.create({
        composioApiKey: "key",
        _clientOverride: failClient,
      });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("Channel not found");
    });
  });
});
