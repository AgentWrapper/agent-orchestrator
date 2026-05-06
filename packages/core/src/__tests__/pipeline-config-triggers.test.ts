/**
 * Config-schema coverage for `Pipeline.triggers` + `Pipeline.concurrency`.
 *
 * The trigger evaluator + concurrency decisions are tested in
 * `pipeline-triggers.test.ts`. This file just locks in the YAML surface so
 * accidental schema regressions surface at PR review.
 */

import { describe, expect, it } from "vitest";

import {
  ConfiguredPipelineSchema,
  configuredPipelineToRuntime,
} from "../pipeline/index.js";

const minimalStage = {
  name: "review",
  trigger: { on: ["pr.opened"] },
  executor: { kind: "agent" as const, plugin: "codex", mode: "review" as const },
  task: { prompt: "review" },
};

describe("ConfiguredPipelineSchema — triggers", () => {
  it("accepts a pipeline with no triggers (manual-only)", () => {
    const result = ConfiguredPipelineSchema.safeParse({ stages: [minimalStage] });
    expect(result.success).toBe(true);
  });

  it("accepts the four trigger event types", () => {
    for (const on of ["pr_opened", "pr_push", "pr_review_requested", "manual"]) {
      const result = ConfiguredPipelineSchema.safeParse({
        stages: [minimalStage],
        triggers: [{ on }],
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects unknown trigger event types", () => {
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [minimalStage],
      triggers: [{ on: "pr_closed" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts all filter combinations", () => {
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [minimalStage],
      triggers: [
        {
          on: "pr_push",
          branches: ["main", "release/*"],
          files: ["src/**", "packages/**"],
          labels: ["needs-review"],
          excludeDrafts: true,
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("ConfiguredPipelineSchema — concurrency", () => {
  it("accepts the three policies", () => {
    for (const concurrency of ["cancel_in_progress", "skip", "queue"]) {
      const result = ConfiguredPipelineSchema.safeParse({
        stages: [minimalStage],
        concurrency,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown policy", () => {
    const result = ConfiguredPipelineSchema.safeParse({
      stages: [minimalStage],
      concurrency: "kill_all",
    });
    expect(result.success).toBe(false);
  });
});

describe("configuredPipelineToRuntime — triggers + concurrency", () => {
  it("forwards triggers and concurrency into runtime Pipeline", () => {
    const parsed = ConfiguredPipelineSchema.parse({
      stages: [minimalStage],
      triggers: [{ on: "pr_push", files: ["src/**"], excludeDrafts: true }],
      concurrency: "skip",
    });
    const runtime = configuredPipelineToRuntime("review", parsed);
    expect(runtime.triggers).toEqual([
      { on: "pr_push", files: ["src/**"], excludeDrafts: true },
    ]);
    expect(runtime.concurrency).toBe("skip");
  });

  it("omits triggers/concurrency when not specified", () => {
    const parsed = ConfiguredPipelineSchema.parse({ stages: [minimalStage] });
    const runtime = configuredPipelineToRuntime("review", parsed);
    expect(runtime.triggers).toBeUndefined();
    expect(runtime.concurrency).toBeUndefined();
  });
});
