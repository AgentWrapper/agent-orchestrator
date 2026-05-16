/**
 * Tests for the builtin/router executor.
 *
 * Uses an in-memory BuiltinTaskContext mock — the executor is pure over its
 * context so no subprocess / session manager is needed at this layer. The
 * end-to-end "delivers findings to a target session" check lives in
 * pipeline-builtin-router.integration.test.ts.
 */

import { describe, expect, it, vi } from "vitest";

import {
  asArtifactId,
  asRunId,
  asStageRunId,
  createBuiltinRouterExecutor,
  type Artifact,
  type BuiltinRunInput,
  type BuiltinTaskContext,
  type Stage,
} from "../pipeline/index.js";

function makeStage(overrides: Partial<Stage> = {}): Stage {
  return {
    name: "router",
    trigger: { on: ["manual"] },
    executor: {
      kind: "builtin/router",
      fromStages: ["lint", "scan"],
      target: { kind: "self" },
    },
    task: {},
    dependsOn: ["lint", "scan"],
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Artifact> = {}): Artifact {
  return {
    artifactId: asArtifactId("art-1"),
    pipelineRunId: asRunId("run-1"),
    stageRunId: asStageRunId("sr-up-1"),
    stageName: "lint",
    status: "open",
    createdAt: new Date().toISOString(),
    kind: "finding",
    filePath: "src/foo.ts",
    startLine: 1,
    endLine: 2,
    title: "missing return",
    description: "fn missing return",
    category: "correctness",
    severity: "warning",
    confidence: 0.7,
    ...overrides,
  } as Artifact;
}

function makeCtx(overrides: Partial<BuiltinTaskContext> = {}): {
  ctx: BuiltinTaskContext;
  send: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => undefined);
  const read = vi.fn(async (_stage: string): Promise<Artifact[]> => []);
  const ctx: BuiltinTaskContext = {
    runId: asRunId("run-1"),
    stageRunId: asStageRunId("sr-1"),
    stageName: "router",
    sessionId: "session-self",
    pipelineName: "default",
    readSiblingArtifacts: read,
    sendToSession: send,
    ...overrides,
  };
  return { ctx, send, read };
}

function makeInput(ctx: BuiltinTaskContext, overrides: Partial<BuiltinRunInput> = {}): BuiltinRunInput {
  return {
    runId: asRunId("run-1"),
    stageRunId: asStageRunId("sr-1"),
    stage: makeStage(),
    loopRound: 2,
    ctx,
    ...overrides,
  };
}

describe("builtin/router — guards", () => {
  it("rejects non-builtin-router stages", async () => {
    const { ctx } = makeCtx();
    const exec = createBuiltinRouterExecutor();
    const outcome = await exec.run(
      makeInput(ctx, {
        stage: makeStage({ executor: { kind: "agent", plugin: "claude-code", mode: "code" } }),
      }),
    );
    expect(outcome.status).toBe("failed");
  });
});

describe("builtin/router — delivery", () => {
  it("reads siblings, formats payload, delivers to the resolved target", async () => {
    const findings = [makeFinding({ title: "issue A" })];
    const scans = [makeFinding({ stageName: "scan", title: "issue B" })];
    const { ctx, send, read } = makeCtx({
      sessionId: "session-self",
    });
    read.mockImplementation(async (stage: string) =>
      stage === "lint" ? findings : stage === "scan" ? scans : [],
    );

    const exec = createBuiltinRouterExecutor();
    const outcome = await exec.run(makeInput(ctx));

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");

    expect(read).toHaveBeenCalledWith("lint");
    expect(read).toHaveBeenCalledWith("scan");
    expect(send).toHaveBeenCalledTimes(1);

    const [target, payload] = send.mock.calls[0];
    expect(target).toBe("session-self");
    expect(payload).toContain("Pipeline routing: default → router");
    expect(payload).toContain("Loop round: 2");
    expect(payload).toContain("## From stage: lint (1 artifact)");
    expect(payload).toContain("issue A");
    expect(payload).toContain("## From stage: scan (1 artifact)");
    expect(payload).toContain("issue B");

    expect(outcome.artifacts).toHaveLength(1);
    expect(outcome.artifacts[0]).toMatchObject({
      kind: "json",
      data: {
        builtin: "router",
        targetSessionId: "session-self",
        bundles: [
          { stage: "lint", count: 1 },
          { stage: "scan", count: 1 },
        ],
      },
    });
  });

  it("delivers an empty payload when upstream stages produced no artifacts", async () => {
    const { ctx, send, read } = makeCtx();
    read.mockResolvedValue([]);

    const exec = createBuiltinRouterExecutor();
    const outcome = await exec.run(makeInput(ctx));

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");

    const payload = send.mock.calls[0]?.[1] as string;
    expect(payload).toContain("_no findings_");
    expect(outcome.artifacts[0]).toMatchObject({
      data: { bundles: [{ count: 0 }, { count: 0 }] },
    });
  });

  it("routes to a literal session id when target.kind === 'session'", async () => {
    const { ctx, send } = makeCtx();
    const exec = createBuiltinRouterExecutor();
    const outcome = await exec.run(
      makeInput(ctx, {
        stage: makeStage({
          executor: {
            kind: "builtin/router",
            fromStages: ["lint"],
            target: { kind: "session", sessionId: "ses-target" },
          },
        }),
      }),
    );

    expect(outcome.status).toBe("completed");
    expect(send).toHaveBeenCalledWith("ses-target", expect.any(String));
  });

  it("surfaces sendToSession errors as failed", async () => {
    const { ctx, send } = makeCtx();
    send.mockRejectedValueOnce(new Error("session not found"));

    const exec = createBuiltinRouterExecutor();
    const outcome = await exec.run(makeInput(ctx));

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.errorMessage).toContain("session not found");
    expect(outcome.errorMessage).toContain("session-self");
  });

  it("surfaces readSiblingArtifacts errors as failed (does not throw past the executor)", async () => {
    // Regression: previously the router let an uncaught rejection escape
    // through the engine, leaving the stage permanently `running`. Now
    // the router converts it to a normal `{ status: "failed" }` outcome.
    const { ctx, read, send } = makeCtx();
    read.mockRejectedValueOnce(new Error("store unavailable"));

    const exec = createBuiltinRouterExecutor();
    const outcome = await exec.run(makeInput(ctx));

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.errorMessage).toContain("store unavailable");
    expect(outcome.errorMessage).toContain("read sibling artifacts");
    // Must NOT have tried to deliver the (incomplete) payload.
    expect(send).not.toHaveBeenCalled();
  });
});
