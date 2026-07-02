import { describe, it, expect } from "vitest";
import { StaticPlanner, BUNDLE_MAX } from "../planner.js";
import type { TaskContext } from "../types.js";

const CTX: TaskContext = { projectId: "p_1", projectRoot: "/tmp/p", taskText: "fix the bug" };

describe("StaticPlanner", () => {
  it("returns null when there is no task text", () => {
    const planner = new StaticPlanner();
    expect(
      planner.plan(
        { ...CTX, taskText: "  " },
        { graphAvailable: true, vectorAvailable: true },
      ),
    ).toBeNull();
  });

  it("returns null when neither provider is available", () => {
    const planner = new StaticPlanner();
    expect(
      planner.plan(CTX, { graphAvailable: false, vectorAvailable: false }),
    ).toBeNull();
  });

  it("splits the budget ~55/45 graph/vector when both are available", () => {
    const planner = new StaticPlanner();
    const shares = planner.plan(CTX, { graphAvailable: true, vectorAvailable: true })!;
    expect(shares.graphWeight).toBeCloseTo(0.55);
    expect(shares.vectorWeight).toBeCloseTo(0.45);
    // Over-fetch: each provider budget exceeds its raw share of BUNDLE_MAX.
    expect(shares.graphBudget.maxTokens).toBeGreaterThan(BUNDLE_MAX * 0.55);
    expect(shares.vectorBudget.maxTokens).toBeGreaterThan(BUNDLE_MAX * 0.45);
  });

  it("spills 100% to vector when graph is unavailable", () => {
    const planner = new StaticPlanner();
    const shares = planner.plan(CTX, { graphAvailable: false, vectorAvailable: true })!;
    expect(shares.graphWeight).toBe(0);
    expect(shares.vectorWeight).toBe(1);
    expect(shares.graphBudget.maxTokens).toBe(0);
  });

  it("spills 100% to graph when vector is unavailable", () => {
    const planner = new StaticPlanner();
    const shares = planner.plan(CTX, { graphAvailable: true, vectorAvailable: false })!;
    expect(shares.graphWeight).toBe(1);
    expect(shares.vectorWeight).toBe(0);
    expect(shares.vectorBudget.maxTokens).toBe(0);
  });

  it("normalizes whitespace and truncates the query to 200 chars", () => {
    const planner = new StaticPlanner();
    const longText = "x".repeat(300);
    const shares = planner.plan(
      { ...CTX, taskText: `  fix   the\n\nbug  ${longText}` },
      { graphAvailable: true, vectorAvailable: true },
    )!;
    expect(shares.normalizedQuery.startsWith("fix the bug")).toBe(true);
    expect(shares.normalizedQuery.length).toBe(200);
  });
});
