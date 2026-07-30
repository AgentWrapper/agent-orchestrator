import { type CloudAPI, type CloudEvent } from "./cloud-api";

type ChatCacheEntry = {
  events: CloudEvent[];
  hydrated: boolean;
  fetchedAt: number;
};

const entries = new Map<string, ChatCacheEntry>();
const inFlight = new Map<string, Promise<ChatCacheEntry>>();

function mergeEvents(
  current: CloudEvent[],
  incoming: CloudEvent[],
): CloudEvent[] {
  const events = new Map(current.map((event) => [event.sequence, event]));
  for (const event of incoming) {
    if (event.type.startsWith("chat.")) events.set(event.sequence, event);
  }
  return [...events.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export function readChatEventCache(sessionId: string): ChatCacheEntry {
  const entry = entries.get(sessionId);
  return entry
    ? { ...entry, events: [...entry.events] }
    : { events: [], hydrated: false, fetchedAt: 0 };
}

export function mergeChatEventCache(
  sessionId: string,
  events: CloudEvent[],
  hydrated = false,
): ChatCacheEntry {
  const current = readChatEventCache(sessionId);
  const entry = {
    events: mergeEvents(current.events, events),
    hydrated: current.hydrated || hydrated,
    fetchedAt: Date.now(),
  };
  entries.set(sessionId, entry);
  return entry;
}

export function prefetchChatEvents(
  api: CloudAPI,
  sessionId: string,
  minimumIntervalMs: number,
): Promise<ChatCacheEntry> {
  const current = readChatEventCache(sessionId);
  if (current.hydrated && Date.now() - current.fetchedAt < minimumIntervalMs) {
    return Promise.resolve(current);
  }
  const existing = inFlight.get(sessionId);
  if (existing) return existing;

  const request = (async () => {
    let cached = current;
    let after = cached.events.reduce(
      (latest, event) => Math.max(latest, event.sequence),
      0,
    );
    for (;;) {
      const replay = await api.chatEvents(sessionId, after, 500);
      cached = mergeChatEventCache(sessionId, replay.events);
      if (replay.events.length < 500) break;
      const next = replay.events.reduce(
        (latest, event) => Math.max(latest, event.sequence),
        after,
      );
      if (next <= after) break;
      after = next;
    }
    cached = mergeChatEventCache(sessionId, [], true);
    return cached;
  })();
  const tracked = request.finally(() => {
    if (inFlight.get(sessionId) === tracked) inFlight.delete(sessionId);
  });
  inFlight.set(sessionId, tracked);
  return tracked;
}

export function releaseChatEventPrefetch(sessionId: string) {
  inFlight.delete(sessionId);
}

export function pruneChatEventCache(sessionIds: Set<string>) {
  for (const sessionId of entries.keys()) {
    if (!sessionIds.has(sessionId)) entries.delete(sessionId);
  }
}

export function clearChatEventCache() {
  entries.clear();
  inFlight.clear();
}
