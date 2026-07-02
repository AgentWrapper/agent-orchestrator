/**
 * Vector retrieval provider — wraps `maestro-search query` (the same FTS
 * index rlm-seed.ts uses), generalized into a RetrievalProvider.
 *
 * `maestro-search query` has no `--project` flag, so hits are filtered to
 * the current project by `project_id` (mirrors rlm-seed.ts).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RetrievalItem, RetrievalProvider, TaskContext, TokenBudget } from "./types.js";
import { estimateTokens } from "./types.js";

const execFileAsync = promisify(execFile);

interface SearchHit {
  project_id: string | null;
  session_id: string | null;
  snippet: string;
  score?: number;
  role?: string;
}

/** Injectable for tests. Runs `maestro-search query ... --limit N` and returns raw stdout. */
export type MaestroSearchRunner = (
  bin: string,
  query: string,
  limit: number,
  timeoutMs: number,
) => Promise<string>;

export const defaultMaestroSearchRunner: MaestroSearchRunner = async (
  bin,
  query,
  limit,
  timeoutMs,
) => {
  const { stdout } = await execFileAsync(bin, ["query", query, "--limit", String(limit)], {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
};

// Opportunistic `file:line`-style citation extraction from a snippet, e.g.
// "session-manager.ts:1841" or "packages/core/src/rlm-seed.ts:42". Best
// effort only — a snippet with no citation just yields citations: [].
const CITATION_RE = /([\w./-]+\.[a-zA-Z]+):(\d+)/g;

function extractCitations(snippet: string): { file: string; line: number | null }[] {
  const citations: { file: string; line: number | null }[] = [];
  for (const match of snippet.matchAll(CITATION_RE)) {
    citations.push({ file: match[1]!, line: Number(match[2]) });
  }
  return citations;
}

function resolveBin(): string {
  return process.env["MAESTRO_SEARCH_BIN"] || "maestro-search";
}

export function createVectorProvider(opts?: { runner?: MaestroSearchRunner }): RetrievalProvider {
  const runner = opts?.runner ?? defaultMaestroSearchRunner;

  return {
    name: "vector",
    async available(): Promise<boolean> {
      try {
        // Bare invocation prints usage and exits non-zero (no --help
        // subcommand) — that's still proof the binary resolved. Only ENOENT
        // (binary not found) means "unavailable".
        await execFileAsync(resolveBin(), [], { timeout: 3000 });
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException)?.code !== "ENOENT";
      }
    },
    async query(ctx: TaskContext, budget: TokenBudget): Promise<RetrievalItem[]> {
      const taskText = (ctx.taskText ?? "").replace(/\s+/g, " ").trim();
      if (!taskText || budget.maxTokens <= 0) {
        return [];
      }

      // Over-fetch a small, fixed candidate count; the fusion/bundle layers
      // enforce the actual token budget, not this provider.
      const limit = 12;
      const query = taskText.slice(0, 200);

      try {
        const stdout = await runner(resolveBin(), query, limit, 4000);
        const parsed = JSON.parse(stdout) as { results?: SearchHit[] };
        const results = Array.isArray(parsed.results) ? parsed.results : [];
        const hits = results.filter(
          (r): r is SearchHit =>
            !!r &&
            r.project_id === ctx.projectId &&
            typeof r.snippet === "string" &&
            r.snippet.trim().length > 0,
        );

        return hits.map((hit, rank) => {
          const text = hit.snippet.replace(/\s+/g, " ").trim();
          return {
            provider: "vector" as const,
            kind: "transcript",
            file: null,
            line: null,
            score: hit.score ?? 1 / (rank + 1),
            rank,
            text,
            tokens: estimateTokens(text),
            citations: extractCitations(text),
            meta: hit.session_id ? { sessionId: hit.session_id, role: hit.role } : undefined,
          };
        });
      } catch {
        return [];
      }
    },
  };
}
