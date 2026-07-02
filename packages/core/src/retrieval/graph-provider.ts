/**
 * Graph retrieval provider — wraps `graphify query` over the project's
 * graphify-out/graph.json (see graph-store.ts for how that graph is built).
 *
 * Output format (verified against graphifyy 0.5.0):
 *   NODE <label> [src=<repo-relative-file> loc=L<line> community=<n>]
 *   EDGE <a> --<rel> [<CONF>]--> <b>
 * `graphify query` honors `--budget <tokens>` and truncates output itself;
 * non-matching queries print "No matching nodes found." with exit 0.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import type { RetrievalItem, RetrievalProvider, TaskContext, TokenBudget } from "./types.js";
import { estimateTokens } from "./types.js";
import { getGraphJsonPath, resolveGraphifyBin } from "./graph-store.js";

const execFileAsync = promisify(execFile);

const NODE_RE = /^NODE\s+(.+?)\s+\[src=(\S+)\s+loc=L(\d+)\s+community=(\d+)\]\s*$/;
const EDGE_RE = /^EDGE\s+(.+?)\s+--(\S+)\s+\[(\S+)\]-->\s+(.+?)\s*$/;

// Relevance floor (mae-379): `graphify query --budget N` has no built-in
// score/threshold flag (verified via `graphify query --help`) — it always
// fills the budget with its best-N BFS-reachable nodes, even when NONE of
// them actually relate to the query (ops/build/notarize tasks graphify
// doesn't index as code). Without a floor those "filler" nodes get packed
// into every spawn's context as noise. The floor below drops nodes with zero
// term-overlap with the query, keeping only real hits plus their direct
// (1-hop) graph neighbors — mirrors seedRlmContext's graceful degrade to
// vector-only when nothing actually matches.
const MIN_TERM_LEN = 3;
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "from",
  "with",
  "that",
  "this",
  "into",
  "when",
  "then",
  "than",
  "have",
  "has",
  "are",
  "was",
  "were",
  "not",
  "but",
  "our",
  "your",
  "you",
  "and",
  "add",
  "fix",
  "bug",
  "issue",
  "task",
  "make",
  "sure",
  "use",
  "using",
]);

function normalizeTerms(text: string): Set<string> {
  const words = text.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
  return new Set(words.filter((w) => w.length >= MIN_TERM_LEN && !STOPWORDS.has(w)));
}

// Symbol labels/paths are identifiers, not prose — "ReasoningEffortOption"
// has no word-boundary punctuation around "effort", so word-level Set
// equality misses it. Match by substring containment against a punctuation-
// stripped haystack instead, which catches terms glued inside camelCase/
// PascalCase/snake_case identifiers.
function toHaystack(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/gi, "");
}

function hasOverlap(itemText: string, queryTerms: Set<string>): boolean {
  const haystack = toHaystack(itemText);
  for (const t of queryTerms) {
    if (haystack.includes(t)) return true;
  }
  return false;
}

/**
 * Drops NODE/EDGE items with no term-overlap with the query, keeping only
 * direct hits (label or src file shares a query term) plus nodes/edges
 * reachable in one hop from a hit. Returns [] when there is no hit at all —
 * the correct graceful outcome is degrading to vector-only, not padding the
 * bundle with unrelated "best effort" nodes.
 */
export function applyRelevanceFloor(items: RetrievalItem[], queryText: string): RetrievalItem[] {
  const queryTerms = normalizeTerms(queryText);
  if (queryTerms.size === 0) {
    return items;
  }

  const nodes = items.filter((i) => i.kind === "symbol");
  const edges = items.filter((i) => i.kind === "subgraph");

  const labelOf = (item: RetrievalItem): string => String(item.meta?.["label"] ?? "");

  const hitLabels = new Set<string>();
  for (const node of nodes) {
    if (hasOverlap(`${labelOf(node)} ${node.file ?? ""}`, queryTerms)) {
      hitLabels.add(labelOf(node));
    }
  }

  if (hitLabels.size === 0) {
    return [];
  }

  // Expand one hop: any edge touching a hit pulls in its other endpoint.
  const keptLabels = new Set(hitLabels);
  const keptEdges: RetrievalItem[] = [];
  for (const edge of edges) {
    const from = String(edge.meta?.["from"] ?? "");
    const to = String(edge.meta?.["to"] ?? "");
    if (hitLabels.has(from) || hitLabels.has(to)) {
      keptEdges.push(edge);
      keptLabels.add(from);
      keptLabels.add(to);
    }
  }

  const keptNodes = nodes.filter((n) => keptLabels.has(labelOf(n)));
  return [...keptNodes, ...keptEdges];
}

/** Injectable for tests. Runs `graphify query` and returns raw stdout. */
export type GraphifyQueryRunner = (
  bin: string,
  query: string,
  budget: number,
  graphJsonPath: string,
  timeoutMs: number,
) => Promise<string>;

export const defaultGraphifyQueryRunner: GraphifyQueryRunner = async (
  bin,
  query,
  budget,
  graphJsonPath,
  timeoutMs,
) => {
  const { stdout } = await execFileAsync(
    bin,
    ["query", query, "--budget", String(budget), "--graph", graphJsonPath],
    { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
};

/** Injectable for tests. Cheap probe that the graphify binary is on PATH/resolvable. */
export type GraphifyBinResolver = (bin: string) => Promise<boolean>;

export const defaultGraphifyBinResolver: GraphifyBinResolver = async (bin) => {
  try {
    // Bare invocation prints usage (exit 0 on graphifyy 0.5.0). Only ENOENT
    // (binary not found) means "unavailable" — a non-zero exit still proves
    // the binary resolved.
    await execFileAsync(bin, [], { timeout: 3000 });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
};

function parseGraphifyOutput(stdout: string): RetrievalItem[] {
  const items: RetrievalItem[] = [];
  const lines = stdout.split("\n");
  let rank = 0;

  for (const line of lines) {
    const nodeMatch = NODE_RE.exec(line);
    if (nodeMatch) {
      const [, label, srcFile, lineStr, communityStr] = nodeMatch;
      const text = line.trim();
      items.push({
        provider: "graph",
        kind: "symbol",
        file: srcFile ?? null,
        line: lineStr ? Number(lineStr) : null,
        score: 1 / (rank + 1),
        rank: rank++,
        text,
        tokens: estimateTokens(text),
        citations: srcFile ? [{ file: srcFile, line: lineStr ? Number(lineStr) : null }] : [],
        meta: { label, community: communityStr ? Number(communityStr) : undefined },
      });
      continue;
    }

    const edgeMatch = EDGE_RE.exec(line);
    if (edgeMatch) {
      const [, from, rel, confidence, to] = edgeMatch;
      const text = line.trim();
      items.push({
        provider: "graph",
        kind: "subgraph",
        file: null,
        line: null,
        score: 1 / (rank + 1),
        rank: rank++,
        text,
        tokens: estimateTokens(text),
        citations: [],
        meta: { from, rel, to, confidence },
      });
    }
  }

  return items;
}

export function createGraphProvider(opts?: {
  queryRunner?: GraphifyQueryRunner;
  binResolver?: GraphifyBinResolver;
}): RetrievalProvider {
  const queryRunner = opts?.queryRunner ?? defaultGraphifyQueryRunner;
  const binResolver = opts?.binResolver ?? defaultGraphifyBinResolver;

  return {
    name: "graph",
    async available(ctx: TaskContext): Promise<boolean> {
      try {
        const graphJsonPath = getGraphJsonPath(ctx.projectId);
        if (!existsSync(graphJsonPath)) {
          return false;
        }
        return await binResolver(resolveGraphifyBin());
      } catch {
        return false;
      }
    },
    async query(ctx: TaskContext, budget: TokenBudget): Promise<RetrievalItem[]> {
      const taskText = (ctx.taskText ?? "").trim();
      if (!taskText || budget.maxTokens <= 0) {
        return [];
      }
      try {
        const bin = resolveGraphifyBin();
        const graphJsonPath = getGraphJsonPath(ctx.projectId);
        const stdout = await queryRunner(bin, taskText, budget.maxTokens, graphJsonPath, 4000);
        return applyRelevanceFloor(parseGraphifyOutput(stdout), taskText);
      } catch {
        return [];
      }
    },
  };
}
