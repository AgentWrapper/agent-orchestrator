import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SessionHost, type SessionHostOptions } from "../sdk-host.js";

const FIXED = () => new Date("2026-06-23T00:00:00.000Z");

function makeHost(extra: Partial<SessionHostOptions> = {}) {
  const persisted: string[] = [];
  const host = new SessionHost({
    aoSessionId: "sess1",
    permissionMode: "bypassPermissions",
    persist: (line) => persisted.push(line),
    now: FIXED,
    ...extra,
  });
  return { host, persisted };
}

async function* iter(...msgs: unknown[]): AsyncIterable<SDKMessage> {
  for (const m of msgs) yield m as SDKMessage;
}

describe("SessionHost.emit", () => {
  it("stamps the envelope and increments seq", () => {
    const { host, persisted } = makeHost();
    const e1 = host.emit({ type: "text-delta", block: 0, text: "a" });
    const e2 = host.emit({ type: "text-delta", block: 0, text: "b" });
    expect(e1).toMatchObject({ v: 1, seq: 0, ts: "2026-06-23T00:00:00.000Z", session_id: null, turn: 0 });
    expect(e2.seq).toBe(1);
    expect(persisted).toHaveLength(2);
    expect(JSON.parse(persisted[0])).toMatchObject({ type: "text-delta", seq: 0 });
  });
});

describe("SessionHost.subscribe (snapshot -> live)", () => {
  it("sends hello, replays buffered events, marks snapshot-complete, then streams live", () => {
    const { host } = makeHost();
    host.emit({ type: "text-delta", block: 0, text: "before" });

    const lines: Array<Record<string, unknown>> = [];
    host.subscribe((line) => lines.push(JSON.parse(line)));

    // snapshot: hello, the one buffered event, snapshot-complete
    expect(lines[0]).toMatchObject({ type: "hello", role: "host", seq_head: 0 });
    expect(lines[1]).toMatchObject({ type: "text-delta", text: "before", seq: 0 });
    expect(lines[2]).toMatchObject({ type: "snapshot-complete", seq: 0 });

    // live: subsequent events are pushed to the subscriber
    host.emit({ type: "text-delta", block: 0, text: "after" });
    expect(lines[3]).toMatchObject({ type: "text-delta", text: "after", seq: 1 });
  });

  it("a late subscriber still receives the in-progress backlog", () => {
    const { host } = makeHost();
    host.emit({ type: "text-delta", block: 0, text: "x" });
    host.emit({ type: "text-delta", block: 0, text: "y" });
    const lines: Array<Record<string, unknown>> = [];
    host.subscribe((line) => lines.push(JSON.parse(line)));
    const replayed = lines.filter((l) => l.type === "text-delta");
    expect(replayed).toHaveLength(2);
  });
});

describe("SessionHost turns", () => {
  it("submitTurn increments the turn counter", () => {
    const { host } = makeHost();
    expect(host.status().turns).toBe(0);
    host.submitTurn("hello");
    expect(host.status().turns).toBe(1);
    host.submitTurn("again");
    expect(host.status().turns).toBe(2);
  });

  it("emits a user/input event on submitTurn (complete transcript)", () => {
    const { host, persisted } = makeHost();
    host.submitTurn("first turn text");
    const ev = persisted.map((l) => JSON.parse(l)).find((e) => e.type === "user");
    expect(ev).toMatchObject({
      type: "user",
      subtype: "input",
      text: "first turn text",
      turn: 1,
      seq: 0,
    });
  });
});

describe("SessionHost hello frame (epoch + resume markers)", () => {
  it("marks a fresh, non-resumed host", () => {
    const { host } = makeHost();
    const lines: Array<Record<string, unknown>> = [];
    host.subscribe((l) => lines.push(JSON.parse(l)));
    expect(lines[0]).toMatchObject({
      type: "hello",
      epoch: 0,
      resumed: false,
      resumed_from: null,
    });
  });

  it("advertises the host-instance epoch and resume markers", () => {
    const { host } = makeHost({ epoch: 3, resumeFrom: "sdk-prev" });
    const lines: Array<Record<string, unknown>> = [];
    host.subscribe((l) => lines.push(JSON.parse(l)));
    expect(lines[0]).toMatchObject({
      type: "hello",
      epoch: 3,
      resumed: true,
      resumed_from: "sdk-prev",
    });
  });
});

describe("SessionHost.consume", () => {
  it("captures session_id from init and stamps it on subsequent events", async () => {
    const { host, persisted } = makeHost();
    const seenInfo: Array<{ sdkSessionId: string | null }> = [];
    host.onSessionInfo = (p) => seenInfo.push(p);

    await host.consume(
      iter(
        { type: "system", subtype: "init", session_id: "sdk-abc", model: "claude-opus-4-8", cwd: "/w", permissionMode: "bypassPermissions", tools: [] },
        { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } },
        { type: "result", subtype: "success", is_error: false, result: "hi", num_turns: 1, duration_ms: 5, total_cost_usd: 0.1, usage: {}, modelUsage: { "claude-opus-4-8": {} } },
      ),
    );

    const events = persisted.map((l) => JSON.parse(l));
    const init = events.find((e) => e.type === "session" && e.subtype === "init");
    expect(init).toMatchObject({ session_id: "sdk-abc" });
    const delta = events.find((e) => e.type === "text-delta");
    expect(delta.session_id).toBe("sdk-abc");
    // session.json hook fired with the provider id
    expect(seenInfo.some((p) => p.sdkSessionId === "sdk-abc")).toBe(true);
    // ends with a session/end event
    expect(events[events.length - 1]).toMatchObject({ type: "session", subtype: "end" });
  });

  it("emits session/resumed first when resuming and pre-stamps the provider id", async () => {
    const { host, persisted } = makeHost({ resumeFrom: "sdk-prev" });
    await host.consume(iter());
    const events = persisted.map((l) => JSON.parse(l));
    expect(events[0]).toMatchObject({ type: "session", subtype: "resumed", session_id: "sdk-prev" });
    // events carry the resumed provider id from the start
    expect(events[0].session_id).toBe("sdk-prev");
  });

  it("emits a fatal error event when the stream throws", async () => {
    const { host, persisted } = makeHost();
    const boom: AsyncIterable<SDKMessage> = {
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error("stream broke")) };
      },
    };
    await host.consume(boom);
    const events = persisted.map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "error" && e.fatal === true && e.message === "stream broke")).toBe(true);
  });
});

describe("SessionHost permission seam", () => {
  it("emits permission_request, then resolves allow + emits permission_resolved", async () => {
    const { host, persisted } = makeHost();
    const decision = host.canUseTool("Bash", { command: "ls" });

    const req = persisted.map((l) => JSON.parse(l)).find((e) => e.type === "permission_request");
    expect(req).toMatchObject({ tool_name: "Bash", request_id: "perm-1", input: { command: "ls" } });

    host.resolvePermission("perm-1", "allow");
    await expect(decision).resolves.toMatchObject({ behavior: "allow" });

    const resolved = persisted.map((l) => JSON.parse(l)).find((e) => e.type === "permission_resolved");
    expect(resolved).toMatchObject({ request_id: "perm-1", behavior: "allow" });
  });

  it("resolves deny with a message", async () => {
    const { host } = makeHost();
    const decision = host.canUseTool("Write", { file_path: "x" });
    host.resolvePermission("perm-1", "deny", "nope");
    await expect(decision).resolves.toMatchObject({ behavior: "deny", message: "nope" });
  });

  it("defaults to deny after the permission timeout elapses", async () => {
    const { host } = makeHost({ permissionTimeoutMs: 10 });
    const decision = host.canUseTool("Bash", {});
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
  });
});

describe("SessionHost.renderOutput", () => {
  it("renders a readable tail across event types", () => {
    const { host } = makeHost();
    host.emit({ type: "text-delta", block: 0, text: "Hello " });
    host.emit({ type: "text-delta", block: 0, text: "world" });
    host.emit({ type: "tool_use", block: 1, id: "t1", name: "Bash", input: {} });
    const out = host.renderOutput(50);
    expect(out).toContain("Hello world");
    expect(out).toContain("[tool: Bash]");
  });
});
