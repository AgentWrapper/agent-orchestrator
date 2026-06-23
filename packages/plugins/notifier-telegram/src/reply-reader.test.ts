import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotReplyCursor, readReplyAfter } from "./reply-reader.js";

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
