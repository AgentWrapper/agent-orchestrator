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

  it("stops at a session boundary and waits when a resume interrupts the reply", () => {
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "q" },
      { seq: 1, turn: 1, type: "text-delta", text: "partial" },
      // resume before the turn produced a result → not complete yet
      { seq: 0, turn: 0, type: "session", subtype: "resumed" },
    ]);
    expect(readReplyAfter(SESSION, 0, env)).toBeNull();
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
