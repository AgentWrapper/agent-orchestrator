/**
 * Tests for the command executor — shell-based pipeline stages.
 *
 * The executor is exercised against real subprocesses via /bin/sh -c so we
 * cover the actual spawn → stdout-capture → JSONL-parse path end-to-end.
 * Fork-PR refusal and executor-kind guards run in-process with no subprocess.
 */

import { describe, expect, it, vi } from "vitest";

import {
  asRunId,
  asStageRunId,
  createCommandExecutor,
  formatForkRefusalMessage,
  type CommandStartInput,
  type Stage,
} from "../pipeline/index.js";

function makeCommandStage(overrides: Partial<Stage> = {}): Stage {
  return {
    name: "lint",
    trigger: { on: ["pr.opened"] },
    executor: { kind: "command", command: "echo", args: [] },
    task: {},
    ...overrides,
  };
}

function makeInput(overrides: Partial<CommandStartInput> = {}): CommandStartInput {
  return {
    pipelineName: "default",
    runId: asRunId("run-1"),
    stageRunId: asStageRunId("sr-1"),
    stage: makeCommandStage(),
    loopRound: 1,
    ...overrides,
  };
}

describe("command executor — guards", () => {
  it("rejects non-command stages with a typed failure", async () => {
    const exec = createCommandExecutor();
    const outcome = await exec.run(
      makeInput({
        stage: makeCommandStage({
          executor: { kind: "agent", plugin: "claude-code", mode: "code" },
        }),
      }),
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.errorMessage).toContain("command executor cannot run");
  });

  it("refuses to run a fork PR when stage.allowFork is unset", async () => {
    const onRefuse = vi.fn();
    const exec = createCommandExecutor({ onRefuse });
    const stage = makeCommandStage({
      executor: {
        kind: "command",
        command: "/bin/sh",
        args: ["-c", "echo should-not-run"],
      },
    });

    const outcome = await exec.run(makeInput({ stage, isFromFork: true }));

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.refused).toBe(true);
    expect(outcome.errorMessage).toBe(formatForkRefusalMessage(stage.name));
    expect(onRefuse).toHaveBeenCalledTimes(1);
    expect(onRefuse).toHaveBeenCalledWith(stage, formatForkRefusalMessage(stage.name));
  });

  it("refuses to run a fork PR when stage.allowFork is explicitly false", async () => {
    const exec = createCommandExecutor();
    const stage = makeCommandStage({
      allowFork: false,
      executor: { kind: "command", command: "/bin/sh", args: ["-c", "echo hi"] },
    });
    const outcome = await exec.run(makeInput({ stage, isFromFork: true }));
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.refused).toBe(true);
  });

  it("runs a fork PR when stage.allowFork is explicitly true", async () => {
    const exec = createCommandExecutor();
    const stage = makeCommandStage({
      allowFork: true,
      executor: { kind: "command", command: "/bin/sh", args: ["-c", "echo -n ''"] },
    });
    const outcome = await exec.run(makeInput({ stage, isFromFork: true }));
    expect(outcome).toEqual({ status: "completed", artifacts: [] });
  });

  it("runs non-fork PRs without checking allowFork", async () => {
    const exec = createCommandExecutor();
    const stage = makeCommandStage({
      executor: { kind: "command", command: "/bin/sh", args: ["-c", "true"] },
    });
    const outcome = await exec.run(makeInput({ stage, isFromFork: false }));
    expect(outcome.status).toBe("completed");
  });
});

describe("command executor — stdout findings", () => {
  it("parses JSONL stdout into ArtifactInput records", async () => {
    const exec = createCommandExecutor();
    const finding = {
      kind: "finding",
      filePath: "src/foo.ts",
      startLine: 1,
      endLine: 2,
      title: "t",
      description: "d",
      category: "general",
      severity: "info",
      confidence: 0.5,
    };
    const jsonArtifact = { kind: "json", data: { ok: true } };
    // Single-quoted in sh so JSON.stringify's double quotes survive. JSON
    // never emits literal single quotes so the embedding is unambiguous.
    const script = `echo '${JSON.stringify(finding)}'; echo '${JSON.stringify(jsonArtifact)}'`;

    const stage = makeCommandStage({
      executor: { kind: "command", command: "/bin/sh", args: ["-c", script] },
    });
    const outcome = await exec.run(makeInput({ stage }));

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    expect(outcome.artifacts).toHaveLength(2);
    expect(outcome.artifacts[0]).toMatchObject({ kind: "finding", title: "t" });
    expect(outcome.artifacts[1]).toMatchObject({ kind: "json", data: { ok: true } });
  });

  it("parses a single JSON array stdout into ArtifactInput records", async () => {
    const exec = createCommandExecutor();
    const arr = [{ kind: "json", data: { a: 1 } }, { kind: "json", data: { b: 2 } }];
    const stage = makeCommandStage({
      executor: {
        kind: "command",
        command: "/bin/sh",
        args: ["-c", `printf '%s' ${JSON.stringify(JSON.stringify(arr))}`],
      },
    });

    const outcome = await exec.run(makeInput({ stage }));
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    expect(outcome.artifacts).toEqual(arr);
  });

  it("treats empty stdout as zero artifacts", async () => {
    const exec = createCommandExecutor();
    const stage = makeCommandStage({
      executor: { kind: "command", command: "/bin/sh", args: ["-c", "true"] },
    });
    const outcome = await exec.run(makeInput({ stage }));
    expect(outcome).toEqual({ status: "completed", artifacts: [] });
  });

  it("fails on non-zero exit codes and surfaces stderr in the error", async () => {
    const exec = createCommandExecutor();
    const stage = makeCommandStage({
      executor: {
        kind: "command",
        command: "/bin/sh",
        args: ["-c", "echo boom >&2; exit 3"],
      },
    });
    const outcome = await exec.run(makeInput({ stage }));
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.errorMessage).toContain("exited 3");
    expect(outcome.errorMessage).toContain("boom");
  });

  it("fails when stdout is invalid JSON", async () => {
    const exec = createCommandExecutor();
    const stage = makeCommandStage({
      executor: {
        kind: "command",
        command: "/bin/sh",
        args: ["-c", "echo 'not json {{{'"],
      },
    });
    const outcome = await exec.run(makeInput({ stage }));
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.errorMessage).toContain("unparseable findings");
  });

  it("fails when a finding has confidence out of [0, 1]", async () => {
    const exec = createCommandExecutor();
    const bad = {
      kind: "finding",
      filePath: "x.ts",
      startLine: 1,
      endLine: 1,
      title: "t",
      description: "d",
      category: "c",
      severity: "info",
      confidence: 5,
    };
    const stage = makeCommandStage({
      executor: {
        kind: "command",
        command: "/bin/sh",
        args: ["-c", `printf '%s' ${JSON.stringify(JSON.stringify(bad))}`],
      },
    });
    const outcome = await exec.run(makeInput({ stage }));
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.errorMessage).toContain("confidence");
  });
});

describe("command executor — environment", () => {
  it("threads AO_PIPELINE_* env vars into the child process", async () => {
    const exec = createCommandExecutor();
    const stage = makeCommandStage({
      executor: {
        kind: "command",
        command: "/bin/sh",
        args: [
          "-c",
          'printf \'{"kind":"json","data":{"stage":"%s","run":"%s"}}\' "$AO_PIPELINE_STAGE_NAME" "$AO_PIPELINE_RUN_ID"',
        ],
      },
    });

    const outcome = await exec.run(
      makeInput({
        runId: asRunId("run-xyz"),
        stage,
      }),
    );

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    expect(outcome.artifacts[0]).toMatchObject({
      kind: "json",
      data: { stage: "lint", run: "run-xyz" },
    });
  });

  it("lets stage.env overrides win over default env", async () => {
    const exec = createCommandExecutor();
    const stage = makeCommandStage({
      executor: {
        kind: "command",
        command: "/bin/sh",
        args: ["-c", 'printf \'{"kind":"json","data":{"v":"%s"}}\' "$MY_VAR"'],
        env: { MY_VAR: "from-stage" },
      },
    });
    const outcome = await exec.run(makeInput({ stage }));
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    expect(outcome.artifacts[0]).toMatchObject({ kind: "json", data: { v: "from-stage" } });
  });
});
