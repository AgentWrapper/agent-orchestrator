/**
 * maestro-retrieval — fusion context assembly (Ф1: thin fuse).
 *
 * assembleContextBundle() is the single entry point session-manager.ts
 * calls behind the `retrieval.fusion` flag. FAIL-OPEN by contract: never
 * throws, never blocks a spawn beyond a fixed combined deadline. Returns
 * null when there is nothing to seed (no task text, no provider available,
 * or the deadline is hit before any results land).
 */

import type { RetrievalItem, RetrievalProvider, TaskContext, TokenBudget } from "./types.js";
import { createGraphProvider } from "./graph-provider.js";
import { createVectorProvider } from "./vector-provider.js";
import { ensureGraphBuilt } from "./graph-store.js";
import { fuseRetrievalItems } from "./fusion.js";
import { BUNDLE_MAX, StaticPlanner } from "./planner.js";
import { packBundle, type BundleAccounting } from "./bundle.js";

export type { TaskContext, TokenBudget, RetrievalItem, RetrievalProvider } from "./types.js";
export { BUNDLE_MAX } from "./planner.js";

export interface ContextBundle {
  markdown: string;
  json: BundleAccounting & { dedupSaved: number };
}

/** Combined deadline for both provider queries together (not per-provider). */
const COMBINED_DEADLINE_MS = 5000;

function withDeadline<T>(promise: Promise<T>, fallback: T, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(fallback), ms);
      timer.unref?.();
    }),
  ]);
}

export interface AssembleContextBundleOpts {
  /** Injectable for tests; defaults to createGraphProvider(). */
  graphProvider?: RetrievalProvider;
  /** Injectable for tests; defaults to createVectorProvider(). */
  vectorProvider?: RetrievalProvider;
  /** Injectable for tests; defaults to ensureGraphBuilt. Set to a no-op to skip the background build. */
  ensureGraphBuiltFn?: typeof ensureGraphBuilt;
}

export async function assembleContextBundle(
  ctx: TaskContext,
  opts?: AssembleContextBundleOpts,
): Promise<ContextBundle | null> {
  try {
    if (!(ctx.taskText ?? "").trim()) {
      return null;
    }

    const graphProvider = opts?.graphProvider ?? createGraphProvider();
    const vectorProvider = opts?.vectorProvider ?? createVectorProvider();
    const ensureGraphBuiltFn = opts?.ensureGraphBuiltFn ?? ensureGraphBuilt;

    // Fire-and-forget: keep the on-disk graph reasonably fresh for *future*
    // spawns without blocking this one — a build/re-extract can take up to
    // ~60s, far past this call's 5s combined deadline.
    void ensureGraphBuiltFn({ projectId: ctx.projectId, projectRoot: ctx.projectRoot }).catch(
      () => {},
    );

    const [graphAvailable, vectorAvailable] = await Promise.all([
      graphProvider.available(ctx).catch(() => false),
      vectorProvider.available(ctx).catch(() => false),
    ]);

    const shares = new StaticPlanner().plan(ctx, {
      graphAvailable,
      vectorAvailable,
      totalBudget: { maxTokens: BUNDLE_MAX },
    });
    if (!shares) {
      return null;
    }

    const results = await withDeadline(
      Promise.allSettled([
        shares.graphWeight > 0
          ? graphProvider.query(ctx, shares.graphBudget)
          : Promise.resolve<RetrievalItem[]>([]),
        shares.vectorWeight > 0
          ? vectorProvider.query(ctx, shares.vectorBudget)
          : Promise.resolve<RetrievalItem[]>([]),
      ]),
      [
        { status: "fulfilled", value: [] },
        { status: "fulfilled", value: [] },
      ] as PromiseSettledResult<RetrievalItem[]>[],
      COMBINED_DEADLINE_MS,
    );

    const [graphResult, vectorResult] = results;
    const graphItems = graphResult?.status === "fulfilled" ? graphResult.value : [];
    const vectorItems = vectorResult?.status === "fulfilled" ? vectorResult.value : [];

    const fused = fuseRetrievalItems({
      graphItems,
      vectorItems,
      graphWeight: shares.graphWeight,
      vectorWeight: shares.vectorWeight,
    });
    // interleaveWeighted never drops items — every raw candidate that
    // survived intra-modal dedup is present in `fused`, so the raw/fused
    // delta is exactly what dedup removed.
    const dedupSaved = graphItems.length + vectorItems.length - fused.length;

    const bundle = packBundle(fused, { maxTokens: BUNDLE_MAX });
    if (!bundle) {
      return null;
    }
    return { markdown: bundle.markdown, json: { ...bundle.json, dedupSaved } };
  } catch {
    // Belt-and-suspenders: every sub-call above already fails open, but the
    // spawn must never break on a fusion-layer regression.
    return null;
  }
}
