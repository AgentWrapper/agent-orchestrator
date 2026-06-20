import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorEvent } from "@aoagents/ao-core";
import { create, manifest } from "./index.js";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "session.needs_input",
    priority: "action",
    sessionId: "mae-10",
    projectId: "maestro",
    timestamp: new Date("2026-06-20T12:00:00Z"),
    message: "Which database should I use?",
    data: { schemaVersion: 3, subject: { session: { id: "mae-10", projectId: "maestro" } } },
    ...overrides,
  };
}

/** A fetch mock returning a Telegram-style `{ ok: true }` JSON body. */
function okFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: {} }),
  });
}

const TOKEN = "123456:ABC-DEF";

describe("notifier-telegram", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has the correct manifest", () => {
    expect(manifest.name).toBe("telegram");
    expect(manifest.slot).toBe("notifier");
  });

  it("posts to the Telegram sendMessage endpoint with chat id + text", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ botToken: TOKEN, chatId: "999" });
    await notifier.notify(makeEvent());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe("999");
    expect(body.text).toContain("Agent needs input");
    expect(body.text).toContain("Which database should I use?");
    // Session tag must be embedded so an inbound reply can be routed back.
    expect(body.text).toContain("ao:session=mae-10");
  });

  it("coerces a numeric chatId (negative group ids)", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ botToken: TOKEN, chatId: -100500 });
    await notifier.notify(makeEvent());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.chat_id).toBe("-100500");
  });

  it("is a no-op when botToken or chatId is missing", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await create({ botToken: TOKEN }).notify(makeEvent());
    await create({ chatId: "999" }).notify(makeEvent());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders an inline keyboard from event option choices", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ botToken: TOKEN, chatId: "999" });
    await notifier.notify(
      makeEvent({
        data: {
          schemaVersion: 3,
          subject: { session: { id: "mae-10", projectId: "maestro" } },
          options: ["Postgres", "SQLite"],
        },
      }),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reply_markup.inline_keyboard).toHaveLength(2);
    const first = body.reply_markup.inline_keyboard[0][0];
    expect(first.text).toBe("Postgres");
    // callback_data carries the session + selected value back to the listener.
    expect(first.callback_data).toContain("mae-10");
    expect(first.callback_data).toContain("Postgres");
  });

  it("notifyWithActions adds URL buttons", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ botToken: TOKEN, chatId: "999" });
    await notifier.notifyWithActions!(makeEvent(), [
      { label: "View PR", url: "https://github.com/x/y/pull/1" },
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const flat = body.reply_markup.inline_keyboard.flat();
    expect(flat.some((b: { url?: string }) => b.url === "https://github.com/x/y/pull/1")).toBe(true);
  });

  it("post() sends a plain message", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ botToken: TOKEN, chatId: "999" });
    const result = await notifier.post!("hello world");

    expect(result).toBeNull();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe("hello world");
  });

  it("throws on a non-retryable Telegram error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error_code: 400, description: "chat not found" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ botToken: TOKEN, chatId: "999", retries: 0 });
    await expect(notifier.notify(makeEvent())).rejects.toThrow(/chat not found/);
  });
});
