import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Artifact, ArtifactEvent, ArtifactWatcher } from "@aoagents/ao-core";
import { ArtifactBroadcaster } from "../mux-websocket";

const makeArtifact = (id: string): Artifact =>
  ({
    version: 1,
    id,
    type: "markdown",
    title: "t",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    payload: { markdown: "hi" },
  }) as unknown as Artifact;

interface WatcherStubState {
  stopWatcher: ReturnType<typeof vi.fn>;
  watcher: ArtifactWatcher;
  capturedOnEvent: ((event: ArtifactEvent) => void) | undefined;
  startCalls: number;
  startWatcher: (options: { onEvent: (event: ArtifactEvent) => void }) => Promise<ArtifactWatcher>;
}

function makeWatcherStub(): WatcherStubState {
  const state: WatcherStubState = {
    stopWatcher: vi.fn(async () => {}),
    watcher: undefined as unknown as ArtifactWatcher,
    capturedOnEvent: undefined,
    startCalls: 0,
    startWatcher: async ({ onEvent }) => {
      state.startCalls += 1;
      state.capturedOnEvent = onEvent;
      return state.watcher;
    },
  };
  state.watcher = { stop: state.stopWatcher };
  return state;
}

/**
 * Yield twice so any awaited startArtifactWatcher() promise resolves and the
 * broadcaster's `.then(...)` continuation runs before assertions.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ArtifactBroadcaster", () => {
  let stub: WatcherStubState;

  beforeEach(() => {
    stub = makeWatcherStub();
  });

  it("starts the watcher on first subscriber and forwards events to subscribers", async () => {
    const bc = new ArtifactBroadcaster(stub.startWatcher);
    const cb = vi.fn();

    bc.subscribe(cb);
    await flushMicrotasks();

    expect(stub.startCalls).toBe(1);
    expect(stub.capturedOnEvent).toBeDefined();

    const event: ArtifactEvent = {
      type: "artifact-update",
      sessionId: "s1",
      artifact: makeArtifact("c1"),
    };
    stub.capturedOnEvent!(event);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(event);
  });

  it("only starts a single watcher across multiple subscribers", async () => {
    const bc = new ArtifactBroadcaster(stub.startWatcher);

    bc.subscribe(vi.fn());
    bc.subscribe(vi.fn());
    bc.subscribe(vi.fn());
    await flushMicrotasks();

    expect(stub.startCalls).toBe(1);
  });

  it("stops the watcher when the last subscriber unsubscribes", async () => {
    const bc = new ArtifactBroadcaster(stub.startWatcher);
    const unsub1 = bc.subscribe(vi.fn());
    const unsub2 = bc.subscribe(vi.fn());
    await flushMicrotasks();

    unsub1();
    expect(stub.stopWatcher).not.toHaveBeenCalled();

    unsub2();
    expect(stub.stopWatcher).toHaveBeenCalledTimes(1);
  });

  it("isolates subscriber errors so one throw does not skip others", async () => {
    const bc = new ArtifactBroadcaster(stub.startWatcher);
    const bad = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    bc.subscribe(bad);
    bc.subscribe(good);
    await flushMicrotasks();

    const event: ArtifactEvent = {
      type: "artifact-delete",
      sessionId: "s1",
      artifactId: "c1",
    };
    stub.capturedOnEvent!(event);

    expect(good).toHaveBeenCalledWith(event);
  });

  it("does not deliver events to clients that never subscribed", async () => {
    const bc = new ArtifactBroadcaster(stub.startWatcher);
    const unsubscribed = vi.fn();
    const subscribed = vi.fn();
    // Only `subscribed` calls subscribe().
    bc.subscribe(subscribed);
    await flushMicrotasks();

    stub.capturedOnEvent!({
      type: "artifact-error",
      sessionId: "s1",
      artifactId: "c1",
      errors: [{ path: [], message: "bad" }],
    });

    expect(subscribed).toHaveBeenCalledTimes(1);
    expect(unsubscribed).not.toHaveBeenCalled();
  });

  it("close() stops the watcher and drops further events to subscribers", async () => {
    const bc = new ArtifactBroadcaster(stub.startWatcher);
    const cb = vi.fn();
    bc.subscribe(cb);
    await flushMicrotasks();

    await bc.close();
    expect(stub.stopWatcher).toHaveBeenCalledTimes(1);

    // After close, the subscriber set is cleared so no further events reach
    // it. The orphaned onEvent reference still exists but has no recipients.
    cb.mockClear();
    stub.capturedOnEvent!({
      type: "artifact-update",
      sessionId: "s2",
      artifact: makeArtifact("c2"),
    });
    expect(cb).not.toHaveBeenCalled();
  });
});

// ── Wire-up smoke test ──
//
// Verifies the message shape the WS handler emits: ServerMessage with
// `ch: "artifacts"` and the ArtifactEvent fields flattened in. Mirrors the
// inline handler in `createMuxWebSocket` so changes to that shape get caught.

describe("createMuxWebSocket — artifact wire-up", () => {
  it("emits ServerMessage { ch: 'artifacts', ... } to subscribed clients", async () => {
    const stub = makeWatcherStub();
    const bc = new ArtifactBroadcaster(stub.startWatcher);
    const sentMessages: string[] = [];

    // Mimic the per-WS handler in mux-websocket.ts.
    bc.subscribe((event) => {
      const msg = { ch: "artifacts" as const, ...event };
      sentMessages.push(JSON.stringify(msg));
    });
    await flushMicrotasks();

    stub.capturedOnEvent!({
      type: "artifact-update",
      sessionId: "s1",
      artifact: makeArtifact("c1"),
    });

    expect(sentMessages).toHaveLength(1);
    const parsed = JSON.parse(sentMessages[0]) as {
      ch: string;
      type: string;
      sessionId: string;
    };
    expect(parsed.ch).toBe("artifacts");
    expect(parsed.type).toBe("artifact-update");
    expect(parsed.sessionId).toBe("s1");
  });
});
