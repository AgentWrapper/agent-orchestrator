/**
 * Shared types for the maestro-retrieval fusion layer (Ф1).
 *
 * A `RetrievalProvider` turns a task into a ranked list of `RetrievalItem`s.
 * Providers are FAIL-OPEN by contract: `query()` must never throw — a
 * missing binary, timeout, or parse error returns `[]` so the fusion layer
 * degrades gracefully instead of blocking a spawn.
 */

export interface TaskContext {
  /** AO project id ({name}_{hash}). */
  projectId: string;
  /** Absolute path to the project's repo root (project.path in config). */
  projectRoot: string;
  /** User prompt or issue title used as the query. */
  taskText: string | undefined;
  issueId?: string;
}

export interface TokenBudget {
  /** Max tokens this provider (or the final bundle) may spend. */
  maxTokens: number;
}

export interface RetrievalCitation {
  file: string;
  line: number | null;
}

export interface RetrievalItem {
  provider: "graph" | "vector";
  /** e.g. "symbol" | "subgraph" (graph) or "transcript" (vector). */
  kind: string;
  /** Repo-relative path, or null when the item has no file anchor. */
  file: string | null;
  line: number | null;
  score: number;
  /** Emission order within this provider's result set (0 = most relevant). */
  rank: number;
  text: string;
  /** ceil(text.length / 4) — rough token estimate, no tokenizer dependency. */
  tokens: number;
  citations: RetrievalCitation[];
  meta?: Record<string, unknown>;
}

export interface RetrievalProvider {
  name: "graph" | "vector";
  available(ctx: TaskContext): Promise<boolean>;
  /** Never throws — returns [] on any failure. */
  query(ctx: TaskContext, budget: TokenBudget): Promise<RetrievalItem[]>;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
