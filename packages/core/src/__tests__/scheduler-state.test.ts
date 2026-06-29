import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSchedulerState,
  saveSchedulerState,
  jobStateKey,
  type SchedulerState,
} from "../scheduler-state.js";

describe("scheduler-state", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sched-state-"));
    path = join(dir, "nested", "scheduler-state.json"); // exercises mkdir of parents
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns empty state when the file is missing", () => {
    expect(loadSchedulerState(path)).toEqual({ version: 1, jobs: {} });
  });

  it("round-trips state", () => {
    const state: SchedulerState = {
      version: 1,
      jobs: {
        [jobStateKey("proj", "daily")]: { nextDueAt: "2026-07-01T09:00:00.000Z", lastFiredAt: "2026-06-30T09:00:00.000Z" },
        [jobStateKey("proj", "once")]: { spent: true },
      },
    };
    saveSchedulerState(state, path);
    expect(loadSchedulerState(path)).toEqual(state);
  });

  it("resets to empty on a corrupt file", () => {
    writeFileSync(path.replace("/nested", ""), "{ this is : not json");
    expect(loadSchedulerState(path.replace("/nested", ""))).toEqual({ version: 1, jobs: {} });
  });

  it("drops malformed job entries but keeps valid ones", () => {
    const flat = join(dir, "state.json");
    writeFileSync(
      flat,
      JSON.stringify({
        version: 1,
        jobs: {
          good: { nextDueAt: "2026-07-01T09:00:00.000Z" },
          bad: { nextDueAt: 123 },
        },
      }),
    );
    const loaded = loadSchedulerState(flat);
    expect(loaded.jobs.good).toBeDefined();
    expect(loaded.jobs.bad).toBeUndefined();
  });

  it("ignores a wrong version", () => {
    const flat = join(dir, "v2.json");
    writeFileSync(flat, JSON.stringify({ version: 2, jobs: { x: { spent: true } } }));
    expect(loadSchedulerState(flat)).toEqual({ version: 1, jobs: {} });
  });

  it("builds a project-scoped key", () => {
    expect(jobStateKey("p", "n")).toBe("p::n");
  });
});
