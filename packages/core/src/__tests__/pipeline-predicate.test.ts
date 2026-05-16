/**
 * v1.3 typed predicate DSL — parser (Zod) + evaluator coverage.
 *
 * Verifies:
 *  - PredicateSchema accepts every leaf + boolean combinator
 *  - PredicateSchema rejects malformed forms with line-precise errors
 *  - evaluatePredicate honors leaf semantics over stages + artifacts
 *  - Legacy `StageRoutePredicate` shapes still parse and translate via
 *    fromLegacyRoutePredicate
 *  - collectReferencedStages walks the tree (transitive across and/or/not)
 */

import { describe, expect, it } from "vitest";

import {
  asArtifactId,
  asRunId,
  asStageRunId,
  collectReferencedStages,
  evaluateExitPredicates,
  evaluatePredicate,
  fromLegacyRoutePredicate,
  isLegacyRoutePredicate,
  normalizeRoutePredicate,
  predicateDepth,
  PredicateSchema,
  type Artifact,
  type Predicate,
  type PredicateContext,
  type StageState,
} from "../pipeline/index.js";

const NOW_ISO = new Date(1_700_000_000_000).toISOString();

function makeStageState(name: string, overrides: Partial<StageState> = {}): StageState {
  return {
    stageRunId: asStageRunId(`sr-${name}`),
    status: "succeeded",
    attempt: 1,
    artifacts: [],
    ...overrides,
  };
}

function makeFinding(
  stageRunId: string,
  index: number,
  overrides: Partial<Artifact> = {},
): Artifact {
  return {
    artifactId: asArtifactId(`${stageRunId}-${index}`),
    pipelineRunId: asRunId("run-1"),
    stageRunId: asStageRunId(stageRunId),
    stageName: "review",
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
    createdAt: NOW_ISO,
    ...overrides,
  } as Artifact;
}

function ctx(
  stages: Record<string, StageState>,
  artifactsByStage: Record<string, Artifact[]> = {},
): PredicateContext {
  return {
    stages,
    artifactsByStage,
    allStageNames: Object.keys(stages),
  };
}

describe("PredicateSchema — parser", () => {
  it("accepts every leaf kind", () => {
    expect(PredicateSchema.safeParse({ kind: "all_pass", stages: ["a", "b"] }).success).toBe(true);
    expect(PredicateSchema.safeParse({ kind: "no_open_findings" }).success).toBe(true);
    expect(PredicateSchema.safeParse({ kind: "finding_count_below", n: 3 }).success).toBe(true);
  });

  it("accepts boolean combinators with nested leaves", () => {
    const pred: Predicate = {
      kind: "and",
      predicates: [
        { kind: "all_pass", stages: ["a"] },
        {
          kind: "or",
          predicates: [
            { kind: "no_open_findings" },
            { kind: "not", predicate: { kind: "finding_count_below", n: 5 } },
          ],
        },
      ],
    };
    expect(PredicateSchema.safeParse(pred).success).toBe(true);
  });

  it("rejects unknown kinds with a discriminator error", () => {
    const result = PredicateSchema.safeParse({ kind: "nope" });
    expect(result.success).toBe(false);
  });

  it("rejects empty boolean combinators", () => {
    expect(PredicateSchema.safeParse({ kind: "and", predicates: [] }).success).toBe(false);
    expect(PredicateSchema.safeParse({ kind: "or", predicates: [] }).success).toBe(false);
  });

  it("rejects finding_count_below with a negative n", () => {
    expect(PredicateSchema.safeParse({ kind: "finding_count_below", n: -1 }).success).toBe(false);
  });

  it("predicateDepth counts boolean nesting only", () => {
    expect(predicateDepth({ kind: "all_pass", stages: ["a"] })).toBe(0);
    expect(
      predicateDepth({
        kind: "and",
        predicates: [
          { kind: "all_pass", stages: ["a"] },
          { kind: "all_pass", stages: ["b"] },
        ],
      }),
    ).toBe(1);
    expect(
      predicateDepth({
        kind: "not",
        predicate: {
          kind: "and",
          predicates: [{ kind: "all_pass", stages: ["a"] }],
        },
      }),
    ).toBe(2);
  });
});

describe("evaluatePredicate — leaves", () => {
  it("all_pass uses stage scope when set, else every stage", () => {
    const stages = {
      a: makeStageState("a", { status: "succeeded" }),
      b: makeStageState("b", { status: "failed" }),
    };
    expect(evaluatePredicate({ kind: "all_pass", stages: ["a"] }, ctx(stages))).toBe(true);
    expect(evaluatePredicate({ kind: "all_pass", stages: ["b"] }, ctx(stages))).toBe(false);
    // No scope → all stages — fails because b is failed.
    expect(evaluatePredicate({ kind: "all_pass" }, ctx(stages))).toBe(false);
  });

  it("all_pass prefers verdict over status when verdict is set", () => {
    const stages = {
      a: makeStageState("a", { status: "succeeded", verdict: "fail" }),
    };
    expect(evaluatePredicate({ kind: "all_pass", stages: ["a"] }, ctx(stages))).toBe(false);
  });

  it("all_pass treats unknown stages as not-passing", () => {
    const stages = { a: makeStageState("a") };
    expect(evaluatePredicate({ kind: "all_pass", stages: ["ghost"] }, ctx(stages))).toBe(false);
  });

  it("no_open_findings counts only open finding artifacts", () => {
    const stages = { review: makeStageState("review") };
    const open = makeFinding("review", 0, { status: "open" });
    const resolved = makeFinding("review", 1, { status: "resolved" });
    expect(evaluatePredicate({ kind: "no_open_findings" }, ctx(stages, { review: [open] }))).toBe(
      false,
    );
    expect(
      evaluatePredicate({ kind: "no_open_findings" }, ctx(stages, { review: [resolved] })),
    ).toBe(true);
  });

  it("finding_count_below is strictly less than n", () => {
    const stages = { review: makeStageState("review") };
    const findings = [makeFinding("review", 0), makeFinding("review", 1), makeFinding("review", 2)];
    expect(
      evaluatePredicate({ kind: "finding_count_below", n: 3 }, ctx(stages, { review: findings })),
    ).toBe(false); // count = 3, not < 3
    expect(
      evaluatePredicate({ kind: "finding_count_below", n: 4 }, ctx(stages, { review: findings })),
    ).toBe(true);
  });
});

describe("evaluatePredicate — booleans", () => {
  const stages = {
    a: makeStageState("a", { status: "succeeded" }),
    b: makeStageState("b", { status: "failed" }),
  };

  it("and is true only when every child is true", () => {
    expect(
      evaluatePredicate(
        {
          kind: "and",
          predicates: [
            { kind: "all_pass", stages: ["a"] },
            { kind: "all_pass", stages: ["a"] },
          ],
        },
        ctx(stages),
      ),
    ).toBe(true);
    expect(
      evaluatePredicate(
        {
          kind: "and",
          predicates: [
            { kind: "all_pass", stages: ["a"] },
            { kind: "all_pass", stages: ["b"] },
          ],
        },
        ctx(stages),
      ),
    ).toBe(false);
  });

  it("or is true when at least one child is true", () => {
    expect(
      evaluatePredicate(
        {
          kind: "or",
          predicates: [
            { kind: "all_pass", stages: ["b"] },
            { kind: "all_pass", stages: ["a"] },
          ],
        },
        ctx(stages),
      ),
    ).toBe(true);
  });

  it("not inverts its child", () => {
    expect(
      evaluatePredicate(
        { kind: "not", predicate: { kind: "all_pass", stages: ["a"] } },
        ctx(stages),
      ),
    ).toBe(false);
    expect(
      evaluatePredicate(
        { kind: "not", predicate: { kind: "all_pass", stages: ["b"] } },
        ctx(stages),
      ),
    ).toBe(true);
  });
});

describe("evaluateExitPredicates", () => {
  const stages = { a: makeStageState("a") };

  it("returns true for empty / undefined predicate lists (v1.1 default)", () => {
    expect(evaluateExitPredicates(undefined, ctx(stages))).toBe(true);
    expect(evaluateExitPredicates([], ctx(stages))).toBe(true);
  });

  it("AND-combines multiple predicates", () => {
    expect(
      evaluateExitPredicates(
        [{ kind: "all_pass", stages: ["a"] }, { kind: "no_open_findings" }],
        ctx(stages),
      ),
    ).toBe(true);
    expect(
      evaluateExitPredicates(
        [
          { kind: "all_pass", stages: ["a"] },
          { kind: "finding_count_below", n: 0 },
        ],
        ctx(stages, { a: [makeFinding("a", 0)] }),
      ),
    ).toBe(false);
  });
});

describe("Legacy route predicate bridge", () => {
  it("isLegacyRoutePredicate detects v1.1 shapes only", () => {
    expect(isLegacyRoutePredicate({ kind: "allSucceeded", stages: ["a"] })).toBe(true);
    expect(isLegacyRoutePredicate({ kind: "anySucceeded", stages: ["a"] })).toBe(true);
    expect(isLegacyRoutePredicate({ kind: "anyFailed", stages: ["a"] })).toBe(true);
    expect(isLegacyRoutePredicate({ kind: "all_pass", stages: ["a"] })).toBe(false);
  });

  it("fromLegacyRoutePredicate maps allSucceeded → all_pass", () => {
    expect(fromLegacyRoutePredicate({ kind: "allSucceeded", stages: ["a", "b"] })).toEqual({
      kind: "all_pass",
      stages: ["a", "b"],
    });
  });

  it("fromLegacyRoutePredicate maps anySucceeded → or-of-single-stage", () => {
    const out = fromLegacyRoutePredicate({ kind: "anySucceeded", stages: ["a", "b"] });
    expect(out.kind).toBe("or");
    if (out.kind !== "or") return;
    expect(out.predicates).toEqual([
      { kind: "all_pass", stages: ["a"] },
      { kind: "all_pass", stages: ["b"] },
    ]);
  });

  it("fromLegacyRoutePredicate maps anyFailed → not(all_pass)", () => {
    expect(fromLegacyRoutePredicate({ kind: "anyFailed", stages: ["a"] })).toEqual({
      kind: "not",
      predicate: { kind: "all_pass", stages: ["a"] },
    });
  });

  it("normalizeRoutePredicate passes new DSL through unchanged", () => {
    const dsl: Predicate = { kind: "all_pass", stages: ["a"] };
    expect(normalizeRoutePredicate(dsl)).toBe(dsl);
  });

  it("anyFailed semantics: not(all_pass) fires when any stage didn't succeed", () => {
    const stages = {
      a: makeStageState("a", { status: "succeeded" }),
      b: makeStageState("b", { status: "failed" }),
    };
    const pred = fromLegacyRoutePredicate({ kind: "anyFailed", stages: ["a", "b"] });
    expect(evaluatePredicate(pred, ctx(stages))).toBe(true);
  });
});

describe("collectReferencedStages", () => {
  it("walks transitively across and/or/not", () => {
    const refs = collectReferencedStages({
      kind: "and",
      predicates: [
        { kind: "all_pass", stages: ["a"] },
        {
          kind: "or",
          predicates: [
            { kind: "no_open_findings", stages: ["b"] },
            { kind: "not", predicate: { kind: "finding_count_below", n: 1, stages: ["c"] } },
          ],
        },
      ],
    });
    expect([...refs].sort()).toEqual(["a", "b", "c"]);
  });

  it("returns empty for leaves without an explicit scope", () => {
    expect(collectReferencedStages({ kind: "no_open_findings" })).toEqual([]);
  });

  it("normalizes legacy route predicates before walking", () => {
    expect(collectReferencedStages({ kind: "allSucceeded", stages: ["a"] })).toEqual(["a"]);
  });
});
