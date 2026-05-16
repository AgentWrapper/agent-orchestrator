/**
 * v1.3 — Pipeline.exitPredicates integration with the reducer.
 *
 * Verifies that a fully-terminal run reaches:
 *  - `loopState: done`              when exitPredicates evaluate true
 *  - `loopState: stalled`           when exitPredicates evaluate false and
 *                                    `maxLoopRounds` is exhausted (or unset)
 *  - `loopState: awaiting_context`  when exitPredicates evaluate false but
 *                                    rounds remain (loop awaits next trigger)
 *
 * Also verifies the legacy path: when `exitPredicates` is unset, behavior
 * matches v1.1 (every terminal run → `done`).
 */

import { describe, expect, it } from "vitest";

import {
  asPipelineId,
  asRunId,
  asStageRunId,
  emptyEngineState,
  reduce,
  type Pipeline,
  type PipelineEvent,
  type Predicate,
  type Stage,
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

function makePipeline(
  stages: Stage[],
  exitPredicates?: Predicate[],
  maxLoopRounds?: number,
): Pipeline {
  return {
    id: asPipelineId("pl-1"),
    name: "default",
    stages,
    maxConcurrentStages: 1,
    ...(exitPredicates !== undefined ? { exitPredicates } : {}),
    ...(maxLoopRounds !== undefined ? { maxLoopRounds } : {}),
  };
}

describe("Pipeline.exitPredicates — terminal loop state mapping", () => {
  it("loop state = done when predicates are unset (v1.1 default)", () => {
    const pipeline = makePipeline([makeStage("review")]);
    const runId = asRunId("run-1");
    const trigger: PipelineEvent = {
      type: "TRIGGER_FIRED",
      now: NOW,
      trigger: "pr.opened",
      sessionId: "ses-1",
      pipeline,
      headSha: "sha-aaa",
      runId,
      stageRunIds: { review: asStageRunId("sr-1") },
    };
    let { state } = reduce(emptyEngineState(), trigger);
    state = reduce(state, {
      type: "STAGE_STARTED",
      now: NOW + 1,
      runId,
      stageName: "review",
    }).state;
    state = reduce(state, {
      type: "STAGE_COMPLETED",
      now: NOW + 2,
      runId,
      stageName: "review",
      artifacts: [],
    }).state;
    expect(state.runs[runId].loopState).toBe("done");
    expect(state.runs[runId].terminationReason).toBe("completed");
  });

  it("loop state = done when exitPredicates evaluate true", () => {
    const pipeline = makePipeline(
      [makeStage("review")],
      [{ kind: "all_pass", stages: ["review"] }, { kind: "no_open_findings" }],
    );
    const runId = asRunId("run-1");
    let { state } = reduce(emptyEngineState(), {
      type: "TRIGGER_FIRED",
      now: NOW,
      trigger: "pr.opened",
      sessionId: "ses-1",
      pipeline,
      headSha: "sha-aaa",
      runId,
      stageRunIds: { review: asStageRunId("sr-1") },
    });
    state = reduce(state, {
      type: "STAGE_STARTED",
      now: NOW + 1,
      runId,
      stageName: "review",
    }).state;
    state = reduce(state, {
      type: "STAGE_COMPLETED",
      now: NOW + 2,
      runId,
      stageName: "review",
      artifacts: [],
    }).state;
    expect(state.runs[runId].loopState).toBe("done");
  });

  it("loop state = stalled when exitPredicates evaluate false and rounds exhausted", () => {
    const pipeline = makePipeline(
      [makeStage("review")],
      // Open finding produced → no_open_findings fails.
      [{ kind: "no_open_findings" }],
    );
    const runId = asRunId("run-1");
    let { state } = reduce(emptyEngineState(), {
      type: "TRIGGER_FIRED",
      now: NOW,
      trigger: "pr.opened",
      sessionId: "ses-1",
      pipeline,
      headSha: "sha-aaa",
      runId,
      stageRunIds: { review: asStageRunId("sr-1") },
    });
    state = reduce(state, {
      type: "STAGE_STARTED",
      now: NOW + 1,
      runId,
      stageName: "review",
    }).state;
    const result = reduce(state, {
      type: "STAGE_COMPLETED",
      now: NOW + 2,
      runId,
      stageName: "review",
      artifacts: [
        {
          kind: "finding",
          filePath: "x.ts",
          startLine: 1,
          endLine: 2,
          title: "t",
          description: "d",
          category: "general",
          severity: "warning",
          confidence: 0.9,
        },
      ],
    });
    expect(result.state.runs[runId].loopState).toBe("stalled");
    // pipeline.loop.failed observation is emitted in addition to
    // pipeline.run.terminated.
    const loopFailed = result.effects.find(
      (e) => e.type === "EMIT_OBSERVATION" && e.event.name === "pipeline.loop.failed",
    );
    expect(loopFailed).toBeDefined();
  });

  it("loop state = awaiting_context when predicates fail but rounds remain", () => {
    const pipeline = makePipeline(
      [makeStage("review")],
      [{ kind: "no_open_findings" }],
      // 5 rounds allowed, current loopRounds will be 1 — plenty of headroom.
      5,
    );
    const runId = asRunId("run-1");
    let { state } = reduce(emptyEngineState(), {
      type: "TRIGGER_FIRED",
      now: NOW,
      trigger: "pr.opened",
      sessionId: "ses-1",
      pipeline,
      headSha: "sha-aaa",
      runId,
      stageRunIds: { review: asStageRunId("sr-1") },
    });
    state = reduce(state, {
      type: "STAGE_STARTED",
      now: NOW + 1,
      runId,
      stageName: "review",
    }).state;
    state = reduce(state, {
      type: "STAGE_COMPLETED",
      now: NOW + 2,
      runId,
      stageName: "review",
      artifacts: [
        {
          kind: "finding",
          filePath: "x.ts",
          startLine: 1,
          endLine: 2,
          title: "t",
          description: "d",
          category: "general",
          severity: "warning",
          confidence: 0.9,
        },
      ],
    }).state;
    expect(state.runs[runId].loopState).toBe("awaiting_context");
    expect(state.runs[runId].terminationReason).toBe("completed");
  });

  it("emits pipeline.loop.succeeded observation on done", () => {
    const pipeline = makePipeline([makeStage("review")], [{ kind: "no_open_findings" }]);
    const runId = asRunId("run-1");
    let { state } = reduce(emptyEngineState(), {
      type: "TRIGGER_FIRED",
      now: NOW,
      trigger: "pr.opened",
      sessionId: "ses-1",
      pipeline,
      headSha: "sha-aaa",
      runId,
      stageRunIds: { review: asStageRunId("sr-1") },
    });
    state = reduce(state, {
      type: "STAGE_STARTED",
      now: NOW + 1,
      runId,
      stageName: "review",
    }).state;
    const result = reduce(state, {
      type: "STAGE_COMPLETED",
      now: NOW + 2,
      runId,
      stageName: "review",
      artifacts: [],
    });
    const succeeded = result.effects.find(
      (e) => e.type === "EMIT_OBSERVATION" && e.event.name === "pipeline.loop.succeeded",
    );
    expect(succeeded).toBeDefined();
  });
});
