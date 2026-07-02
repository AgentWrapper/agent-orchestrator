/**
 * Static query planner (Ф1) — fixed provider shares of the bundle budget.
 * A future HeuristicPlanner (Ф2, measurement-driven) implements the same
 * QueryPlanner interface with adaptive shares.
 */

import type { TaskContext, TokenBudget } from "./types.js";

/** Total bundle cap, shared across both providers before greedy packing. */
export const BUNDLE_MAX = 2000;

export interface PlannerShares {
  normalizedQuery: string;
  graphBudget: TokenBudget;
  vectorBudget: TokenBudget;
  /** Cross-modal interleave weights (see fusion.ts::interleaveWeighted). */
  graphWeight: number;
  vectorWeight: number;
}

export interface PlannerAvailability {
  graphAvailable: boolean;
  vectorAvailable: boolean;
  totalBudget?: TokenBudget;
}

export interface QueryPlanner {
  /** Returns null when there's nothing to plan (no task text, or no provider available). */
  plan(ctx: TaskContext, availability: PlannerAvailability): PlannerShares | null;
}

export class StaticPlanner implements QueryPlanner {
  private static readonly GRAPH_SHARE = 0.55;
  private static readonly VECTOR_SHARE = 0.45;
  /** Over-fetch: providers are asked for more than their final packed share,
   * since fusion dedup + bundle packing both trim the raw candidate set. */
  private static readonly OVERFETCH = 1.5;

  plan(ctx: TaskContext, availability: PlannerAvailability): PlannerShares | null {
    const normalizedQuery = (ctx.taskText ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!normalizedQuery) {
      return null;
    }
    if (!availability.graphAvailable && !availability.vectorAvailable) {
      return null;
    }

    let graphWeight = StaticPlanner.GRAPH_SHARE;
    let vectorWeight = StaticPlanner.VECTOR_SHARE;
    if (!availability.graphAvailable) {
      graphWeight = 0;
      vectorWeight = 1;
    } else if (!availability.vectorAvailable) {
      graphWeight = 1;
      vectorWeight = 0;
    }

    const cap = (availability.totalBudget ?? { maxTokens: BUNDLE_MAX }).maxTokens;

    return {
      normalizedQuery,
      graphWeight,
      vectorWeight,
      graphBudget: { maxTokens: Math.round(cap * graphWeight * StaticPlanner.OVERFETCH) },
      vectorBudget: { maxTokens: Math.round(cap * vectorWeight * StaticPlanner.OVERFETCH) },
    };
  }
}
