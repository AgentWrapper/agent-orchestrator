/**
 * Tests for the builtin/compose executor.
 */

import { describe, expect, it, vi } from "vitest";

import {
  asArtifactId,
  asRunId,
  asStageRunId,
  createBuiltinComposeExecutor,
  type Artifact,
  type BuiltinRunInput,
  type BuiltinTaskContext,
  type Stage,
} from "../pipeline/index.js";

function makeStage(overrides: Partial<Stage> = {}): Stage {
  return {
    name: "compose",
    trigger: { on: ["manual"] },
    executor: { kind: "builtin/compose", fromStages: ["lint", "scan"] },
    task: {},
    dependsOn: ["lint", "scan"],
    ...overrides,
  };
}

function makeFinding(stage: string, title: string): Artifact {
  return {
    artifactId: asArtifactId(`art-${stage}-${title}`),
    pipelineRunId: asRunId("run-1"),
    stageRunId: asStageRunId(`sr-${stage}`),
    stageName: stage,
    status: "open",
    createdAt: new Date().toISOString(),
    kind: "finding",
    filePath: "src/x.ts",
    startLine: 1,
    endLine: 1,
    title,
    description: "d",
    category: "general",
    severity: "info",
    confidence: 0.5,
  } as Artifact;
}

function makeCtx(): {
  ctx: BuiltinTaskContext;
  read: ReturnType<typeof vi.fn>;
} {
  const read = vi.fn(async (_: string): Promise<Artifact[]> => []);
  const ctx: BuiltinTaskContext = {
    runId: asRunId("run-1"),
    stageRunId: asStageRunId("sr-1"),
    stageName: "compose",
    sessionId: "session-self",
    pipelineName: "default",
    readSiblingArtifacts: read,
    sendToSession: vi.fn(async () => undefined),
  };
  return { ctx, read };
}

function makeInput(ctx: BuiltinTaskContext, overrides: Partial<BuiltinRunInput> = {}): BuiltinRunInput {
  return {
    runId: asRunId("run-1"),
    stageRunId: asStageRunId("sr-1"),
    stage: makeStage(),
    loopRound: 1,
    ctx,
    ...overrides,
  };
}

describe("builtin/compose — guards", () => {
  it("rejects non-builtin-compose stages", async () => {
    const { ctx } = makeCtx();
    const exec = createBuiltinComposeExecutor();
    const outcome = await exec.run(
      makeInput(ctx, {
        stage: makeStage({ executor: { kind: "command", command: "true" } }),
      }),
    );
    expect(outcome.status).toBe("failed");
  });
});

describe("builtin/compose — bundling", () => {
  it("merges findings from two upstream stages into a single composite artifact", async () => {
    const { ctx, read } = makeCtx();
    const lintFindings = [makeFinding("lint", "lint-A"), makeFinding("lint", "lint-B")];
    const scanFindings = [makeFinding("scan", "scan-A")];
    read.mockImplementation(async (stage: string) =>
      stage === "lint" ? lintFindings : stage === "scan" ? scanFindings : [],
    );

    const exec = createBuiltinComposeExecutor();
    const outcome = await exec.run(makeInput(ctx));

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    expect(outcome.artifacts).toHaveLength(1);
    const [composite] = outcome.artifacts;
    expect(composite.kind).toBe("json");
    if (composite.kind !== "json") throw new Error("unreachable");
    expect(composite.data).toMatchObject({
      builtin: "compose",
      pipelineName: "default",
      sourceStages: ["lint", "scan"],
      loopRound: 1,
      bundles: [
        { stage: "lint", count: 2, artifacts: lintFindings },
        { stage: "scan", count: 1, artifacts: scanFindings },
      ],
    });
  });

  it("still emits a composite when upstream stages produced no findings", async () => {
    const { ctx, read } = makeCtx();
    read.mockResolvedValue([]);

    const exec = createBuiltinComposeExecutor();
    const outcome = await exec.run(makeInput(ctx));

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    expect(outcome.artifacts).toHaveLength(1);
    const composite = outcome.artifacts[0];
    if (composite.kind !== "json") throw new Error("unreachable");
    expect(composite.data).toMatchObject({
      bundles: [
        { stage: "lint", count: 0, artifacts: [] },
        { stage: "scan", count: 0, artifacts: [] },
      ],
    });
  });

  it("surfaces readSiblingArtifacts errors as failed", async () => {
    const { ctx, read } = makeCtx();
    read.mockRejectedValueOnce(new Error("store unavailable"));

    const exec = createBuiltinComposeExecutor();
    const outcome = await exec.run(makeInput(ctx));

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.errorMessage).toContain("store unavailable");
  });
});
