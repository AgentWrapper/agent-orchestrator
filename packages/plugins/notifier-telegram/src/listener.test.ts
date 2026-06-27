import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  readListenerLock,
  acquireListenerLock,
  decideListenerAction,
  evictStrayListener,
  readPersistedOffset,
  writePersistedOffset,
  probeLatestUpdateId,
  resolveStartOffset,
  PendingChoices,
  type OrcResolver,
} from "./listener.js";
import {
  encodeSessionTag,
  parseSessionTag,
  encodeCallbackData,
  parseCallbackData,
  encodePendingCallback,
  parsePendingCallback,
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

describe("buildOrcResolver — fuzzy candidates", () => {
  const entries = [
    { projectId: "boschcenter_kz_1", displayName: "boschcenter.kz", sessionPrefix: "bos" },
    { projectId: "boston_2", displayName: "Boston", sessionPrefix: "bst" },
    { projectId: "maestro_x", displayName: "Maestro", sessionPrefix: "mae" },
  ];
  const resolve = buildOrcResolver(entries);

  it("returns no candidates on an exact match (routes directly)", () => {
    const r = resolve("Maestro");
    expect(r.sessionId).toBe("mae-orchestrator");
    expect(r.candidates).toEqual([]);
  });

  it("finds a single subsequence candidate: bosh → boschcenter.kz", () => {
    const r = resolve("bosh");
    expect(r.sessionId).toBeNull();
    expect(r.candidates).toEqual([{ sessionId: "bos-orchestrator", label: "boschcenter.kz" }]);
  });

  it("finds multiple substring candidates and skips non-matches", () => {
    // "os" is a substring of boschcenter.kz and Boston, but of no field exactly
    // (so it is not an exact match) and not of Maestro.
    const r = resolve("os");
    expect(r.sessionId).toBeNull();
    expect(r.candidates).toEqual([
      { sessionId: "bos-orchestrator", label: "boschcenter.kz" },
      { sessionId: "bst-orchestrator", label: "Boston" },
    ]);
  });

  it("returns zero candidates when nothing matches", () => {
    const r = resolve("zzz");
    expect(r.sessionId).toBeNull();
    expect(r.candidates).toEqual([]);
    expect(r.available).toEqual(["boschcenter.kz", "Boston", "Maestro"]);
  });

  it("ignores entries without a sessionPrefix (unroutable)", () => {
    const r = buildOrcResolver([{ projectId: "noprefix_kz", displayName: "noprefix.kz" }])("noprefix");
    expect(r.sessionId).toBeNull();
    expect(r.candidates).toEqual([]);
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

describe("decideRoute — fuzzy /orc → reply with buttons", () => {
  const chat = "999";
  const resolveOrc: OrcResolver = (project) => {
    const token = project.toLowerCase();
    if (token === "maestro") return { sessionId: "mae-orchestrator", candidates: [], available: ["Maestro"] };
    if (token === "bosh")
      return {
        sessionId: null,
        candidates: [{ sessionId: "bos-orchestrator", label: "boschcenter.kz" }],
        available: ["Maestro", "boschcenter.kz"],
      };
    return { sessionId: null, candidates: [], available: ["Maestro", "boschcenter.kz"] };
  };

  it("offers candidate buttons carrying the original message when the match is fuzzy", () => {
    const parsed = parseUpdate({
      update_id: 30,
      message: { message_id: 5, chat: { id: 999 }, text: "/orc bosh статус?" },
    })!;
    expect(decideRoute(parsed, chat, resolveOrc)).toEqual({
      sessionId: "",
      value: "",
      replyButtons: [{ sessionId: "bos-orchestrator", label: "boschcenter.kz" }],
      replyButtonsValue: "статус?",
    });
  });

  it("still routes an exact match directly (no buttons)", () => {
    const parsed = parseUpdate({
      update_id: 31,
      message: { message_id: 6, chat: { id: 999 }, text: "/orc maestro deploy now" },
    })!;
    expect(decideRoute(parsed, chat, resolveOrc)).toEqual({ sessionId: "mae-orchestrator", value: "deploy now" });
  });

  it("falls back to the Unknown-project menu when there are no candidates", () => {
    const parsed = parseUpdate({
      update_id: 32,
      message: { message_id: 7, chat: { id: 999 }, text: "/orc ghost hi" },
    })!;
    const route = decideRoute(parsed, chat, resolveOrc)!;
    expect(route.replyButtons).toBeUndefined();
    expect(route.replyText).toBe('Unknown project "ghost". Available: Maestro, boschcenter.kz');
  });
});

describe("PendingChoices store", () => {
  it("round-trips a (session, value) pair and consumes it on take", () => {
    const store = new PendingChoices();
    const id = store.put({ sessionId: "bos-orchestrator", value: "статус? " + "x".repeat(200) });
    expect(store.take(id)).toEqual({ sessionId: "bos-orchestrator", value: "статус? " + "x".repeat(200) });
    expect(store.take(id)).toBeNull(); // one-shot
  });

  it("returns null for an unknown id", () => {
    expect(new PendingChoices().take("nope")).toBeNull();
  });

  it("evicts the oldest entry past its cap", () => {
    const store = new PendingChoices(2);
    const a = store.put({ sessionId: "a", value: "1" });
    store.put({ sessionId: "b", value: "2" });
    store.put({ sessionId: "c", value: "3" }); // evicts `a`
    expect(store.take(a)).toBeNull();
  });
});

describe("pending callback data", () => {
  it("round-trips a pending id within the 64-byte budget", () => {
    const data = encodePendingCallback("abc123def456");
    expect(parsePendingCallback(data)).toBe("abc123def456");
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
  });

  it("is disjoint from direct value callbacks", () => {
    // a pending payload is not a direct callback, and vice-versa
    expect(parseCallbackData(encodePendingCallback("id1"))).toBeNull();
    expect(parsePendingCallback(encodeCallbackData("mae-10", "Postgres"))).toBeNull();
    expect(parsePendingCallback("garbage")).toBeNull();
  });
});

describe("decideRoute — fuzzy button press delivers the original question", () => {
  const chat = "999";

  it("resolves a pending callback to its session + original (long) text", () => {
    const store = new PendingChoices();
    const longText = "статус? " + "y".repeat(300);
    const id = store.put({ sessionId: "bos-orchestrator", value: longText });
    const parsed = parseUpdate({
      update_id: 40,
      callback_query: {
        id: "cbX",
        data: encodePendingCallback(id),
        message: { message_id: 88, chat: { id: 999 } },
      },
    })!;
    const route = decideRoute(parsed, chat, undefined, (pid) => store.take(pid));
    expect(route).toEqual({
      sessionId: "bos-orchestrator",
      value: longText,
      callbackId: "cbX",
    });
  });

  it("drops a stale/expired pending press (nothing in the store)", () => {
    const parsed = parseUpdate({
      update_id: 41,
      callback_query: { id: "cbY", data: encodePendingCallback("gone"), message: { chat: { id: 999 } } },
    })!;
    expect(decideRoute(parsed, chat, undefined, () => null)).toBeNull();
  });
});

describe("decideRoute — answered messages are preserved (no deletion)", () => {
  const chat = "999";

  it("routes a tagged reply without asking to delete the quoted question", () => {
    const parsed = parseUpdate({
      update_id: 20,
      message: {
        message_id: 99,
        chat: { id: 999 },
        text: "use Postgres",
        reply_to_message: { message_id: 42, text: encodeSessionTag("mae-10") },
      },
    })!;
    // No deleteMessageId — the question + answer stay in the chat history.
    expect(decideRoute(parsed, chat)).toEqual({ sessionId: "mae-10", value: "use Postgres" });
  });

  it("routes a button press without asking to delete the keyboard message", () => {
    const parsed = parseUpdate({
      update_id: 21,
      callback_query: {
        id: "cb9",
        data: encodeCallbackData("mae-10", "SQLite"),
        message: { message_id: 77, chat: { id: 999 } },
      },
    })!;
    expect(decideRoute(parsed, chat)).toEqual({ sessionId: "mae-10", value: "SQLite", callbackId: "cb9" });
  });
});

// ---------------------------------------------------------------------------
// Listener lock: owner mark + durable-restart eviction
// ---------------------------------------------------------------------------

describe("listener lock — owner mark round-trip", () => {
  it("writes and reads back the owner mark via acquire", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-tg-lock-"));
    const path = join(dir, "telegram-listener.pid");
    process.env.AO_TELEGRAM_OWNER_ID = "owner-mae";
    try {
      expect(acquireListenerLock(path)).toBe(true);
      expect(readListenerLock(path)).toEqual({ listenerPid: process.pid, ownerId: "owner-mae" });
    } finally {
      delete process.env.AO_TELEGRAM_OWNER_ID;
    }
  });

  it("reads a legacy bare-pid lock as an owner-less holder", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-tg-lock-"));
    const path = join(dir, "telegram-listener.pid");
    writeFileSync(path, "424242");
    expect(readListenerLock(path)).toEqual({ listenerPid: 424242, ownerId: undefined });
  });

  it("returns null for an absent lock", () => {
    expect(readListenerLock(join(tmpdir(), "no-such-listener-lock-xyz.pid"))).toBeNull();
  });
});

describe("decideListenerAction", () => {
  const live = () => true;
  const dead = () => false;

  it("spawns when there is no lock", () => {
    expect(decideListenerAction(null, "me", live)).toBe("spawn");
  });

  it("spawns when the holder is dead", () => {
    expect(decideListenerAction({ listenerPid: 4242, ownerId: "other" }, "me", dead)).toBe("spawn");
  });

  it("skips (no double-spawn) when a live listener of the same owner holds the lock", () => {
    expect(decideListenerAction({ listenerPid: 4242, ownerId: "me" }, "me", live)).toBe("skip");
  });

  it("evicts a live listener owned by a different daemon", () => {
    expect(decideListenerAction({ listenerPid: 4242, ownerId: "other" }, "me", live)).toBe("evict");
  });

  it("evicts a live legacy (owner-less) listener", () => {
    expect(decideListenerAction({ listenerPid: 4242 }, "me", live)).toBe("evict");
  });
});

describe("acquireListenerLock — eviction & single-instance", () => {
  beforeEach(() => {
    process.env.AO_TELEGRAM_OWNER_ID = "owner-mine";
  });
  afterEach(() => {
    delete process.env.AO_TELEGRAM_OWNER_ID;
  });

  function lockFile(): string {
    return join(mkdtempSync(join(tmpdir(), "ao-tg-lock-")), "telegram-listener.pid");
  }

  it("claims a free lock and stamps our pid + owner", () => {
    const path = lockFile();
    expect(acquireListenerLock(path)).toBe(true);
    expect(readListenerLock(path)).toEqual({ listenerPid: process.pid, ownerId: "owner-mine" });
  });

  it("refuses when a live listener of the SAME owner already holds it", () => {
    const path = lockFile();
    writeFileSync(path, JSON.stringify({ listenerPid: 999999, ownerId: "owner-mine" }));
    expect(acquireListenerLock(path, () => true)).toBe(false);
    // Lock is left untouched — we must not steal it from our live sibling.
    expect(readListenerLock(path)).toEqual({ listenerPid: 999999, ownerId: "owner-mine" });
  });

  it("takes over when a live listener of a DIFFERENT owner holds it", () => {
    const path = lockFile();
    writeFileSync(path, JSON.stringify({ listenerPid: 999999, ownerId: "owner-prev-daemon" }));
    expect(acquireListenerLock(path, () => true)).toBe(true);
    expect(readListenerLock(path)).toEqual({ listenerPid: process.pid, ownerId: "owner-mine" });
  });

  it("claims a lock whose holder is dead, regardless of owner", () => {
    const path = lockFile();
    writeFileSync(path, JSON.stringify({ listenerPid: 999999, ownerId: "owner-mine" }));
    expect(acquireListenerLock(path, () => false)).toBe(true);
    expect(readListenerLock(path)).toEqual({ listenerPid: process.pid, ownerId: "owner-mine" });
  });
});

// ---------------------------------------------------------------------------
// Fix A — long-poll offset persistence + skip-to-latest (no /orc replay)
// ---------------------------------------------------------------------------

describe("offset persistence", () => {
  it("writes and reads back an offset atomically (resume-from-last)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-tg-off-"));
    const path = join(dir, "telegram-listener.offset");
    writePersistedOffset(4242, path);
    expect(readPersistedOffset(path)).toBe(4242);
  });

  it("treats a missing file as no offset (null → first run)", () => {
    expect(readPersistedOffset(join(tmpdir(), "no-such-offset-xyz"))).toBeNull();
  });

  it("treats a corrupt file as no offset (null → first-run skip, never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-tg-off-"));
    const path = join(dir, "telegram-listener.offset");
    writeFileSync(path, "not-a-number");
    expect(readPersistedOffset(path)).toBeNull();
  });
});

describe("resolveStartOffset", () => {
  it("resumes from the persisted offset — no probe, no replay", async () => {
    let probed = false;
    const r = await resolveStartOffset({
      readPersisted: () => 5000,
      probeLatest: async () => {
        probed = true;
        return 999;
      },
    });
    expect(r).toEqual({ offset: 5000, seeded: false });
    expect(probed).toBe(false); // a resume never re-probes the backlog
  });

  it("first run WITH a backlog → skip-to-latest (lastId + 1), marked seeded", async () => {
    const r = await resolveStartOffset({ readPersisted: () => null, probeLatest: async () => 7777 });
    expect(r).toEqual({ offset: 7778, seeded: true });
  });

  it("first run with an empty queue → offset 0, not seeded", async () => {
    const r = await resolveStartOffset({ readPersisted: () => null, probeLatest: async () => null });
    expect(r).toEqual({ offset: 0, seeded: false });
  });
});

describe("first-run skip-to-latest drops the backlog (reproduces & fixes /orc replay)", () => {
  // A fetch-mock standing in for Telegram getUpdates(offset=-1).
  const mockFetch = (result: unknown[]): typeof fetch =>
    (async () => ({ json: async () => ({ ok: true, result }) })) as unknown as typeof fetch;

  it("jumps PAST a queued /orc backlog so old commands are never re-routed", async () => {
    // The incident: a crash-loop left old `/orc` commands queued (ids 100,101,102).
    // With the old `offset = 0` a fresh listener would re-read and re-inject all three.
    const backlog = [100, 101, 102].map((id) => ({
      update_id: id,
      message: { chat: { id: 999 }, text: `/orc maestro stale command ${id}` },
    }));
    const fetchFn = mockFetch(backlog);

    const last = await probeLatestUpdateId("TKN", fetchFn);
    expect(last).toBe(102);

    const start = await resolveStartOffset({
      readPersisted: () => null,
      probeLatest: () => probeLatestUpdateId("TKN", fetchFn),
    });
    // The next real poll starts ABOVE every backlog id → Telegram confirms+drops them
    // and not one of the stale `/orc` commands is ever handed to decideRoute.
    expect(start).toEqual({ offset: 103, seeded: true });
    expect(start.offset).toBeGreaterThan(Math.max(...backlog.map((b) => b.update_id)));
  });

  it("probeLatestUpdateId returns null on an empty queue (nothing to skip)", async () => {
    expect(await probeLatestUpdateId("TKN", mockFetch([]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix B — hard singleton: build-stable owner + synchronous eviction
// ---------------------------------------------------------------------------

describe("evictStrayListener — synchronous kill before respawn", () => {
  it("SIGTERMs a live stray and returns once it is gone (no SIGKILL needed)", () => {
    const signals: Array<string | number> = [];
    let aliveCalls = 0;
    evictStrayListener(4242, {
      kill: (_pid, sig) => signals.push(sig),
      // alive on the pre-check, dead on the first poll after SIGTERM (graceful exit).
      alive: () => aliveCalls++ === 0,
      sleep: () => {},
    });
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when SIGTERM doesn't take", () => {
    const signals: Array<string | number> = [];
    evictStrayListener(4242, {
      kill: (_pid, sig) => signals.push(sig),
      alive: () => true, // deaf to SIGTERM → must be forced
      sleep: () => {},
    });
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
  });

  it("kills a stray held by a legacy / owner-less lock (just a bare pid)", () => {
    // The exact prod state this fix migrates from: the lock has a live listenerPid
    // whose owning daemon is dead (no ownerId). evictStrayListener works off the bare
    // pid alone — no owner needed to clear it.
    const signals: Array<string | number> = [];
    let aliveCalls = 0;
    evictStrayListener(80523, {
      kill: (_pid, sig) => signals.push(sig),
      alive: () => aliveCalls++ === 0,
      sleep: () => {},
    });
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("is a no-op for a dead, invalid, or self pid", () => {
    const signals: Array<string | number> = [];
    evictStrayListener(4242, { kill: (_p, s) => signals.push(s), alive: () => false, sleep: () => {} });
    evictStrayListener(0, { kill: (_p, s) => signals.push(s), alive: () => true, sleep: () => {} });
    evictStrayListener(process.pid, { kill: (_p, s) => signals.push(s), alive: () => true, sleep: () => {} });
    expect(signals).toEqual([]);
  });
});

describe("crash-restart cycle — build-stable owner prevents the 3-listener pile-up", () => {
  const live = () => true;

  it("every restart of the SAME build SKIPS (one listener total), unlike per-restart random owners", () => {
    // One live listener, owned by the running build.
    const buildOwner = "engine:/Applications/Maestro.app/.../listener.js:1700000000000";
    const lock = { listenerPid: 80523, ownerId: buildOwner };

    // OLD model — each restart minted a fresh `pid:random` owner, so every daemon saw
    // the lock as foreign and evicted+spawned: three restarts ⇒ three new listeners.
    const oldActions = ["111:aaaa", "222:bbbb", "333:cccc"].map((o) => decideListenerAction(lock, o, live));
    expect(oldActions).toEqual(["evict", "evict", "evict"]); // ⇐ reproduces the pile-up

    // NEW model — the build owner is identical across restarts, so every daemon skips
    // and the single live listener is never duplicated.
    const newActions = [buildOwner, buildOwner, buildOwner].map((o) => decideListenerAction(lock, o, live));
    expect(newActions).toEqual(["skip", "skip", "skip"]); // ⇐ the fix: at most one
  });

  it("a genuine engine UPGRADE (different build owner) still evicts the stale listener", () => {
    const lock = { listenerPid: 80523, ownerId: "engine:/path/listener.js:1700000000000" };
    const upgraded = "engine:/path/listener.js:1700009999999"; // newer mtime = new build
    expect(decideListenerAction(lock, upgraded, live)).toBe("evict");
  });

  it("a legacy / owner-less stray is still evicted by the current build", () => {
    expect(decideListenerAction({ listenerPid: 80523 }, "engine:/path:1700000000000", live)).toBe("evict");
  });

  it("the same-build acquire net refuses a second concurrent listener (no double-poll)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ao-tg-lock-")), "telegram-listener.pid");
    process.env.AO_TELEGRAM_OWNER_ID = "engine:build-x";
    try {
      writeFileSync(path, JSON.stringify({ listenerPid: 999999, ownerId: "engine:build-x" }));
      // A sibling listener of the same build is already live → we must not start a second.
      expect(acquireListenerLock(path, () => true)).toBe(false);
    } finally {
      delete process.env.AO_TELEGRAM_OWNER_ID;
    }
  });
});
