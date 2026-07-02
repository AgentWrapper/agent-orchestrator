/**
 * Fusion (Ф1 — thin fuse): merge graph + vector results into one ordered
 * list. No cross-modal dedup and no re-ranking — `rank` (emission order
 * within each provider) is the only cross-modal signal available at this
 * stage. Smarter re-ranking/measurement is Ф2.
 */

import type { RetrievalItem } from "./types.js";

/** Dedup graph items sharing a (file, line) within ±3 lines — keeps the first (best-ranked). */
export function dedupeGraphItems(items: RetrievalItem[]): RetrievalItem[] {
  const seen: { file: string; line: number }[] = [];
  const out: RetrievalItem[] = [];
  for (const item of items) {
    if (item.file && item.line !== null) {
      const isDup = seen.some((s) => s.file === item.file && Math.abs(s.line - item.line!) <= 3);
      if (isDup) continue;
      seen.push({ file: item.file, line: item.line });
    }
    out.push(item);
  }
  return out;
}

/** Dedup vector items sharing a (session, turn-text) pair — keeps the first (best-ranked). */
export function dedupeVectorItems(items: RetrievalItem[]): RetrievalItem[] {
  const seen = new Set<string>();
  const out: RetrievalItem[] = [];
  for (const item of items) {
    const sessionId = (item.meta?.["sessionId"] as string | undefined) ?? "";
    const key = `${sessionId}:${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Interleaves two already-ranked lists by weight using a credit-based
 * weighted round robin (higher weight = emitted more often, but both lists
 * still drain in their own rank order).
 */
export function interleaveWeighted(
  graphItems: RetrievalItem[],
  graphWeight: number,
  vectorItems: RetrievalItem[],
  vectorWeight: number,
): RetrievalItem[] {
  const result: RetrievalItem[] = [];
  let gi = 0;
  let vi = 0;
  let creditGraph = 0;
  let creditVector = 0;

  while (gi < graphItems.length || vi < vectorItems.length) {
    creditGraph += graphWeight;
    creditVector += vectorWeight;

    if (creditGraph >= creditVector && gi < graphItems.length) {
      result.push(graphItems[gi++]!);
      creditGraph -= 1;
    } else if (vi < vectorItems.length) {
      result.push(vectorItems[vi++]!);
      creditVector -= 1;
    } else if (gi < graphItems.length) {
      result.push(graphItems[gi++]!);
      creditGraph -= 1;
    }
  }

  return result;
}

export function fuseRetrievalItems(params: {
  graphItems: RetrievalItem[];
  vectorItems: RetrievalItem[];
  graphWeight: number;
  vectorWeight: number;
}): RetrievalItem[] {
  const graph = dedupeGraphItems(params.graphItems);
  const vector = dedupeVectorItems(params.vectorItems);
  return interleaveWeighted(graph, params.graphWeight, vector, params.vectorWeight);
}
