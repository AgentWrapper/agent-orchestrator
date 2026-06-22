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
  parseOrcCommand,
  readProjectsRegistry,
  buildOrcResolver,
  type OrcResolver,
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

describe("parseOrcCommand", () => {
  it("parses project + message", () => {
    expect(parseOrcCommand("/orc maestro fix the build")).toEqual({
      project: "maestro",
      message: "fix the build",
    });
  });
  it("tolerates the /orc@botname form", () => {
    expect(parseOrcCommand("/orc@ao_bot bud ship it")).toEqual({
      project: "bud",
      message: "ship it",
    });
  });
  it("keeps multi-line / multi-word messages intact", () => {
    expect(parseOrcCommand("/orc mae line one\nline two")).toEqual({
      project: "mae",
      message: "line one\nline two",
    });
  });
  it("returns null for non-commands and missing arguments", () => {
    expect(parseOrcCommand("/orc")).toBeNull();
    expect(parseOrcCommand("/orc maestro")).toBeNull();
    expect(parseOrcCommand("just a reply")).toBeNull();
    expect(parseOrcCommand("/orchestrator do stuff")).toBeNull();
    expect(parseOrcCommand(undefined)).toBeNull();
  });
});

describe("readProjectsRegistry / buildOrcResolver", () => {
  it("parses projects: and resolves a token to <prefix>-orchestrator", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-tg-proj-"));
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      [
        "projects:",
        "  maestro-mac_bfd91d1315:",
        "    projectId: maestro-mac_bfd91d1315",
        "    displayName: Maestro",
        "    sessionPrefix: mae",
        "  budohub_1881240c6d:",
        "    projectId: budohub_1881240c6d",
        "    displayName: BudoHub",
        "    sessionPrefix: bud",
        "",
      ].join("\n"),
    );
    const entries = readProjectsRegistry(path);
    expect(entries).toEqual([
      { projectId: "maestro-mac_bfd91d1315", displayName: "Maestro", sessionPrefix: "mae" },
      { projectId: "budohub_1881240c6d", displayName: "BudoHub", sessionPrefix: "bud" },
    ]);

    const resolve = buildOrcResolver(entries);
    // case-insensitive match on displayName, sessionPrefix, or projectId
    expect(resolve("Maestro").sessionId).toBe("mae-orchestrator");
    expect(resolve("mae").sessionId).toBe("mae-orchestrator");
    expect(resolve("BUDOHUB_1881240C6D").sessionId).toBe("bud-orchestrator");
    // unknown token → null + the available menu
    const miss = resolve("nope");
    expect(miss.sessionId).toBeNull();
    expect(miss.available).toEqual(["Maestro", "BudoHub"]);
  });

  it("returns an empty registry when the file is absent", () => {
    expect(readProjectsRegistry(join(tmpdir(), "no-such-config-xyz.yaml"))).toEqual([]);
  });
});

describe("decideRoute — /orc command", () => {
  const chat = "999";
  const resolveOrc: OrcResolver = (project) => ({
    sessionId: project.toLowerCase() === "maestro" ? "mae-orchestrator" : null,
    available: ["Maestro", "BudoHub"],
  });

  it("routes a valid /orc to the project's orchestrator (no deletion)", () => {
    const parsed = parseUpdate({
      update_id: 10,
      message: { message_id: 5, chat: { id: 999 }, text: "/orc maestro deploy now" },
    })!;
    expect(decideRoute(parsed, chat, resolveOrc)).toEqual({
      sessionId: "mae-orchestrator",
      value: "deploy now",
    });
  });

  it("replies with the menu for an unknown project", () => {
    const parsed = parseUpdate({
      update_id: 11,
      message: { message_id: 6, chat: { id: 999 }, text: "/orc ghost do it" },
    })!;
    const route = decideRoute(parsed, chat, resolveOrc)!;
    expect(route.replyText).toBe('Unknown project "ghost". Available: Maestro, BudoHub');
    expect(route.sessionId).toBe("");
  });

  it("replies with usage when /orc has no arguments", () => {
    const parsed = parseUpdate({
      update_id: 12,
      message: { message_id: 7, chat: { id: 999 }, text: "/orc" },
    })!;
    const route = decideRoute(parsed, chat, resolveOrc)!;
    expect(route.replyText).toContain("Usage: /orc <project> <message>");
    expect(route.replyText).toContain("Maestro, BudoHub");
  });

  it("ignores /orc when no resolver is wired", () => {
    const parsed = parseUpdate({
      update_id: 13,
      message: { message_id: 8, chat: { id: 999 }, text: "/orc maestro hi" },
    })!;
    expect(decideRoute(parsed, chat)).toBeNull();
  });
});

describe("decideRoute — deleteMessageId", () => {
  const chat = "999";

  it("carries the quoted message id on a tagged reply", () => {
    const parsed = parseUpdate({
      update_id: 20,
      message: {
        message_id: 99,
        chat: { id: 999 },
        text: "use Postgres",
        reply_to_message: { message_id: 42, text: encodeSessionTag("mae-10") },
      },
    })!;
    expect(decideRoute(parsed, chat)).toEqual({
      sessionId: "mae-10",
      value: "use Postgres",
      deleteMessageId: 42,
    });
  });

  it("carries the keyboard message id on a button press", () => {
    const parsed = parseUpdate({
      update_id: 21,
      callback_query: {
        id: "cb9",
        data: encodeCallbackData("mae-10", "SQLite"),
        message: { message_id: 77, chat: { id: 999 } },
      },
    })!;
    expect(decideRoute(parsed, chat)).toEqual({
      sessionId: "mae-10",
      value: "SQLite",
      callbackId: "cb9",
      deleteMessageId: 77,
    });
  });
});
