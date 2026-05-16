/**
 * Builtin compose executor — `builtin/compose` stages.
 *
 * Bundles findings from multiple upstream sibling stages into a single
 * composite artifact for a downstream stage to consume. The composite is
 * emitted as a `json` artifact whose `data.findings` is the merged list,
 * tagged with the originating stage name.
 *
 * Use case: a `route` stage downstream wants to deliver "everything the
 * pipeline found this round" to one session. Composing avoids the
 * O(stages) explosion of separate router calls and makes the round-trip
 * auditable (the composite artifact is persisted in the pipeline store).
 *
 * Failure modes:
 *   - Wrong executor kind → returns failed.
 *   - `readSiblingArtifacts` throws → returns failed.
 *   - Zero upstream artifacts → still emits a composite artifact with
 *     `bundles[].count: 0` so downstream stages know the upstream ran.
 */

import type { ArtifactInput } from "../types.js";
import type { BuiltinExecutor, BuiltinOutcome } from "./builtin-router.js";

export function createBuiltinComposeExecutor(): BuiltinExecutor {
  return {
    async run(input): Promise<BuiltinOutcome> {
      const stage = input.stage;
      if (stage.executor.kind !== "builtin/compose") {
        return {
          status: "failed",
          errorMessage: `builtin/compose executor cannot run stage "${stage.name}" with executor.kind=${stage.executor.kind}`,
        };
      }

      const executor = stage.executor;
      const ctx = input.ctx;

      const bundles: Array<{ stage: string; artifacts: unknown[] }> = [];
      try {
        for (const upstream of executor.fromStages) {
          const artifacts = await ctx.readSiblingArtifacts(upstream);
          bundles.push({ stage: upstream, artifacts });
        }
      } catch (err) {
        return {
          status: "failed",
          errorMessage: `builtin/compose failed to read sibling artifacts: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }

      const composite: ArtifactInput = {
        kind: "json",
        data: {
          builtin: "compose",
          pipelineName: ctx.pipelineName,
          sourceStages: [...executor.fromStages],
          ...(input.loopRound !== undefined ? { loopRound: input.loopRound } : {}),
          bundles: bundles.map((b) => ({
            stage: b.stage,
            count: b.artifacts.length,
            artifacts: b.artifacts,
          })),
        },
      };

      return { status: "completed", artifacts: [composite] };
    },
  };
}
