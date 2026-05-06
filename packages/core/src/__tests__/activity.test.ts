import { describe, it, expect, beforeEach } from "vitest";
import { ActivityLog, type ActivityEvent } from "../activity.js";

function makeEvent(sessionId: string, n: number): ActivityEvent {
  return { type: "message_sent", sessionId, message: `msg-${n}`, ts: n };
}

describe("ActivityLog", () => {
  let log: ActivityLog;

  beforeEach(() => {
    log = new ActivityLog(3);
  });

  it("push() evicts oldest when capacity exceeded", () => {
    log.push(makeEvent("s1", 1));
    log.push(makeEvent("s1", 2));
    log.push(makeEvent("s1", 3));
    log.push(makeEvent("s1", 4));

    const all = log.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((e) => (e as { ts: number }).ts)).toEqual([2, 3, 4]);
  });

  it("getAll() returns events in insertion order", () => {
    log.push(makeEvent("s1", 10));
    log.push(makeEvent("s2", 20));
    log.push(makeEvent("s1", 30));

    const all = log.getAll();
    expect(all.map((e) => (e as { ts: number }).ts)).toEqual([10, 20, 30]);
  });

  it("getAll() returns a copy (mutations don't affect the buffer)", () => {
    log.push(makeEvent("s1", 1));
    const copy = log.getAll();
    copy.pop();
    expect(log.getAll()).toHaveLength(1);
  });

  it("getBySession() filters correctly", () => {
    log.push(makeEvent("s1", 1));
    log.push(makeEvent("s2", 2));
    log.push(makeEvent("s1", 3));

    const s1 = log.getBySession("s1");
    expect(s1).toHaveLength(2);
    expect(s1.every((e) => e.sessionId === "s1")).toBe(true);

    const s2 = log.getBySession("s2");
    expect(s2).toHaveLength(1);
  });

  it("capacity defaults to 500", () => {
    const defaultLog = new ActivityLog();
    for (let i = 0; i < 501; i++) {
      defaultLog.push(makeEvent("s1", i));
    }
    expect(defaultLog.getAll()).toHaveLength(500);
  });

  it("clear() empties the buffer", () => {
    log.push(makeEvent("s1", 1));
    log.push(makeEvent("s1", 2));
    log.clear();
    expect(log.getAll()).toHaveLength(0);
  });
});
