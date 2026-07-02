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
        return parseGraphifyOutput(stdout);
      } catch {
        return [];
      }
    },
  };
}
