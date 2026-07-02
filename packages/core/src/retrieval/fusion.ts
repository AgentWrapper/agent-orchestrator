/**
 * Fusion (Ф1 thin fuse + Ф2 cross-modal dedup): merge graph + vector results
 * into one ordered list. `rank` (emission order within each provider) is the
 * only cross-modal signal used for interleaving — smarter re-ranking is
 * still out of scope. Cross-modal dedup drops vector items whose citations
 * are already covered by packed graph items (a transcript snippet narrating
 * structure the graph section already states more cheaply); the converse
 * never happens — a graph item is never dropped in favor of a vector item.
 */

import type { RetrievalCitation, RetrievalItem } from "./types.js";

/** Same ±3 line window used for intra-graph dedup, applied to citation coverage. */
const LINE_WINDOW = 3;

/** A vector item is dropped when at least this share of its citations are graph-covered. */
const CROSS_MODAL_COVERAGE_THRESHOLD = 0.6;

function sumTokens(items: RetrievalItem[]): number {
  return items.reduce((sum, item) => sum + item.tokens, 0);
}

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

/**
 * Drops vector items whose citations are ≥60% covered by (file, line) keys
 * already held by `graphItems` (within the same ±3 line window as intra-modal
 * dedup). Never touches `graphItems` — the rule only ever removes vector
 * items. Citation-less vector items are always kept (nothing to compare).
 */
export function dedupeCrossModal(
  graphItems: RetrievalItem[],
  vectorItems: RetrievalItem[],
): { kept: RetrievalItem[]; dropped: RetrievalItem[] } {
  const graphKeys = graphItems
    .filter((item): item is RetrievalItem & { file: string; line: number } =>
      item.file !== null && item.line !== null,
    )
    .map((item) => ({ file: item.file, line: item.line }));

  if (graphKeys.length === 0) {
    return { kept: vectorItems, dropped: [] };
  }

  const isCovered = (citation: RetrievalCitation): boolean =>
    citation.line !== null &&
    graphKeys.some(
      (key) => key.file === citation.file && Math.abs(key.line - citation.line!) <= LINE_WINDOW,
    );

  const kept: RetrievalItem[] = [];
  const dropped: RetrievalItem[] = [];
  for (const item of vectorItems) {
    if (item.citations.length === 0) {
      kept.push(item);
      continue;
    }
    const coverage = item.citations.filter(isCovered).length / item.citations.length;
    if (coverage >= CROSS_MODAL_COVERAGE_THRESHOLD) {
      dropped.push(item);
    } else {
      kept.push(item);
    }
  }

  return { kept, dropped };
}

export interface FusionResult {
  items: RetrievalItem[];
  /** Tokens removed by dedup (intra-modal + cross-modal), per source provider. */
  dedupSavedTokens: { graph: number; vector: number };
}

export function fuseRetrievalItems(params: {
  graphItems: RetrievalItem[];
  vectorItems: RetrievalItem[];
  graphWeight: number;
  vectorWeight: number;
}): FusionResult {
  const graph = dedupeGraphItems(params.graphItems);
  const vectorIntraDeduped = dedupeVectorItems(params.vectorItems);
  const { kept: vector, dropped: crossDropped } = dedupeCrossModal(graph, vectorIntraDeduped);

  const graphSavedTokens = sumTokens(params.graphItems) - sumTokens(graph);
  const vectorSavedTokens =
    sumTokens(params.vectorItems) - sumTokens(vectorIntraDeduped) + sumTokens(crossDropped);

  return {
    items: interleaveWeighted(graph, params.graphWeight, vector, params.vectorWeight),
    dedupSavedTokens: { graph: graphSavedTokens, vector: vectorSavedTokens },
  };
}
