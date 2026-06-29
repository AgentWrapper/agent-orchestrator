import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchestratorConfig, ScheduledActionHandlers } from "@aoagents/ao-core";
import { loadSchedulerState, jobStateKey } from "@aoagents/ao-core";
import { runSchedulerTick } from "../../src/lib/scheduler.js";

const HOUR = 3_600_000;

/** runSchedulerTick only reads `config.projects[].path`, so a minimal cast is enough. */
function makeConfig(projectId: string, root: string): OrchestratorConfig {
  return { projects: { [projectId]: { path: root } } } as unknown as OrchestratorConfig;
}

function recorder() {
  const calls: Array<{ kind: string; opts: Record<string, unknown> }> = [];
  const handlers: ScheduledActionHandlers = {
    spawn: async (opts) => void calls.push({ kind: "spawn", opts }),
    send: async (opts) => void calls.push({ kind: "send", opts }),
    notify: async (opts) => void calls.push({ kind: "notify", opts }),
  };
  return { calls, handlers };
}

describe("runSchedulerTick", () => {
  let root: string;
  let tasksDir: string;
  let statePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sched-tick-"));
    tasksDir = join(root, ".maestro", "scheduled-tasks");
    mkdirSync(tasksDir, { recursive: true });
    statePath = join(root, "scheduler-state.json");
    writeFileSync(
      join(tasksDir, "ping.yaml"),
      `name: ping\nenabled: true\ntrigger:\n  type: interval\n  expr: "1h"\naction:\n  type: notify\n  message: pong\n`,
    );
    writeFileSync(
      join(tasksDir, "off.yaml"),
      `name: off\nenabled: false\ntrigger:\n  type: interval\n  expr: "1h"\naction:\n  type: notify\n  message: nope\n`,
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("seeds on the first tick (no fire) and fires once when due, surviving restart", async () => {
    const config = makeConfig("proj", root);
    const t0 = new Date(2026, 5, 30, 10, 0, 0);

    // Tick 1: seed, no fire.
    const r1 = recorder();
    await runSchedulerTick({ config, handlers: r1.handlers, now: t0, statePath });
    expect(r1.calls).toHaveLength(0);
    const stateAfterSeed = loadSchedulerState(statePath);
    expect(stateAfterSeed.jobs[jobStateKey("proj", "ping")].nextDueAt).toBeDefined();
    expect(stateAfterSeed.jobs[jobStateKey("proj", "off")]).toBeUndefined(); // disabled never seeded

    // Tick 2: due → fires the notify action exactly once.
    const r2 = recorder();
    await runSchedulerTick({ config, handlers: r2.handlers, now: new Date(t0.getTime() + HOUR), statePath });
    expect(r2.calls).toEqual([
      { kind: "notify", opts: { projectId: "proj", taskName: "ping", message: "pong", target: undefined } },
    ]);

    // Tick 3: same instant (simulated restart) → persisted state prevents a re-fire.
    const r3 = recorder();
    await runSchedulerTick({ config, handlers: r3.handlers, now: new Date(t0.getTime() + HOUR), statePath });
    expect(r3.calls).toHaveLength(0);
  });

  it("prunes durable state for tasks that no longer exist", async () => {
    const config = makeConfig("proj", root);
    const t0 = new Date(2026, 5, 30, 10, 0, 0);
    await runSchedulerTick({ config, handlers: recorder().handlers, now: t0, statePath });
    expect(loadSchedulerState(statePath).jobs[jobStateKey("proj", "ping")]).toBeDefined();

    rmSync(join(tasksDir, "ping.yaml"));
    await runSchedulerTick({ config, handlers: recorder().handlers, now: t0, statePath });
    expect(loadSchedulerState(statePath).jobs[jobStateKey("proj", "ping")]).toBeUndefined();
    expect(existsSync(statePath)).toBe(true);
  });
});
