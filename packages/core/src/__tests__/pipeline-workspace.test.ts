/**
 * v1.3 — workspace class config validation + read-siblings prompt wiring.
 *
 * Covers WorkspaceGuard at config load: a stage that declares
 * `workspaceClass: "read-siblings"` must declare `dependsOn` (the only edge
 * the engine actually walks for sibling artifact collection). Positional
 * neighbors and route refs don't qualify — the engine wouldn't collect
 * their artifacts at runtime. Also verifies the prompt surfaces sibling
 * artifacts when the class is set.
 */

import { describe, expect, it } from "vitest";

import {
  asArtifactId,
  asRunId,
  asStageRunId,
  buildStagePrompt,
  ConfiguredPipelineSchema,
  type Artifact,
  type Stage,
} from "../pipeline/index.js";

function makeStageInput(name: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    name,
    trigger: { on: ["pr.opened"] },
    executor: { kind: "agent", plugin: "codex", mode: "review" },
    task: { prompt: `run ${name}` },
    ...overrides,
  };
}

describe("WorkspaceGuard — read-siblings", () => {
  it("rejects a single stage declaring read-siblings (no dependsOn)", () => {
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [makeStageInput("only", { workspaceClass: "read-siblings" })],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message).join("\n");
    expect(messages).toContain('Stage "only"');
    expect(messages).toContain("read-siblings");
    expect(messages).toContain("dependsOn");
  });

  it("rejects the first-declared stage when it claims read-siblings", () => {
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [makeStageInput("a", { workspaceClass: "read-siblings" }), makeStageInput("b")],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message).join("\n");
    expect(messages).toContain('Stage "a"');
  });

  it("accepts read-siblings when dependsOn names an upstream stage", () => {
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [
        makeStageInput("review"),
        makeStageInput("fix", { workspaceClass: "read-siblings", dependsOn: ["review"] }),
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects read-siblings when only a prior stage is declared (no dependsOn)", () => {
    // Engine's collectSiblingArtifacts walks dependsOn only; positional
    // neighbors don't seed the BFS, so without dependsOn the prompt block
    // would silently be empty. Guard must reject.
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [
        makeStageInput("review"),
        makeStageInput("fix", { workspaceClass: "read-siblings" }),
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message).join("\n");
    expect(messages).toContain('Stage "fix"');
    expect(messages).toContain("dependsOn");
  });

  it("rejects read-siblings when only routes reference an upstream stage", () => {
    // Routes are activation gates, not data edges — they don't seed the
    // engine's artifact collection. Without dependsOn, sibling artifacts
    // would be empty at runtime.
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [
        makeStageInput("review"),
        makeStageInput("fix", {
          workspaceClass: "read-siblings",
          routes: { when: { kind: "all_pass", stages: ["review"] } },
        }),
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts independent (default) on a single-stage pipeline", () => {
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [makeStageInput("only")],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an explicit independent declaration on a first stage", () => {
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [makeStageInput("only", { workspaceClass: "independent" })],
    });
    expect(result.success).toBe(true);
  });
});

describe("buildStagePrompt — read-siblings artifact injection", () => {
  function makeArtifact(stageName: string): Artifact {
    return {
      artifactId: asArtifactId(`art-${stageName}`),
      pipelineRunId: asRunId("run-1"),
      stageRunId: asStageRunId(`sr-${stageName}`),
      stageName,
      kind: "finding",
      filePath: "src/x.ts",
      startLine: 1,
      endLine: 2,
      title: "t",
      description: "d",
      category: "general",
      severity: "warning",
      confidence: 0.9,
      status: "open",
      createdAt: new Date().toISOString(),
    } as Artifact;
  }

  const baseStage: Stage = {
    name: "fix",
    trigger: { on: ["pr.opened"] },
    executor: { kind: "agent", plugin: "codex", mode: "code" },
    task: { prompt: "Apply the suggested fixes." },
    dependsOn: ["review"],
    workspaceClass: "read-siblings",
  };

  it("emits an Upstream Artifacts block when artifacts exist", () => {
    const prompt = buildStagePrompt({
      pipelineName: "demo",
      stage: baseStage,
      siblingArtifacts: { review: [makeArtifact("review")] },
    });
    expect(prompt).toContain("## Upstream Artifacts");
    expect(prompt).toContain('"stageName": "review"');
  });

  it("omits the section when siblingArtifacts is empty", () => {
    const prompt = buildStagePrompt({
      pipelineName: "demo",
      stage: baseStage,
      siblingArtifacts: {},
    });
    expect(prompt).not.toContain("## Upstream Artifacts");
  });

  it("omits the section when workspaceClass is independent (default)", () => {
    const stage: Stage = { ...baseStage, workspaceClass: "independent" };
    const prompt = buildStagePrompt({
      pipelineName: "demo",
      stage,
      siblingArtifacts: { review: [makeArtifact("review")] },
    });
    expect(prompt).not.toContain("## Upstream Artifacts");
  });
});
