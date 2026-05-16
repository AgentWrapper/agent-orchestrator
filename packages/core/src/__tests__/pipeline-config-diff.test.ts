/**
 * v1.3 — CONFIG_CHANGED classification.
 *
 * Verifies the structural vs tuning split: drivers can pick `tuning` changes
 * up live, but `structural` changes must terminate the active run via
 * CONFIG_CHANGED. The reducer's existing CONFIG_CHANGED handler is unchanged
 * — it terminates regardless. The classifier decides whether to dispatch.
 */

import { describe, expect, it } from "vitest";

import {
  asPipelineId,
  classifyConfigChange,
  type Pipeline,
  type Predicate,
  type Stage,
} from "../pipeline/index.js";

function stage(name: string, overrides: Partial<Stage> = {}): Stage {
  return {
    name,
    trigger: { on: ["pr.opened"] },
    executor: { kind: "agent", plugin: "codex", mode: "review" },
    task: { prompt: `run ${name}` },
    ...overrides,
  };
}

function pipeline(stages: Stage[], overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: asPipelineId("pl-1"),
    name: "default",
    stages,
    maxConcurrentStages: 1,
    ...overrides,
  };
}

describe("classifyConfigChange — none", () => {
  it("returns none when nothing changed", () => {
    const p = pipeline([stage("review")]);
    expect(classifyConfigChange(p, p)).toEqual({ kind: "none", reasons: [] });
  });

  it("deep-equals nested objects (executor.config)", () => {
    const a = pipeline([
      stage("review", {
        executor: {
          kind: "agent",
          plugin: "codex",
          mode: "review",
          config: { tone: "strict" },
        },
      }),
    ]);
    const b = pipeline([
      stage("review", {
        executor: {
          kind: "agent",
          plugin: "codex",
          mode: "review",
          config: { tone: "strict" },
        },
      }),
    ]);
    expect(classifyConfigChange(a, b).kind).toBe("none");
  });

  it("is key-order independent for nested config (YAML reformatter safe)", () => {
    // Two pipelines with the same executor.config but keys inserted in a
    // different order — a JSON.stringify comparator would falsely call this
    // structural and abort an in-flight run.
    const a = pipeline([
      stage("review", {
        executor: {
          kind: "agent",
          plugin: "codex",
          mode: "review",
          config: { tone: "strict", depth: 2, nested: { a: 1, b: 2 } },
        },
      }),
    ]);
    const b = pipeline([
      stage("review", {
        executor: {
          kind: "agent",
          plugin: "codex",
          mode: "review",
          config: { depth: 2, nested: { b: 2, a: 1 }, tone: "strict" },
        },
      }),
    ]);
    expect(classifyConfigChange(a, b).kind).toBe("none");
  });
});

describe("classifyConfigChange — structural", () => {
  it("renamed stage is structural", () => {
    expect(classifyConfigChange(pipeline([stage("review")]), pipeline([stage("audit")])).kind).toBe(
      "structural",
    );
  });

  it("added stage is structural", () => {
    const before = pipeline([stage("review")]);
    const after = pipeline([stage("review"), stage("fix")]);
    expect(classifyConfigChange(before, after).kind).toBe("structural");
  });

  it("removed stage is structural", () => {
    const before = pipeline([stage("review"), stage("fix")]);
    const after = pipeline([stage("review")]);
    expect(classifyConfigChange(before, after).kind).toBe("structural");
  });

  it("reordered stages is structural (DAG slot priority depends on order)", () => {
    const before = pipeline([stage("review"), stage("fix")]);
    const after = pipeline([stage("fix"), stage("review")]);
    expect(classifyConfigChange(before, after).kind).toBe("structural");
  });

  it("changed dependsOn is structural", () => {
    const before = pipeline([stage("review"), stage("fix", { dependsOn: ["review"] })]);
    const after = pipeline([stage("review"), stage("fix")]);
    expect(classifyConfigChange(before, after).kind).toBe("structural");
  });

  it("changed executor plugin is structural", () => {
    const before = pipeline([
      stage("review", { executor: { kind: "agent", plugin: "codex", mode: "review" } }),
    ]);
    const after = pipeline([
      stage("review", { executor: { kind: "agent", plugin: "aider", mode: "review" } }),
    ]);
    expect(classifyConfigChange(before, after).kind).toBe("structural");
  });

  it("changed routes is structural", () => {
    const before = pipeline([stage("review"), stage("fix")]);
    const after = pipeline([
      stage("review"),
      stage("fix", {
        routes: { when: { kind: "all_pass", stages: ["review"] } as Predicate },
      }),
    ]);
    expect(classifyConfigChange(before, after).kind).toBe("structural");
  });

  it("pipeline rename is structural", () => {
    const before = pipeline([stage("review")], { name: "ci" });
    const after = pipeline([stage("review")], { name: "ci-v2" });
    expect(classifyConfigChange(before, after).kind).toBe("structural");
  });
});

describe("classifyConfigChange — tuning", () => {
  it("retries change is tuning", () => {
    const before = pipeline([stage("review")]);
    const after = pipeline([stage("review", { retries: 3 })]);
    expect(classifyConfigChange(before, after).kind).toBe("tuning");
  });

  it("budget tweak is tuning", () => {
    const before = pipeline([stage("review", { budget: { maxUsd: 1 } })]);
    const after = pipeline([stage("review", { budget: { maxUsd: 5 } })]);
    expect(classifyConfigChange(before, after).kind).toBe("tuning");
  });

  it("exitPredicates change is tuning (threshold edits)", () => {
    const before = pipeline([stage("review")], {
      exitPredicates: [{ kind: "finding_count_below", n: 3 }],
    });
    const after = pipeline([stage("review")], {
      exitPredicates: [{ kind: "finding_count_below", n: 5 }],
    });
    expect(classifyConfigChange(before, after).kind).toBe("tuning");
  });

  it("maxLoopRounds bump is tuning", () => {
    const before = pipeline([stage("review")], { maxLoopRounds: 3 });
    const after = pipeline([stage("review")], { maxLoopRounds: 5 });
    expect(classifyConfigChange(before, after).kind).toBe("tuning");
  });

  it("maxConcurrentStages bump is tuning", () => {
    const before = pipeline([stage("review")], { maxConcurrentStages: 1 });
    const after = pipeline([stage("review")], { maxConcurrentStages: 4 });
    expect(classifyConfigChange(before, after).kind).toBe("tuning");
  });

  it("workspaceClass annotation is tuning", () => {
    const before = pipeline([stage("review"), stage("fix")]);
    const after = pipeline([stage("review"), stage("fix", { workspaceClass: "read-siblings" })]);
    expect(classifyConfigChange(before, after).kind).toBe("tuning");
  });
});

describe("classifyConfigChange — promotion semantics", () => {
  it("any structural change wins over concurrent tuning changes", () => {
    const before = pipeline([stage("review", { retries: 2 })]);
    const after = pipeline([stage("audit", { retries: 5 })]);
    const result = classifyConfigChange(before, after);
    expect(result.kind).toBe("structural");
    // The dominant reason is the structural one — the tuning reasons may or
    // may not appear depending on early-exit; only assert the structural one.
    expect(result.reasons[0]).toMatch(/stage list changed/);
  });
});
