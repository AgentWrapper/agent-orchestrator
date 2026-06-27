import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { snapshotReplyCursor, readReplyAfter, sdkEventLogPath } from "./reply-reader.js";

const SESSION = "mae-orchestrator";

let root: string;
let env: Record<string, string | undefined>;

interface Ev {
  seq: number;
  turn: number;
  type: string;
  subtype?: string;
  text?: string;
}

function writeLog(events: Ev[]): void {
  const dir = join(root, "runtime-sdk", SESSION);
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify({ v: 1, session_id: "sdk-x", ts: "t", ...e }));
  writeFileSync(join(dir, "events.ndjson"), lines.join("\n") + "\n", "utf-8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tg-reply-"));
  env = { AO_SDK_HOME: join(root, "runtime-sdk") };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Pins the event-log path contract that MUST match runtime-sdk's sdkHome() +
// sessionPaths().eventLog (runtime-sdk/src/protocol.ts, pinned there by
// protocol.test.ts). The path is duplicated to avoid a plugin→plugin runtime
// dependency; this test makes any drift in the telegram copy fail loudly.
describe("sdkEventLogPath (path contract — keep in sync with runtime-sdk sdkHome)", () => {
  const SID = "sess-1";
  it("defaults to <home>/.agent-orchestrator/runtime-sdk/<sid>/events.ndjson", () => {
    expect(sdkEventLogPath(SID, {})).toBe(
      join(homedir(), ".agent-orchestrator", "runtime-sdk", SID, "events.ndjson"),
    );
  });
  it("uses HOME for the .agent-orchestrator base when set", () => {
    expect(sdkEventLogPath(SID, { HOME: "/home/u" })).toBe(
      join("/home/u", ".agent-orchestrator", "runtime-sdk", SID, "events.ndjson"),
    );
  });
  it("prefers AO_HOME over HOME (still under runtime-sdk/)", () => {
    expect(sdkEventLogPath(SID, { AO_HOME: "/x/ao", HOME: "/home/u" })).toBe(
      join("/x/ao", "runtime-sdk", SID, "events.ndjson"),
    );
  });
  it("treats AO_SDK_HOME as the explicit root, taking precedence over AO_HOME", () => {
    expect(sdkEventLogPath(SID, { AO_SDK_HOME: "/explicit/sdk", AO_HOME: "/x/ao" })).toBe(
      join("/explicit/sdk", SID, "events.ndjson"),
    );
  });
});

describe("snapshotReplyCursor (physical-position cursor = event count)", () => {
  it("returns 0 when the event log does not exist", () => {
    expect(snapshotReplyCursor(SESSION, env)).toBe(0);
  });

  it("returns the number of events in the log (resume-proof, unlike seq)", () => {
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "hi" },
      { seq: 1, turn: 1, type: "text-delta", text: "yo" },
      { seq: 2, turn: 1, type: "result" },
    ]);
    expect(snapshotReplyCursor(SESSION, env)).toBe(3);
  });
});

describe("readReplyAfter", () => {
  it("returns null when there is no event log", () => {
    expect(readReplyAfter(SESSION, 0, env)).toBeNull();
  });

  it("returns the assistant text of the turn the injected message triggered", () => {
    writeLog([
      // prior conversation (before the inject) — must be ignored
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "earlier" },
      { seq: 1, turn: 1, type: "text-delta", text: "old answer" },
      { seq: 2, turn: 1, type: "result" },
      // the injected /orc message + its reply
      { seq: 3, turn: 2, type: "user", subtype: "input", text: "status?" },
      { seq: 4, turn: 2, type: "text-delta", text: "all " },
      { seq: 5, turn: 2, type: "text-delta", text: "green" },
      { seq: 6, turn: 2, type: "result" },
    ]);
    // Cursor = event count snapshotted right before the inject (3 prior events).
    expect(readReplyAfter(SESSION, 3, env)).toBe("all green");
  });

  it("does not leak text from a prior (different) turn", () => {
    writeLog([
      { seq: 0, turn: 1, type: "text-delta", text: "PRIOR" },
      { seq: 1, turn: 1, type: "result" },
      { seq: 2, turn: 2, type: "user", subtype: "input", text: "q" },
      { seq: 3, turn: 2, type: "text-delta", text: "fresh reply" },
      { seq: 4, turn: 2, type: "result" },
    ]);
    const reply = readReplyAfter(SESSION, 2, env);
    expect(reply).toBe("fresh reply");
    expect(reply).not.toContain("PRIOR");
  });

  it("returns null while the reply turn is still streaming (no result yet)", () => {
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "q" },
      { seq: 1, turn: 1, type: "text-delta", text: "thinking" },
      // no result event for turn 1 yet
    ]);
    expect(readReplyAfter(SESSION, 0, env)).toBeNull();
  });

  it("returns null when no user/input appears after the cursor", () => {
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "q" },
      { seq: 1, turn: 1, type: "text-delta", text: "answered" },
      { seq: 2, turn: 1, type: "result" },
    ]);
    // Cursor is already at/after everything — nothing new was injected.
    expect(readReplyAfter(SESSION, 3, env)).toBeNull();
  });

  // --- The actual production bug: seq AND turn reset on every session resume, so
  // the file is a concatenation of segments where the same seq/turn values recur.
  // A seq/turn-based reader silently stopped forwarding after the first resume.
  it("survives a session resume that resets seq and turn (physical-order cursor)", () => {
    writeLog([
      // segment 1 (pre-resume): seq/turn already climbed high
      { seq: 40, turn: 9, type: "user", subtype: "input", text: "earlier" },
      { seq: 41, turn: 9, type: "text-delta", text: "old answer" },
      { seq: 42, turn: 9, type: "result" },
      // cursor snapshotted here = 3 events
      // resume: seq AND turn reset to low numbers
      { seq: 0, turn: 0, type: "session", subtype: "resumed" },
      { seq: 2, turn: 1, type: "user", subtype: "input", text: "status?" },
      { seq: 3, turn: 1, type: "text-delta", text: "all " },
      { seq: 4, turn: 1, type: "text-delta", text: "green" },
      { seq: 5, turn: 1, type: "result" },
    ]);
    // The injected message's seq (2) is far below the pre-resume max (42); a
    // seq-cursor would never see it. The index cursor (3) does.
    expect(readReplyAfter(SESSION, 3, env)).toBe("all green");
  });

  it("does not mix replies from a different resume segment with the same turn number", () => {
    writeLog([
      { seq: 5, turn: 1, type: "user", subtype: "input", text: "old q" },
      { seq: 6, turn: 1, type: "text-delta", text: "STALE" },
      { seq: 7, turn: 1, type: "result" },
      // resume → turn 1 reused for a different message
      { seq: 0, turn: 0, type: "session", subtype: "resumed" },
      { seq: 1, turn: 1, type: "user", subtype: "input", text: "new q" },
      { seq: 2, turn: 1, type: "text-delta", text: "FRESH" },
      { seq: 3, turn: 1, type: "result" },
    ]);
    const reply = readReplyAfter(SESSION, 3, env);
    expect(reply).toBe("FRESH");
    expect(reply).not.toContain("STALE");
  });

  it("waits (null) when a resume interrupts before any result or next inject", () => {
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "q" },
      { seq: 1, turn: 1, type: "text-delta", text: "partial" },
      // resume before the turn produced a result → still streaming, not complete
      { seq: 0, turn: 0, type: "session", subtype: "resumed" },
    ]);
    expect(readReplyAfter(SESSION, 0, env)).toBeNull();
  });

  // --- The production bug this fix targets: the orchestrator resumes constantly,
  // so a `session` boundary routinely lands BETWEEN the inject and the `result`.
  // The old reader ended the window on that boundary and silently dropped the reply.
  it("reads a reply that streams across a session resume (boundary skipped, not ending)", () => {
    writeLog([
      { seq: 5, turn: 2, type: "user", subtype: "input", text: "status?" },
      { seq: 6, turn: 2, type: "text-delta", text: "all " },
      // resume lands mid-reply — must NOT truncate the answer
      { seq: 0, turn: 0, type: "session", subtype: "resumed" },
      { seq: 1, turn: 1, type: "text-delta", text: "green" },
      { seq: 2, turn: 1, type: "result" },
    ]);
    expect(readReplyAfter(SESSION, 0, env)).toBe("all green");
  });

  it("crosses init/end boundaries too, not only resumed", () => {
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "q" },
      { seq: 1, turn: 1, type: "text-delta", text: "a" },
      { seq: 0, turn: 0, type: "session", subtype: "end" },
      { seq: 0, turn: 0, type: "session", subtype: "init" },
      { seq: 1, turn: 1, type: "text-delta", text: "b" },
      { seq: 2, turn: 1, type: "result" },
    ]);
    expect(readReplyAfter(SESSION, 0, env)).toBe("ab");
  });

  // Interrupted turn: substantial assistant text, but a new message interleaved
  // before the turn produced a `result`. The text is the real answer — forward it
  // (finalize on the next user/input once text has been captured) rather than lose it.
  it("forwards an interrupted reply finalized by the next inject (text, no result)", () => {
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "q" },
      { seq: 1, turn: 1, type: "text-delta", text: "here is the answer" },
      // no result — a new message arrives and ends our window
      { seq: 2, turn: 2, type: "user", subtype: "input", text: "next thing" },
    ]);
    expect(readReplyAfter(SESSION, 0, env)).toBe("here is the answer");
  });

  it("forwards an interrupted reply even when the interleave follows a resume", () => {
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "q" },
      { seq: 1, turn: 1, type: "text-delta", text: "partial answer" },
      { seq: 0, turn: 0, type: "session", subtype: "resumed" },
      { seq: 1, turn: 1, type: "user", subtype: "input", text: "another msg" },
    ]);
    expect(readReplyAfter(SESSION, 0, env)).toBe("partial answer");
  });

  // NEGATIVE — guards the 673 "bare queued-batch" injects: when the next inject
  // arrives with NO assistant text yet, the reply belongs to that later inject (or a
  // later one in the batch), not ours. We must NOT forward an empty/misattributed msg.
  it("does not forward when the next inject arrives with no assistant text (bare batch)", () => {
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "first" },
      // immediately another inject, no assistant text in between (queued batch)
      { seq: 1, turn: 1, type: "user", subtype: "input", text: "second" },
      { seq: 2, turn: 1, type: "text-delta", text: "reply to second" },
      { seq: 3, turn: 1, type: "result" },
    ]);
    // The reply belongs to "second", not "first".
    expect(readReplyAfter(SESSION, 0, env)).toBeNull();
  });

  it("does not forward when a bare inject follows a resume (batch across resume)", () => {
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "first" },
      { seq: 0, turn: 0, type: "session", subtype: "init" },
      { seq: 1, turn: 1, type: "user", subtype: "input", text: "second" },
      { seq: 2, turn: 1, type: "text-delta", text: "reply to second" },
      { seq: 3, turn: 1, type: "result" },
    ]);
    expect(readReplyAfter(SESSION, 0, env)).toBeNull();
  });

  // Two injects back-to-back, each WITH its own text, must not bleed into each other.
  it("scopes each inject's reply to its own window (consecutive text-bearing turns)", () => {
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "q1" },
      { seq: 1, turn: 1, type: "text-delta", text: "ANSWER ONE" },
      { seq: 2, turn: 1, type: "result" },
      { seq: 3, turn: 2, type: "user", subtype: "input", text: "q2" },
      { seq: 4, turn: 2, type: "text-delta", text: "ANSWER TWO" },
      { seq: 5, turn: 2, type: "result" },
    ]);
    // Cursor before q1 → first reply only; cursor after first result → second only.
    expect(readReplyAfter(SESSION, 0, env)).toBe("ANSWER ONE");
    const r2 = readReplyAfter(SESSION, 3, env);
    expect(r2).toBe("ANSWER TWO");
    expect(r2).not.toContain("ANSWER ONE");
  });

  // A tool-heavy turn (text → tool_use → tool_result → text) must collect the full
  // answer including post-tool prose, across a resume that lands mid-turn.
  it("collects a tool-heavy turn whole (text + tool round-trip + text), across resume", () => {
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "do the thing" },
      { seq: 1, turn: 1, type: "text-delta", text: "starting. " },
      { seq: 2, turn: 1, type: "tool_use" },
      { seq: 3, turn: 1, type: "tool_result" },
      { seq: 0, turn: 0, type: "session", subtype: "resumed" },
      { seq: 1, turn: 1, type: "text-delta", text: "done." },
      { seq: 2, turn: 1, type: "result" },
    ]);
    expect(readReplyAfter(SESSION, 0, env)).toBe("starting. done.");
  });

  it("returns the full reply untruncated (the listener chunks long replies)", () => {
    const big = "x".repeat(9000);
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "q" },
      { seq: 1, turn: 1, type: "text-delta", text: big },
      { seq: 2, turn: 1, type: "result" },
    ]);
    const reply = readReplyAfter(SESSION, 0, env);
    expect(reply).toBe(big);
    expect(reply?.length).toBe(9000);
  });
});
