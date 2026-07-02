/**
 * Greedy packer: turns a fused, ranked item list into one markdown reference
 * block plus a JSON accounting sidecar (never sent to the model).
 *
 * Packing is skip-don't-truncate: items are taken in rank order and an item
 * that doesn't fit is skipped (not sliced mid-text), so every included item
 * stays a coherent, citable unit.
 *
 * The returned markdown is a bare reference block — combine it with the
 * task prompt via rlm-seed.ts::withRlmContext at the call site, same as the
 * legacy seedRlmContext path, so both paths share one "## Текущее задание"
 * guard implementation.
 */

import type { RetrievalItem, TokenBudget } from "./types.js";

export interface BundleAccounting {
  itemsPacked: number;
  itemsSkipped: number;
  graphItemsPacked: number;
  vectorItemsPacked: number;
  graphTokensPacked: number;
  vectorTokensPacked: number;
  tokensPacked: number;
  tokensSkipped: number;
}

export interface PackedBundle {
  markdown: string;
  json: BundleAccounting;
}

const BUNDLE_HEADING = "## Контекст задачи (maestro-retrieval)";
const GRAPH_SUBHEADING = "### Структура кода (graphify)";
const VECTOR_SUBHEADING = "### Память проекта (rlm)";

function formatGraphLine(item: RetrievalItem): string {
  return `- ${item.text}`;
}

function formatVectorLine(item: RetrievalItem): string {
  const sessionId = item.meta?.["sessionId"] as string | undefined;
  const prefix = sessionId ? `[${sessionId}] ` : "";
  return `- ${prefix}${item.text}`;
}

export function packBundle(items: RetrievalItem[], cap: TokenBudget): PackedBundle | null {
  let tokensPacked = 0;
  let tokensSkipped = 0;
  let itemsSkipped = 0;
  const packed: RetrievalItem[] = [];

  for (const item of items) {
    if (tokensPacked + item.tokens <= cap.maxTokens) {
      packed.push(item);
      tokensPacked += item.tokens;
    } else {
      itemsSkipped++;
      tokensSkipped += item.tokens;
    }
  }

  if (packed.length === 0) {
    return null;
  }

  const graphItems = packed.filter((item) => item.provider === "graph");
  const vectorItems = packed.filter((item) => item.provider === "vector");

  const lines: string[] = [BUNDLE_HEADING];
  if (graphItems.length > 0) {
    lines.push("", GRAPH_SUBHEADING, ...graphItems.map(formatGraphLine));
  }
  if (vectorItems.length > 0) {
    lines.push("", VECTOR_SUBHEADING, ...vectorItems.map(formatVectorLine));
  }

  return {
    markdown: lines.join("\n"),
    json: {
      itemsPacked: packed.length,
      itemsSkipped,
      graphItemsPacked: graphItems.length,
      vectorItemsPacked: vectorItems.length,
      graphTokensPacked: graphItems.reduce((sum, item) => sum + item.tokens, 0),
      vectorTokensPacked: vectorItems.reduce((sum, item) => sum + item.tokens, 0),
      tokensPacked,
      tokensSkipped,
    },
  };
}
