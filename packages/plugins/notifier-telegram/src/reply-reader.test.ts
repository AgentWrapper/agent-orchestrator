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

describe("snapshotReplyCursor", () => {
  it("returns -1 when the event log does not exist", () => {
    expect(snapshotReplyCursor(SESSION, env)).toBe(-1);
  });

  it("returns the highest seq in the log", () => {
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "hi" },
      { seq: 1, turn: 1, type: "text-delta", text: "yo" },
      { seq: 2, turn: 1, type: "result" },
    ]);
    expect(snapshotReplyCursor(SESSION, env)).toBe(2);
  });
});

describe("readReplyAfter", () => {
  it("returns null when there is no event log", () => {
    expect(readReplyAfter(SESSION, -1, env)).toBeNull();
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
    // Cursor snapshotted right before the inject (head was seq 2).
    expect(readReplyAfter(SESSION, 2, env)).toBe("all green");
  });

  it("does not leak text from a prior (different) turn", () => {
    writeLog([
      { seq: 0, turn: 1, type: "text-delta", text: "PRIOR" },
      { seq: 1, turn: 1, type: "result" },
      { seq: 2, turn: 2, type: "user", subtype: "input", text: "q" },
      { seq: 3, turn: 2, type: "text-delta", text: "fresh reply" },
      { seq: 4, turn: 2, type: "result" },
    ]);
    const reply = readReplyAfter(SESSION, 1, env);
    expect(reply).toBe("fresh reply");
    expect(reply).not.toContain("PRIOR");
  });

  it("returns null while the reply turn is still streaming (no result yet)", () => {
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "q" },
      { seq: 1, turn: 1, type: "text-delta", text: "thinking" },
      // no result event for turn 1 yet
    ]);
    expect(readReplyAfter(SESSION, -1, env)).toBeNull();
  });

  it("returns null when no user/input appears after the cursor", () => {
    writeLog([
      { seq: 0, turn: 1, type: "user", subtype: "input", text: "q" },
      { seq: 1, turn: 1, type: "text-delta", text: "answered" },
      { seq: 2, turn: 1, type: "result" },
    ]);
    // Cursor is already at/after everything — nothing new was injected.
    expect(readReplyAfter(SESSION, 2, env)).toBeNull();
  });
});
