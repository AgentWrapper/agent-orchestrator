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

const mockToolsExecute = vi.fn().mockResolvedValue({ successful: true });
const mockClient = { tools: { execute: mockToolsExecute } };

function makeV3Data(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    subject: { session: { id: "app-1", projectId: "my-project" } },
    ...overrides,
  };
}

function getToolArgs(): Record<string, any> {
  return mockToolsExecute.mock.calls[0][1].arguments;
}

function getSlackAttachment(): Record<string, any> {
  return JSON.parse(String(getToolArgs().attachments))[0];
}

function getSlackActions(): Array<Record<string, any>> {
  return getSlackAttachment().blocks.find((block: any) => block.type === "actions")?.elements ?? [];
}

describe("notifier-composio integration", () => {
  const originalEnv = process.env.COMPOSIO_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mockToolsExecute.mockResolvedValue({ successful: true });
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
    it("slack app routes to SLACK_SEND_MESSAGE with normalized channel", async () => {
      const notifier = composioPlugin.create({
        composioApiKey: "key",
        defaultApp: "slack",
        channelName: "#deploys",
        _clientOverride: mockClient,
      });
      await notifier.notify(makeEvent());

      expect(mockToolsExecute).toHaveBeenCalledWith(
        "SLACK_SEND_MESSAGE",
        expect.objectContaining({
          arguments: expect.objectContaining({
            channel: "deploys",
          }),
        }),
      );
    });

    it("discord app routes to DISCORDBOT_CREATE_MESSAGE with channel_id", async () => {
      const notifier = composioPlugin.create({
        composioApiKey: "key",
        defaultApp: "discord",
        mode: "bot",
        channelId: "1234567890",
        _clientOverride: mockClient,
      });
      await notifier.notify(makeEvent());

      expect(mockToolsExecute).toHaveBeenCalledWith(
        "DISCORDBOT_CREATE_MESSAGE",
        expect.objectContaining({
          arguments: expect.objectContaining({
            channel_id: "1234567890",
          }),
        }),
      );
    });

    it("discord webhook mode routes to DISCORDBOT_EXECUTE_WEBHOOK", async () => {
      const notifier = composioPlugin.create({
        composioApiKey: "key",
        defaultApp: "discord",
        mode: "webhook",
        webhookUrl: "https://discord.com/api/webhooks/1234567890/webhook-token",
        _clientOverride: mockClient,
      });
      await notifier.notify(makeEvent());

      expect(mockToolsExecute).toHaveBeenCalledWith(
        "DISCORDBOT_EXECUTE_WEBHOOK",
        expect.objectContaining({
          arguments: expect.objectContaining({
            webhook_id: "1234567890",
            webhook_token: "webhook-token",
          }),
        }),
      );
      expect(mockToolsExecute.mock.calls[0][1]).not.toHaveProperty("connectedAccountId");
    });

    it("gmail app routes to GMAIL_SEND_EMAIL with recipient/subject/body", async () => {
      const notifier = composioPlugin.create({
        composioApiKey: "key",
        defaultApp: "gmail",
        emailTo: "admin@example.com",
        connectedAccountId: "ca_gmail",
        _clientOverride: mockClient,
      });
      await notifier.notify(makeEvent());

      expect(mockToolsExecute).toHaveBeenCalledWith(
        "GMAIL_SEND_EMAIL",
        expect.objectContaining({
          connectedAccountId: "ca_gmail",
          version: "20260506_01",
          arguments: expect.objectContaining({
            recipient_email: "admin@example.com",
            subject: "[AO] Session Spawned: app-1",
            is_html: true,
          }),
        }),
      );
      expect(getToolArgs().body).toContain("<!doctype html>");
      expect(getToolArgs().body).toContain("Session app-1 spawned successfully");
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

      const attachment = getSlackAttachment();
      expect(attachment.fallback).toContain("Urgent");
      expect(attachment.fallback).toContain("CI failing");
      expect(attachment.blocks[0].text.text).toContain(":rotating_light:");
      expect(attachment.blocks[2].fields[1].text).toContain("app-5");
    });

    it("includes PR URL when present in event data", async () => {
      const notifier = composioPlugin.create({
        composioApiKey: "key",
        _clientOverride: mockClient,
      });
      await notifier.notify(
        makeEvent({
          data: makeV3Data({
            subject: {
              session: { id: "app-1", projectId: "my-project" },
              pr: { number: 99, url: "https://github.com/org/repo/pull/99" },
            },
          }),
        }),
      );

      expect(getSlackActions()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.objectContaining({ text: "View PR" }),
            url: "https://github.com/org/repo/pull/99",
          }),
        ]),
      );
    });

    it("omits PR URL when not a string", async () => {
      const notifier = composioPlugin.create({
        composioApiKey: "key",
        _clientOverride: mockClient,
      });
      await notifier.notify(makeEvent({ data: { prUrl: 123 } }));

      const text = mockToolsExecute.mock.calls[0][1].arguments.markdown_text as string;
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

      expect(getSlackActions()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.objectContaining({ text: "Merge PR" }),
            url: "https://github.com/merge",
          }),
          expect.objectContaining({
            text: expect.objectContaining({ text: "Kill Session" }),
            value: "/api/kill",
          }),
        ]),
      );
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

      const args = mockToolsExecute.mock.calls[0][1].arguments;
      expect(args.markdown_text).toBe("All sessions complete");
      expect(args.channel).toBe("override");
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
        tools: {
          execute: vi.fn().mockResolvedValue({
            successful: false,
            error: "Channel not found",
          }),
        },
      };

      const notifier = composioPlugin.create({
        composioApiKey: "key",
        _clientOverride: failClient,
      });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("Channel not found");
    });
  });
});
