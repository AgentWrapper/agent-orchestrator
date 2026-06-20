import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseUpdate,
  decideRoute,
  getUpdatesUrl,
  resolveAoCommand,
  readTelegramConfig,
} from "./listener.js";
import {
  encodeSessionTag,
  parseSessionTag,
  encodeCallbackData,
  parseCallbackData,
} from "./shared.js";

describe("session tag round-trip", () => {
  it("embeds and recovers a session id", () => {
    const tag = encodeSessionTag("mae-10");
    expect(parseSessionTag(`Agent needs input\n\n↩️ Reply · ${tag}`)).toBe("mae-10");
  });
  it("returns null when no tag present", () => {
    expect(parseSessionTag("just some text")).toBeNull();
    expect(parseSessionTag(undefined)).toBeNull();
  });
});

describe("callback data round-trip", () => {
  it("encodes and decodes session + value", () => {
    const data = encodeCallbackData("mae-10", "Postgres");
    const parsed = parseCallbackData(data);
    expect(parsed).toEqual({ sessionId: "mae-10", value: "Postgres" });
  });
  it("stays within Telegram's 64-byte callback_data budget", () => {
    const data = encodeCallbackData("mae-10", "x".repeat(200));
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
  });
  it("rejects malformed callback data", () => {
    expect(parseCallbackData("garbage")).toBeNull();
    expect(parseCallbackData(undefined)).toBeNull();
  });
});

describe("parseUpdate", () => {
  it("parses a text message with a reply", () => {
    const parsed = parseUpdate({
      update_id: 5,
      message: {
        message_id: 2,
        chat: { id: 999 },
        text: "use Postgres",
        reply_to_message: { text: `ask\nao:session=mae-10` },
      },
    });
    expect(parsed).toMatchObject({
      kind: "message",
      updateId: 5,
      chatId: "999",
      text: "use Postgres",
      replyToText: expect.stringContaining("mae-10"),
    });
  });

  it("parses a callback query", () => {
    const parsed = parseUpdate({
      update_id: 7,
      callback_query: { id: "cb1", data: encodeCallbackData("mae-10", "SQLite"), message: { chat: { id: 999 } } },
    });
    expect(parsed).toMatchObject({ kind: "callback", updateId: 7, chatId: "999", callbackId: "cb1" });
  });

  it("ignores updates with no text/callback", () => {
    expect(parseUpdate({ update_id: 1, message: { chat: { id: 1 } } })).toBeNull();
    expect(parseUpdate(null)).toBeNull();
  });
});

describe("decideRoute", () => {
  const chat = "999";

  it("routes a tagged reply to its session", () => {
    const parsed = parseUpdate({
      update_id: 1,
      message: { chat: { id: 999 }, text: "use Postgres", reply_to_message: { text: encodeSessionTag("mae-10") } },
    })!;
    expect(decideRoute(parsed, chat)).toEqual({ sessionId: "mae-10", value: "use Postgres" });
  });

  it("routes a button press to its session", () => {
    const parsed = parseUpdate({
      update_id: 2,
      callback_query: { id: "cb1", data: encodeCallbackData("mae-10", "SQLite"), message: { chat: { id: 999 } } },
    })!;
    expect(decideRoute(parsed, chat)).toEqual({ sessionId: "mae-10", value: "SQLite", callbackId: "cb1" });
  });

  it("ignores messages from other chats", () => {
    const parsed = parseUpdate({
      update_id: 3,
      message: { chat: { id: 111 }, text: "hi", reply_to_message: { text: encodeSessionTag("mae-10") } },
    })!;
    expect(decideRoute(parsed, chat)).toBeNull();
  });

  it("ignores a reply with no session tag (unroutable)", () => {
    const parsed = parseUpdate({
      update_id: 4,
      message: { chat: { id: 999 }, text: "hi", reply_to_message: { text: "no tag here" } },
    })!;
    expect(decideRoute(parsed, chat)).toBeNull();
  });
});

describe("getUpdatesUrl", () => {
  it("builds a long-poll URL with offset + timeout", () => {
    const url = getUpdatesUrl("TKN", 42, 25);
    expect(url).toContain("/botTKN/getUpdates");
    expect(url).toContain("offset=42");
    expect(url).toContain("timeout=25");
  });
});

describe("resolveAoCommand", () => {
  it("falls back to `ao` on PATH when no bundled engine env", () => {
    expect(resolveAoCommand({})).toEqual({ cmd: "ao", baseArgs: [] });
  });
  it("uses AO_NODE + AO_CLI when both exist", () => {
    // Use real existing files so the existsSync guard passes.
    const node = process.execPath;
    const cli = process.argv[1];
    const cmd = resolveAoCommand({ AO_NODE: node, AO_CLI: cli } as NodeJS.ProcessEnv);
    expect(cmd.cmd).toBe(node);
    expect(cmd.baseArgs).toEqual([cli]);
  });
});

describe("readTelegramConfig", () => {
  it("reads notifiers.telegram.* from a YAML config", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-tg-"));
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      ["notifiers:", "  telegram:", "    botToken: TKN", "    chatId: -100", "    enable: true", ""].join("\n"),
    );
    const cfg = readTelegramConfig(path);
    expect(cfg.botToken).toBe("TKN");
    expect(cfg.chatId).toBe("-100");
    expect(cfg.enable).toBe(true);
  });

  it("returns empty config when the file is absent", () => {
    expect(readTelegramConfig(join(tmpdir(), "does-not-exist-xyz.yaml"))).toEqual({});
  });
});
