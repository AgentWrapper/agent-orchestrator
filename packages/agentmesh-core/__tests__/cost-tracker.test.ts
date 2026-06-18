import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CostTracker } from "../src/cost-tracker.js";

describe("CostTracker", () => {
  let dir: string;
  let ct: CostTracker;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ao-costs-"));
    ct = new CostTracker(dir, { maxCostPerTask: 10 });
  });

  afterEach(() => {
    ct.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("constructs without throwing (sqlite or in-memory fallback)", () => {
    expect(ct).toBeInstanceOf(CostTracker);
  });

  it("records cost entries and aggregates a task summary", () => {
    ct.recordCost({
      taskId: "TASK-1",
      agent: "claude-code",
      model: "sonnet",
      tokensUsed: 100,
      inputTokens: 60,
      outputTokens: 40,
      costUsd: 1.5,
      metadata: {},
    });
    ct.recordCost({
      taskId: "TASK-1",
      agent: "claude-code",
      model: "sonnet",
      tokensUsed: 50,
      inputTokens: 30,
      outputTokens: 20,
      costUsd: 0.5,
      metadata: {},
    });

    const summary = ct.getTaskSummary("TASK-1");
    expect(summary.totalCostUsd).toBeCloseTo(2.0);
    expect(summary.totalTokens).toBe(150);
    expect(summary.agentBreakdown["claude-code"].cost).toBeCloseTo(2.0);
    expect(summary.timeline).toHaveLength(2);
  });

  it("flags a task that exceeds its budget", () => {
    ct.recordCost({
      taskId: "TASK-2",
      agent: "codex",
      model: "gpt",
      tokensUsed: 10,
      inputTokens: 5,
      outputTokens: 5,
      costUsd: 25,
      metadata: {},
    });
    const budget = ct.checkTaskBudget("TASK-2");
    expect(budget.withinBudget).toBe(false);
    expect(budget.alerts.length).toBeGreaterThan(0);
  });
});
