import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseScheduledTaskDocument,
  loadScheduledTasks,
  parseDurationMs,
  parseDateTimeExpr,
  parseCronExpr,
  computeNextCronTime,
  computeTriggerDue,
  evaluateScheduledJob,
  dispatchScheduledAction,
  DEFAULT_FIRE_GRACE_MS,
  type ScheduledTask,
  type ScheduledActionHandlers,
} from "../scheduled-tasks.js";

const HOUR = 3_600_000;

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    name: "t",
    enabled: true,
    trigger: { type: "interval", expr: "1h" },
    action: { type: "notify", message: "hi" },
    ...overrides,
  };
}

describe("parseScheduledTaskDocument", () => {
  it("parses a valid cron+spawn task", () => {
    const { task, error } = parseScheduledTaskDocument(`
name: daily
enabled: true
trigger:
  type: cron
  expr: "0 9 * * *"
action:
  type: spawn
  prompt: do the thing
  skills: [a, b]
`);
    expect(error).toBeUndefined();
    expect(task?.name).toBe("daily");
    expect(task?.trigger).toEqual({ type: "cron", expr: "0 9 * * *" });
    expect(task?.action).toMatchObject({ type: "spawn", prompt: "do the thing", skills: ["a", "b"] });
  });

  it("parses interval+notify and datetime+send", () => {
    expect(
      parseScheduledTaskDocument(
        `name: x\nenabled: true\ntrigger:\n  type: interval\n  expr: "30m"\naction:\n  type: notify\n  message: hi\n`,
      ).error,
    ).toBeUndefined();
    expect(
      parseScheduledTaskDocument(
        `name: y\nenabled: true\ntrigger:\n  type: datetime\n  expr: "2026-07-01T15:00:00+05:00"\naction:\n  type: send\n  target: ao-1\n  message: ping\n`,
      ).error,
    ).toBeUndefined();
  });

  it("rejects missing required action params", () => {
    expect(parseScheduledTaskDocument(`name: a\nenabled: true\ntrigger:\n  type: interval\n  expr: 1h\naction:\n  type: spawn\n`).error).toMatch(/prompt/);
    expect(parseScheduledTaskDocument(`name: a\nenabled: true\ntrigger:\n  type: interval\n  expr: 1h\naction:\n  type: send\n  message: hi\n`).error).toMatch(/target/);
    expect(parseScheduledTaskDocument(`name: a\nenabled: true\ntrigger:\n  type: interval\n  expr: 1h\naction:\n  type: notify\n`).error).toMatch(/message/);
  });

  it("rejects bad trigger exprs", () => {
    expect(parseScheduledTaskDocument(`name: a\nenabled: true\ntrigger:\n  type: cron\n  expr: "99 * * * *"\naction:\n  type: notify\n  message: hi\n`).error).toMatch(/cron/);
    expect(parseScheduledTaskDocument(`name: a\nenabled: true\ntrigger:\n  type: interval\n  expr: "soon"\naction:\n  type: notify\n  message: hi\n`).error).toMatch(/interval/);
    expect(parseScheduledTaskDocument(`name: a\nenabled: true\ntrigger:\n  type: datetime\n  expr: "not-a-date"\naction:\n  type: notify\n  message: hi\n`).error).toMatch(/datetime/);
  });

  it("rejects missing required top-level fields and bad YAML", () => {
    expect(parseScheduledTaskDocument(`name: a\ntrigger:\n  type: interval\n  expr: 1h\naction:\n  type: notify\n  message: hi\n`).error).toBeDefined();
    expect(parseScheduledTaskDocument(`: : :`).error).toBeDefined();
  });

  it("normalizes an unquoted datetime (YAML Date) back to a string", () => {
    const { task, error } = parseScheduledTaskDocument(
      `name: u\nenabled: true\ntrigger:\n  type: datetime\n  expr: 2026-07-01T15:00:00Z\naction:\n  type: notify\n  message: hi\n`,
    );
    expect(error).toBeUndefined();
    expect(typeof task?.trigger.expr).toBe("string");
  });
});

describe("loadScheduledTasks", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sched-load-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns empty when the directory is absent", () => {
    expect(loadScheduledTasks(root)).toEqual({ tasks: [], errors: [] });
  });

  it("loads valid tasks (incl. disabled) and reports invalid files + duplicates", () => {
    const dir = join(root, ".maestro", "scheduled-tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.yaml"), `name: a\nenabled: true\ntrigger:\n  type: interval\n  expr: 1h\naction:\n  type: notify\n  message: hi\n`);
    writeFileSync(join(dir, "b.yaml"), `name: b\nenabled: false\ntrigger:\n  type: interval\n  expr: 1h\naction:\n  type: notify\n  message: hi\n`);
    writeFileSync(join(dir, "bad.yaml"), `name: c\nenabled: true\ntrigger:\n  type: cron\n  expr: "nope"\naction:\n  type: notify\n  message: hi\n`);
    writeFileSync(join(dir, "dup.yaml"), `name: a\nenabled: true\ntrigger:\n  type: interval\n  expr: 1h\naction:\n  type: notify\n  message: hi\n`);
    writeFileSync(join(dir, "ignore.txt"), `not yaml`);

    const { tasks, errors } = loadScheduledTasks(root);
    expect(tasks.map((t) => t.name).sort()).toEqual(["a", "b"]);
    expect(errors.map((e) => e.file).sort()).toEqual(["bad.yaml", "dup.yaml"]);
  });
});

describe("parseDurationMs", () => {
  it("parses units", () => {
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("30m")).toBe(1_800_000);
    expect(parseDurationMs("1h")).toBe(HOUR);
    expect(parseDurationMs("2d")).toBe(2 * 86_400_000);
  });
  it("rejects junk and non-positive", () => {
    expect(parseDurationMs("abc")).toBeNull();
    expect(parseDurationMs("0h")).toBeNull();
    expect(parseDurationMs("1w")).toBeNull();
    expect(parseDurationMs("")).toBeNull();
  });
});

describe("parseDateTimeExpr", () => {
  it("parses ISO and rejects junk", () => {
    expect(parseDateTimeExpr("2026-07-01T15:00:00Z")?.toISOString()).toBe("2026-07-01T15:00:00.000Z");
    expect(parseDateTimeExpr("nope")).toBeNull();
  });
});

describe("cron parsing + next time", () => {
  it("rejects malformed cron", () => {
    expect(parseCronExpr("* * * *")).toBeNull();
    expect(parseCronExpr("60 * * * *")).toBeNull();
    expect(parseCronExpr("0 24 * * *")).toBeNull();
    expect(parseCronExpr("0 0 0 * *")).toBeNull(); // dom min is 1
  });

  it("computes next daily time", () => {
    const fields = parseCronExpr("0 9 * * *")!;
    const after = new Date(2026, 5, 30, 10, 0); // Jun 30 10:00 local (past 9am)
    const next = computeNextCronTime(fields, after)!;
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(6); // July
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it("computes next weekly (day-of-week) time", () => {
    const fields = parseCronExpr("0 8 * * 1")!; // Mondays 08:00
    const after = new Date(2026, 5, 30, 9, 0); // Tue Jun 30 2026
    const next = computeNextCronTime(fields, after)!;
    expect(next.getDay()).toBe(1); // Monday
    expect(next.getHours()).toBe(8);
  });

  it("honors steps, ranges, and lists", () => {
    const fields = parseCronExpr("*/15 9-10 * * *")!;
    expect([...fields.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...fields.hour].sort((a, b) => a - b)).toEqual([9, 10]);
    const fields2 = parseCronExpr("0,30 * * * *")!;
    expect([...fields2.minute].sort((a, b) => a - b)).toEqual([0, 30]);
  });

  it("treats dow 7 as Sunday and uses OR semantics when dom+dow both set", () => {
    const fields = parseCronExpr("0 0 1 * 7")!; // 1st of month OR Sunday
    expect(fields.dow.has(0)).toBe(true);
    // From a Wednesday mid-month, next match is the upcoming Sunday (not the 1st).
    const after = new Date(2026, 6, 8, 12, 0); // Wed Jul 8 2026
    const next = computeNextCronTime(fields, after)!;
    expect(next.getDay() === 0 || next.getDate() === 1).toBe(true);
  });

  it("is strictly after the current minute", () => {
    const fields = parseCronExpr("* * * * *")!;
    const after = new Date(2026, 5, 30, 10, 0, 30);
    const next = computeNextCronTime(fields, after)!;
    expect(next.getMinutes()).toBe(1);
    expect(next.getSeconds()).toBe(0);
  });

  it("resolves a leap-year Feb 29 cron", () => {
    const fields = parseCronExpr("0 0 29 2 *")!;
    const next = computeNextCronTime(fields, new Date(2026, 0, 1))!;
    expect(next.getMonth()).toBe(1); // February
    expect(next.getDate()).toBe(29);
    expect(next.getFullYear()).toBe(2028); // next leap year
  });
});

describe("computeTriggerDue", () => {
  it("handles each trigger type", () => {
    const from = new Date(2026, 5, 30, 10, 0, 0);
    expect(computeTriggerDue({ type: "interval", expr: "1h" }, from)!.getTime()).toBe(from.getTime() + HOUR);
    expect(computeTriggerDue({ type: "datetime", expr: "2026-07-01T15:00:00Z" }, from)!.toISOString()).toBe("2026-07-01T15:00:00.000Z");
    expect(computeTriggerDue({ type: "cron", expr: "0 9 * * *" }, from)).not.toBeNull();
    expect(computeTriggerDue({ type: "interval", expr: "bad" }, from)).toBeNull();
  });
});

describe("evaluateScheduledJob", () => {
  it("seeds next-due on first sighting and never fires immediately", () => {
    const now = new Date(2026, 5, 30, 10, 0, 0);
    const r = evaluateScheduledJob({ task: task(), state: {}, now });
    expect(r.shouldFire).toBe(false);
    expect(new Date(r.nextState.nextDueAt!).getTime()).toBe(now.getTime() + HOUR);
  });

  it("fires when due and advances past the slot (anti-double-fire across restart)", () => {
    const t0 = new Date(2026, 5, 30, 10, 0, 0);
    const seeded = evaluateScheduledJob({ task: task(), state: {}, now: t0 }).nextState;

    const dueNow = new Date(t0.getTime() + HOUR);
    const fired = evaluateScheduledJob({ task: task(), state: seeded, now: dueNow });
    expect(fired.shouldFire).toBe(true);
    expect(fired.nextState.lastFiredAt).toBe(dueNow.toISOString());
    expect(new Date(fired.nextState.nextDueAt!).getTime()).toBe(dueNow.getTime() + HOUR);

    // Simulate a restart at the same instant: persisted state must NOT re-fire.
    const restart = evaluateScheduledJob({ task: task(), state: fired.nextState, now: dueNow });
    expect(restart.shouldFire).toBe(false);
  });

  it("does not fire a slot missed during downtime; just recomputes next-due", () => {
    const t = task({ trigger: { type: "cron", expr: "0 9 * * *" } });
    const dueAt = new Date(2026, 5, 30, 9, 0, 0);
    const wayLater = new Date(2026, 5, 30, 11, 0, 0); // 2h > grace
    const r = evaluateScheduledJob({ task: t, state: { nextDueAt: dueAt.toISOString() }, now: wayLater });
    expect(r.shouldFire).toBe(false);
    const next = new Date(r.nextState.nextDueAt!);
    expect(next.getTime()).toBeGreaterThan(wayLater.getTime());
    expect(next.getHours()).toBe(9);
  });

  it("fires a datetime once then marks it spent", () => {
    const t = task({ trigger: { type: "datetime", expr: "2026-07-01T09:00:00Z" } });
    const due = new Date("2026-07-01T09:00:00Z");
    const seeded = evaluateScheduledJob({ task: t, state: {}, now: new Date("2026-07-01T08:00:00Z") });
    expect(seeded.shouldFire).toBe(false);

    const fired = evaluateScheduledJob({ task: t, state: seeded.nextState, now: due });
    expect(fired.shouldFire).toBe(true);
    expect(fired.nextState.spent).toBe(true);

    const after = evaluateScheduledJob({ task: t, state: fired.nextState, now: new Date("2026-07-01T09:00:30Z") });
    expect(after.shouldFire).toBe(false);
  });

  it("marks a datetime spent without firing if its slot passed during downtime", () => {
    const t = task({ trigger: { type: "datetime", expr: "2026-07-01T09:00:00Z" } });
    const r = evaluateScheduledJob({
      task: t,
      state: { nextDueAt: "2026-07-01T09:00:00Z" },
      now: new Date("2026-07-01T11:00:00Z"), // > grace late
    });
    expect(r.shouldFire).toBe(false);
    expect(r.nextState.spent).toBe(true);
  });

  it("never fires a disabled or spent job", () => {
    const now = new Date(2026, 5, 30, 10, 0, 0);
    expect(evaluateScheduledJob({ task: task({ enabled: false }), state: { nextDueAt: "2020-01-01T00:00:00Z" }, now }).shouldFire).toBe(false);
    expect(evaluateScheduledJob({ task: task(), state: { spent: true, nextDueAt: "2020-01-01T00:00:00Z" }, now }).shouldFire).toBe(false);
  });

  it("respects the grace window boundary", () => {
    const due = new Date(2026, 5, 30, 9, 0, 0);
    const t = task({ trigger: { type: "cron", expr: "0 9 * * *" } });
    const onEdge = new Date(due.getTime() + DEFAULT_FIRE_GRACE_MS);
    const overEdge = new Date(due.getTime() + DEFAULT_FIRE_GRACE_MS + 1);
    expect(evaluateScheduledJob({ task: t, state: { nextDueAt: due.toISOString() }, now: onEdge }).shouldFire).toBe(true);
    expect(evaluateScheduledJob({ task: t, state: { nextDueAt: due.toISOString() }, now: overEdge }).shouldFire).toBe(false);
  });
});

describe("dispatchScheduledAction", () => {
  function recorder() {
    const calls: Array<{ kind: string; opts: unknown }> = [];
    const handlers: ScheduledActionHandlers = {
      spawn: async (opts) => void calls.push({ kind: "spawn", opts }),
      send: async (opts) => void calls.push({ kind: "send", opts }),
      notify: async (opts) => void calls.push({ kind: "notify", opts }),
    };
    return { calls, handlers };
  }

  it("maps spawn", async () => {
    const { calls, handlers } = recorder();
    await dispatchScheduledAction(
      task({ name: "s", action: { type: "spawn", prompt: "go", skills: ["a"], model: "opus" } }),
      "proj",
      handlers,
    );
    expect(calls).toEqual([
      { kind: "spawn", opts: { projectId: "proj", taskName: "s", prompt: "go", skills: ["a"], model: "opus" } },
    ]);
  });

  it("maps send", async () => {
    const { calls, handlers } = recorder();
    await dispatchScheduledAction(
      task({ name: "m", action: { type: "send", target: "ao-1", message: "ping" } }),
      "proj",
      handlers,
    );
    expect(calls).toEqual([
      { kind: "send", opts: { projectId: "proj", taskName: "m", target: "ao-1", message: "ping" } },
    ]);
  });

  it("maps notify (with optional target)", async () => {
    const { calls, handlers } = recorder();
    await dispatchScheduledAction(
      task({ name: "n", action: { type: "notify", message: "hey", target: "telegram" } }),
      "proj",
      handlers,
    );
    expect(calls).toEqual([
      { kind: "notify", opts: { projectId: "proj", taskName: "n", message: "hey", target: "telegram" } },
    ]);
  });

  it("throws on a malformed action (defensive guard)", async () => {
    const { handlers } = recorder();
    await expect(
      dispatchScheduledAction(task({ action: { type: "spawn" } }), "proj", handlers),
    ).rejects.toThrow(/prompt/);
  });
});
