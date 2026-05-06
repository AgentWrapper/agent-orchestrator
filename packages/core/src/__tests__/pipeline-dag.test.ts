/**
 * v1.1 DAG scheduler coverage. Verifies:
 *  - Cycle detection at config load (clear error naming the cycle)
 *  - Two independent stages run concurrently when maxConcurrentStages >= 2
 *  - A stage with unmet dependsOn does not start
 *  - A stage with an unsatisfied routes predicate is skipped, with cascade
 *  - Multiple pipelines can coexist within a single project config
 *
 * The reducer-event helpers (`fireTrigger`, `completeStage`) mirror the style
 * used by the existing pipeline reducer suite so tests read consistently.
 */

import { describe, expect, it } from "vitest";

import {
  ConfiguredPipelineSchema,
  PipelinesConfigSchema,
  asPipelineId,
  asRunId,
  asStageRunId,
  emptyEngineState,
  reduce,
  type EngineState,
  type Pipeline,
  type PipelineEvent,
  type RunId,
  type Stage,
  type StageRunId,
} from "../pipeline/index.js";

const NOW = 1_700_000_000_000;

function makeStage(name: string, overrides: Partial<Stage> = {}): Stage {
  return {
    name,
    trigger: { on: ["pr.opened"] },
    executor: { kind: "agent", plugin: "codex", mode: "review" },
    task: { prompt: `run ${name}` },
    ...overrides,
  };
}

function makePipeline(stages: Stage[], maxConcurrentStages = 1): Pipeline {
  return {
    id: asPipelineId("pl-1"),
    name: "default",
    stages,
    maxConcurrentStages,
  };
}

function fireTrigger(pipeline: Pipeline, runId = asRunId("run-1")) {
  const stageRunIds: Record<string, StageRunId> = Object.fromEntries(
    pipeline.stages.map((s, i) => [s.name, asStageRunId(`sr-${s.name}-${i}`)]),
  );
  const event: PipelineEvent = {
    type: "TRIGGER_FIRED",
    now: NOW,
    trigger: "manual",
    sessionId: "ses-1",
    pipeline,
    headSha: "sha-aaa",
    runId,
    stageRunIds,
  };
  return reduce(emptyEngineState(), event);
}

function startStage(state: EngineState, runId: RunId, stageName: string, t = NOW + 1) {
  return reduce(state, { type: "STAGE_STARTED", now: t, runId, stageName });
}

function completeStage(state: EngineState, runId: RunId, stageName: string, t = NOW + 2) {
  return reduce(state, {
    type: "STAGE_COMPLETED",
    now: t,
    runId,
    stageName,
    artifacts: [],
  });
}

describe("pipeline DAG — cycle detection (config load)", () => {
  it("rejects a 2-cycle and names both stages in order", () => {
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [
        { ...makeStage("a"), dependsOn: ["b"] },
        { ...makeStage("b"), dependsOn: ["a"] },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message).join("\n");
    expect(messages).toContain("stage dependency cycle");
    expect(messages).toContain("a → b → a");
  });

  it("rejects a 3-cycle with the exact path in declaration order", () => {
    // Adjacency: a→c, b→a, c→b. DFS from `a` (first-declared) traces
    // a→c→b→a, so the reported cycle path is exact, not just "contains a, b, c".
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [
        { ...makeStage("a"), dependsOn: ["c"] },
        { ...makeStage("b"), dependsOn: ["a"] },
        { ...makeStage("c"), dependsOn: ["b"] },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message).join("\n");
    expect(messages).toContain("stage dependency cycle: a → c → b → a");
  });

  it("rejects routes-only cycles (would deadlock at runtime)", () => {
    // Without dependsOn edges in the cycle graph, a→b→a via routes alone
    // would leave both stages waiting on each other in `arePreconditionsTerminal`.
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [
        {
          ...makeStage("a"),
          routes: { when: { kind: "allSucceeded", stages: ["b"] } },
        },
        {
          ...makeStage("b"),
          routes: { when: { kind: "allSucceeded", stages: ["a"] } },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message).join("\n");
    expect(messages).toContain("stage dependency cycle");
    expect(messages).toContain("a → b → a");
  });

  it("rejects mixed dependsOn + routes cycles", () => {
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [
        { ...makeStage("a"), dependsOn: ["b"] },
        {
          ...makeStage("b"),
          routes: { when: { kind: "allSucceeded", stages: ["a"] } },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message).join("\n");
    expect(messages).toContain("stage dependency cycle");
  });

  it("rejects self-dependency without emitting a duplicate cycle error", () => {
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [{ ...makeStage("a"), dependsOn: ["a"] }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes('"a" cannot depend on itself'))).toBe(true);
    // Trivial self-loops are owned by the explicit self-ref check; the cycle
    // detector must NOT emit an additional "stage dependency cycle: a → a".
    expect(messages.some((m) => m.includes("stage dependency cycle"))).toBe(false);
  });

  it("rejects routes self-reference (would deadlock at runtime)", () => {
    // A stage whose routes reference itself never sees its own state become
    // terminal, so `arePreconditionsTerminal` returns false forever.
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [
        {
          ...makeStage("a"),
          routes: { when: { kind: "allSucceeded", stages: ["a"] } },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message).join("\n");
    expect(messages).toContain('"a" cannot route to itself');
  });

  it("rejects empty stages arrays in route predicates", () => {
    // Vacuous truth/falsity on empty stage lists is surprising — every
    // predicate kind must name at least one upstream stage.
    const allEmpty = ConfiguredPipelineSchema.safeParse({
      stages: [
        {
          ...makeStage("a"),
          routes: { when: { kind: "allSucceeded", stages: [] } },
        },
      ],
    });
    expect(allEmpty.success).toBe(false);

    const anyEmpty = ConfiguredPipelineSchema.safeParse({
      stages: [
        {
          ...makeStage("a"),
          routes: { when: { kind: "anyFailed", stages: [] } },
        },
      ],
    });
    expect(anyEmpty.success).toBe(false);
  });

  it("rejects unknown stage names in dependsOn", () => {
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [makeStage("a"), { ...makeStage("b"), dependsOn: ["nonexistent"] }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message).join("\n");
    expect(messages).toContain('unknown stage "nonexistent"');
  });

  it("rejects unknown stage names in routes predicates", () => {
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [
        makeStage("a"),
        {
          ...makeStage("b"),
          dependsOn: ["a"],
          routes: { when: { kind: "allSucceeded", stages: ["nope"] } },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message).join("\n");
    expect(messages).toContain('routes references unknown stage "nope"');
  });

  it("accepts a valid acyclic DAG with mixed dependsOn and routes", () => {
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [
        makeStage("a"),
        { ...makeStage("b"), dependsOn: ["a"] },
        {
          ...makeStage("c"),
          dependsOn: ["a", "b"],
          routes: { when: { kind: "allSucceeded", stages: ["a", "b"] } },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects duplicate stage names", () => {
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [makeStage("a"), makeStage("a")],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message).join("\n");
    expect(messages).toContain('Duplicate stage name "a"');
  });
});

describe("pipeline DAG — parallel scheduling", () => {
  it("starts two independent stages concurrently when maxConcurrentStages=2", () => {
    const pipeline = makePipeline([makeStage("a"), makeStage("b")], 2);
    const { effects } = fireTrigger(pipeline);
    const startEffects = effects.filter((e) => e.type === "START_STAGE");
    expect(startEffects).toHaveLength(2);
    const names = startEffects.map((e) => (e.type === "START_STAGE" ? e.stage.name : "")).sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("respects declaration order when slots < eligible stages", () => {
    const pipeline = makePipeline([makeStage("a"), makeStage("b"), makeStage("c")], 2);
    const { effects } = fireTrigger(pipeline);
    const names = effects
      .filter((e) => e.type === "START_STAGE")
      .map((e) => (e.type === "START_STAGE" ? e.stage.name : ""))
      .sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("a stage with unmet dependsOn does not start at trigger time", () => {
    const pipeline = makePipeline([makeStage("a"), { ...makeStage("b"), dependsOn: ["a"] }], 2);
    const { state, effects } = fireTrigger(pipeline);
    const starts = effects.filter((e) => e.type === "START_STAGE");
    expect(starts).toHaveLength(1);
    if (starts[0].type !== "START_STAGE") throw new Error();
    expect(starts[0].stage.name).toBe("a");
    expect(state.runs[asRunId("run-1")].stages.b.status).toBe("pending");
  });

  it("starts a dependent stage after its dependsOn succeeds", () => {
    const pipeline = makePipeline([makeStage("a"), { ...makeStage("b"), dependsOn: ["a"] }], 1);
    const triggered = fireTrigger(pipeline);
    const started = startStage(triggered.state, asRunId("run-1"), "a");
    const { state, effects } = completeStage(started.state, asRunId("run-1"), "a");
    expect(state.runs[asRunId("run-1")].stages.b.status).toBe("pending");
    const startB = effects.find((e) => e.type === "START_STAGE" && e.stage.name === "b");
    expect(startB).toBeDefined();
  });

  it("starts multiple downstream branches concurrently when both deps succeed", () => {
    // a → {b, c} (b and c both depend on a only, no inter-branch dependency)
    const pipeline = makePipeline(
      [
        makeStage("a"),
        { ...makeStage("b"), dependsOn: ["a"] },
        { ...makeStage("c"), dependsOn: ["a"] },
      ],
      2,
    );
    const triggered = fireTrigger(pipeline);
    const started = startStage(triggered.state, asRunId("run-1"), "a");
    const { effects } = completeStage(started.state, asRunId("run-1"), "a");
    const starts = effects
      .filter((e) => e.type === "START_STAGE")
      .map((e) => (e.type === "START_STAGE" ? e.stage.name : ""))
      .sort();
    expect(starts).toEqual(["b", "c"]);
  });

  it("does not exceed maxConcurrentStages when many branches unlock at once", () => {
    const pipeline = makePipeline(
      [
        makeStage("a"),
        { ...makeStage("b"), dependsOn: ["a"] },
        { ...makeStage("c"), dependsOn: ["a"] },
        { ...makeStage("d"), dependsOn: ["a"] },
      ],
      2,
    );
    const triggered = fireTrigger(pipeline);
    const started = startStage(triggered.state, asRunId("run-1"), "a");
    const { effects } = completeStage(started.state, asRunId("run-1"), "a");
    const starts = effects.filter((e) => e.type === "START_STAGE");
    expect(starts).toHaveLength(2);
  });
});

describe("pipeline DAG — routes predicate", () => {
  it("skips a stage whose allSucceeded routes references a non-succeeded upstream", () => {
    // This shape uses routes to express "only run b when a succeeded AND
    // some other parallel stage `c` succeeded". When c is skipped (because
    // its own routes are unsatisfied), b's routes also fail and b is skipped.
    const pipeline = makePipeline(
      [
        makeStage("a"),
        // c skips itself by requiring a stage that won't succeed.
        {
          ...makeStage("c"),
          dependsOn: ["a"],
          routes: { when: { kind: "anyFailed", stages: ["a"] } },
        },
        // b only runs when both a AND c succeeded.
        {
          ...makeStage("b"),
          dependsOn: ["a", "c"],
          routes: { when: { kind: "allSucceeded", stages: ["a", "c"] } },
        },
      ],
      2,
    );

    const triggered = fireTrigger(pipeline);
    const started = startStage(triggered.state, asRunId("run-1"), "a");
    const { state } = completeStage(started.state, asRunId("run-1"), "a");

    const run = state.runs[asRunId("run-1")];
    expect(run.stages.a.status).toBe("succeeded");
    expect(run.stages.c.status).toBe("skipped");
    expect(run.stages.b.status).toBe("skipped");
    expect(run.loopState).toBe("done");
  });

  it("emits pipeline.stage.terminated observations for cascade-skipped stages", () => {
    const pipeline = makePipeline(
      [
        makeStage("a"),
        {
          ...makeStage("b"),
          dependsOn: ["a"],
          routes: { when: { kind: "anyFailed", stages: ["a"] } },
        },
      ],
      1,
    );

    const triggered = fireTrigger(pipeline);
    const started = startStage(triggered.state, asRunId("run-1"), "a");
    const { effects } = completeStage(started.state, asRunId("run-1"), "a");

    const skipObs = effects.find(
      (e) =>
        e.type === "EMIT_OBSERVATION" &&
        e.event.name === "pipeline.stage.terminated" &&
        (e.event.data as { stageName?: string; status?: string }).stageName === "b" &&
        (e.event.data as { stageName?: string; status?: string }).status === "skipped",
    );
    expect(skipObs).toBeDefined();
  });

  it("runs the stage when its routes predicate is satisfied", () => {
    const pipeline = makePipeline(
      [
        makeStage("a"),
        {
          ...makeStage("b"),
          dependsOn: ["a"],
          routes: { when: { kind: "allSucceeded", stages: ["a"] } },
        },
      ],
      1,
    );
    const triggered = fireTrigger(pipeline);
    const started = startStage(triggered.state, asRunId("run-1"), "a");
    const { state, effects } = completeStage(started.state, asRunId("run-1"), "a");

    expect(state.runs[asRunId("run-1")].stages.b.status).toBe("pending");
    const startB = effects.find((e) => e.type === "START_STAGE" && e.stage.name === "b");
    expect(startB).toBeDefined();
  });

  it("anySucceeded predicate runs the stage if any upstream succeeded", () => {
    // Two independent producers feed a fan-in: c only needs one to succeed.
    const pipeline = makePipeline(
      [
        makeStage("a"),
        makeStage("b"),
        {
          ...makeStage("c"),
          dependsOn: ["a", "b"],
          routes: { when: { kind: "anySucceeded", stages: ["a", "b"] } },
        },
      ],
      2,
    );
    const triggered = fireTrigger(pipeline);
    let s = startStage(triggered.state, asRunId("run-1"), "a", NOW + 1).state;
    s = startStage(s, asRunId("run-1"), "b", NOW + 2).state;
    s = completeStage(s, asRunId("run-1"), "a", NOW + 3).state;
    const finalRes = completeStage(s, asRunId("run-1"), "b", NOW + 4);

    const startC = finalRes.effects.find((e) => e.type === "START_STAGE" && e.stage.name === "c");
    expect(startC).toBeDefined();
    expect(finalRes.state.runs[asRunId("run-1")].stages.c.status).toBe("pending");
  });
});

describe("pipeline DAG — multi-pipeline support", () => {
  it("validates and parses a config with multiple named pipelines", () => {
    const result = PipelinesConfigSchema.safeParse({
      review: {
        stages: [makeStage("review")],
      },
      ship: {
        stages: [makeStage("build"), { ...makeStage("deploy"), dependsOn: ["build"] }],
        maxConcurrentStages: 2,
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.data).sort()).toEqual(["review", "ship"]);
    expect(result.data.ship.stages).toHaveLength(2);
  });

  it("rejects a multi-pipeline config when one pipeline has a cycle", () => {
    const result = PipelinesConfigSchema.safeParse({
      good: { stages: [makeStage("a")] },
      bad: {
        stages: [
          { ...makeStage("x"), dependsOn: ["y"] },
          { ...makeStage("y"), dependsOn: ["x"] },
        ],
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message).join("\n");
    expect(messages).toContain("stage dependency cycle");
  });
});

describe("pipeline DAG — failure path (parallel)", () => {
  it("STAGE_FAILED on a parallel branch terminates the run and marks sibling stages outdated/skipped", () => {
    // Two independent branches running concurrently; the running sibling
    // should transition `running → outdated` and emit a CANCEL_STAGE effect,
    // while a not-yet-started downstream stage transitions `pending → skipped`.
    const pipeline = makePipeline(
      [
        makeStage("a"),
        makeStage("b"),
        { ...makeStage("c"), dependsOn: ["a"] },
      ],
      2,
    );
    const triggered = fireTrigger(pipeline);
    let s = startStage(triggered.state, asRunId("run-1"), "a", NOW + 1).state;
    s = startStage(s, asRunId("run-1"), "b", NOW + 2).state;
    const failed = reduce(s, {
      type: "STAGE_FAILED",
      now: NOW + 3,
      runId: asRunId("run-1"),
      stageName: "a",
      errorMessage: "boom",
    });

    const run = failed.state.runs[asRunId("run-1")];
    expect(run.loopState).toBe("stalled");
    expect(run.terminationReason).toBe("stage_failure");
    expect(run.stages.a.status).toBe("failed");
    expect(run.stages.b.status).toBe("outdated");
    expect(run.stages.c.status).toBe("skipped");

    const cancelB = failed.effects.find(
      (e) => e.type === "CANCEL_STAGE" && e.stageName === "b",
    );
    expect(cancelB).toBeDefined();
  });
});

describe("pipeline DAG — RUN_RESUMED with cascade-skipped stages", () => {
  it("revives cascade-skipped downstream stages so they can run after retry", () => {
    // a fails, terminate cascade-skips b (deps=[a]) and c (deps=[b]).
    // Resume must revive b and c too — otherwise the DAG branch is lost.
    const pipeline = makePipeline(
      [
        makeStage("a"),
        { ...makeStage("b"), dependsOn: ["a"] },
        { ...makeStage("c"), dependsOn: ["b"] },
      ],
      1,
    );

    const triggered = fireTrigger(pipeline);
    const startedA = startStage(triggered.state, asRunId("run-1"), "a", NOW + 1);
    const failedA = reduce(startedA.state, {
      type: "STAGE_FAILED",
      now: NOW + 2,
      runId: asRunId("run-1"),
      stageName: "a",
      errorMessage: "boom",
    });

    expect(failedA.state.runs[asRunId("run-1")].stages.b.status).toBe("skipped");
    expect(failedA.state.runs[asRunId("run-1")].stages.c.status).toBe("skipped");

    const resumed = reduce(failedA.state, {
      type: "RUN_RESUMED",
      now: NOW + 3,
      runId: asRunId("run-1"),
      stageRunIds: { a: asStageRunId("sr-a-2") },
    });
    const run = resumed.state.runs[asRunId("run-1")];
    expect(run.loopState).toBe("running");
    expect(run.stages.a.status).toBe("pending");
    expect(run.stages.b.status).toBe("pending");
    expect(run.stages.c.status).toBe("pending");

    // a is the only startable stage; b and c wait on their dependsOn.
    const starts = resumed.effects.filter((e) => e.type === "START_STAGE");
    expect(starts).toHaveLength(1);
    if (starts[0].type !== "START_STAGE") throw new Error();
    expect(starts[0].stage.name).toBe("a");
  });

  it("revives `outdated` stages (running-at-terminate) so parallel branches recover", () => {
    // a and b run concurrently; a fails and `terminateRunFromState` marks b
    // `outdated` (because b was running). Without reviving outdated, b would
    // never recover and any downstream stage on b (here d) would cascade-skip
    // after resume.
    const pipeline = makePipeline(
      [
        makeStage("a"),
        makeStage("b"),
        { ...makeStage("d"), dependsOn: ["b"] },
      ],
      2,
    );
    const triggered = fireTrigger(pipeline);
    let s = startStage(triggered.state, asRunId("run-1"), "a", NOW + 1).state;
    s = startStage(s, asRunId("run-1"), "b", NOW + 2).state;
    const failed = reduce(s, {
      type: "STAGE_FAILED",
      now: NOW + 3,
      runId: asRunId("run-1"),
      stageName: "a",
      errorMessage: "boom",
    });
    expect(failed.state.runs[asRunId("run-1")].stages.b.status).toBe("outdated");

    // Resume: caller must allocate fresh stageRunIds for BOTH a (failed) and
    // b (outdated). The reducer rejects resumes that miss either.
    const resumed = reduce(failed.state, {
      type: "RUN_RESUMED",
      now: NOW + 4,
      runId: asRunId("run-1"),
      stageRunIds: {
        a: asStageRunId("sr-a-2"),
        b: asStageRunId("sr-b-2"),
      },
    });
    const run = resumed.state.runs[asRunId("run-1")];
    expect(run.stages.a.status).toBe("pending");
    expect(run.stages.b.status).toBe("pending");
    expect(run.stages.b.attempt).toBe(2);
    expect(run.stages.b.stageRunId).toBe(asStageRunId("sr-b-2"));
    expect(run.stages.d.status).toBe("pending");

    const startNames = resumed.effects
      .filter((e) => e.type === "START_STAGE")
      .map((e) => (e.type === "START_STAGE" ? e.stage.name : ""))
      .sort();
    expect(startNames).toEqual(["a", "b"]);
  });

  it("rejects RUN_RESUMED that omits a stageRunId for an outdated stage", () => {
    const pipeline = makePipeline([makeStage("a"), makeStage("b")], 2);
    const triggered = fireTrigger(pipeline);
    let s = startStage(triggered.state, asRunId("run-1"), "a", NOW + 1).state;
    s = startStage(s, asRunId("run-1"), "b", NOW + 2).state;
    const failed = reduce(s, {
      type: "STAGE_FAILED",
      now: NOW + 3,
      runId: asRunId("run-1"),
      stageName: "a",
      errorMessage: "boom",
    });
    const resumed = reduce(failed.state, {
      type: "RUN_RESUMED",
      now: NOW + 4,
      runId: asRunId("run-1"),
      stageRunIds: { a: asStageRunId("sr-a-2") }, // missing b
    });
    const obs = resumed.effects.find(
      (e) =>
        e.type === "EMIT_OBSERVATION" && e.event.name === "pipeline.invalid_transition",
    );
    expect(obs).toBeDefined();
    // State must not have advanced — the b stage is still outdated.
    expect(resumed.state.runs[asRunId("run-1")].stages.b.status).toBe("outdated");
  });

  it("refuses to resume a run whose loop key is owned by a newer active run", () => {
    // First run fails → stalled → loop key freed. A second TRIGGER_FIRED
    // claims the key with run-2. Calling RUN_RESUMED for run-1 must NOT
    // dispossess run-2 of the loop pointer.
    const pipeline = makePipeline([makeStage("a")], 1);
    const first = fireTrigger(pipeline, asRunId("run-1"));
    const startedA = startStage(first.state, asRunId("run-1"), "a", NOW + 1);
    const failedA = reduce(startedA.state, {
      type: "STAGE_FAILED",
      now: NOW + 2,
      runId: asRunId("run-1"),
      stageName: "a",
      errorMessage: "boom",
    });

    // Trigger run-2 for the same loop (sessionId/pipelineName) — uses the
    // freed loop key.
    const stageRunIds2: Record<string, StageRunId> = { a: asStageRunId("sr-2-a") };
    const second = reduce(failedA.state, {
      type: "TRIGGER_FIRED",
      now: NOW + 3,
      trigger: "manual",
      sessionId: "ses-1",
      pipeline,
      headSha: "sha-bbb",
      runId: asRunId("run-2"),
      stageRunIds: stageRunIds2,
    });
    expect(second.state.currentRunByLoop["ses-1:default"]).toBe(asRunId("run-2"));

    // Now try resuming run-1: must be refused.
    const resumed = reduce(second.state, {
      type: "RUN_RESUMED",
      now: NOW + 4,
      runId: asRunId("run-1"),
      stageRunIds: { a: asStageRunId("sr-a-resumed") },
    });
    // Loop ownership unchanged.
    expect(resumed.state.currentRunByLoop["ses-1:default"]).toBe(asRunId("run-2"));
    // run-1 still stalled (not revived).
    expect(resumed.state.runs[asRunId("run-1")].loopState).toBe("stalled");
    const obs = resumed.effects.find(
      (e) =>
        e.type === "EMIT_OBSERVATION" && e.event.name === "pipeline.invalid_transition",
    );
    expect(obs).toBeDefined();
  });

  it("revived stages still get re-skipped when their routes predicate is unsatisfied", () => {
    // c had `routes: { anyFailed: [a] }` — it was skipped via routes (not
    // cascade) before the failure, then double-skipped by terminate. After
    // resume + a-succeeds, c must re-skip because a no longer matches anyFailed.
    const pipeline = makePipeline(
      [
        makeStage("a"),
        { ...makeStage("b"), dependsOn: ["a"] },
        {
          ...makeStage("c"),
          dependsOn: ["a"],
          routes: { when: { kind: "anyFailed", stages: ["a"] } },
        },
      ],
      1,
    );
    const triggered = fireTrigger(pipeline);
    const startedA = startStage(triggered.state, asRunId("run-1"), "a", NOW + 1);
    // a fails → terminate marks b, c skipped.
    const failedA = reduce(startedA.state, {
      type: "STAGE_FAILED",
      now: NOW + 2,
      runId: asRunId("run-1"),
      stageName: "a",
      errorMessage: "boom",
    });

    const resumed = reduce(failedA.state, {
      type: "RUN_RESUMED",
      now: NOW + 3,
      runId: asRunId("run-1"),
      stageRunIds: { a: asStageRunId("sr-a-2") },
    });
    const startedRetry = startStage(resumed.state, asRunId("run-1"), "a", NOW + 4);
    const completed = completeStage(startedRetry.state, asRunId("run-1"), "a", NOW + 5);

    const run = completed.state.runs[asRunId("run-1")];
    expect(run.stages.a.status).toBe("succeeded");
    // b ran (deps satisfied, no routes), c re-skipped (anyFailed false).
    expect(run.stages.c.status).toBe("skipped");
  });
});
