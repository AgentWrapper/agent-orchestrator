import { beforeEach, expect, it, vi } from "vitest";

import {
  clearChatEventCache,
  prefetchChatEvents,
  readChatEventCache,
} from "./cloud-chat-cache";
import { type CloudAPI, type CloudEvent } from "./cloud-api";

function chatEvent(sequence: number): CloudEvent {
  return {
    sessionId: "session-one",
    sequence,
    type: "chat.assistant_delta",
    payload: { text: String(sequence) },
    createdAt: "2026-07-30T00:00:00Z",
  };
}

beforeEach(() => clearChatEventCache());

it("paginates, caches, and throttles background chat replay", async () => {
  const firstPage = Array.from({ length: 500 }, (_, index) =>
    chatEvent(index + 1),
  );
  const chatEvents = vi
    .fn()
    .mockResolvedValueOnce({ events: firstPage })
    .mockResolvedValueOnce({ events: [chatEvent(501)] });
  const api = { chatEvents } as unknown as CloudAPI;

  const cached = await prefetchChatEvents(api, "session-one", 0);

  expect(cached.hydrated).toBe(true);
  expect(cached.events).toHaveLength(501);
  expect(chatEvents).toHaveBeenNthCalledWith(1, "session-one", 0, 500);
  expect(chatEvents).toHaveBeenNthCalledWith(2, "session-one", 500, 500);

  await prefetchChatEvents(api, "session-one", 60_000);
  expect(chatEvents).toHaveBeenCalledTimes(2);
  expect(readChatEventCache("session-one").events.at(-1)?.sequence).toBe(501);
});
