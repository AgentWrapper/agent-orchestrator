/**
 * Builtin router executor — `builtin/router` stages.
 *
 * Replaces the original spec's `SEND_TO_AGENT` reducer command. A router
 * stage:
 *   1. Reads findings emitted by each `fromStages` upstream sibling via
 *      `BuiltinTaskContext.readSiblingArtifacts`.
 *   2. Formats them into a single payload (one block per source stage).
 *   3. Delivers the payload to the target session via
 *      `BuiltinTaskContext.sendToSession`.
 *
 * The executor returns one `json` artifact recording what was delivered so
 * downstream stages (and the dashboard) can audit the routing decision.
 *
 * Targets:
 *   - `{ kind: "self" }` resolves to the session this run is scoped to.
 *   - `{ kind: "session", sessionId }` routes to a literal session id.
 *
 * Failure modes:
 *   - All `fromStages` resolved zero findings → still delivers an "empty"
 *     payload; the target may want to know "the upstream stage ran and found
 *     nothing".
 *   - `sendToSession` throws → returns `{ status: "failed" }` with the
 *     underlying error message.
 */

import type {
  Artifact,
  ArtifactInput,
  BuiltinTaskContext,
  RunId,
  Stage,
  StageRunId,
} from "../types.js";

export interface BuiltinRunInput {
  runId: RunId;
  stageRunId: StageRunId;
  stage: Stage;
  /** Loop counter, surfaced in delivered payloads for traceability. */
  loopRound?: number;
  ctx: BuiltinTaskContext;
}

export type BuiltinOutcome =
  | { status: "completed"; artifacts: ArtifactInput[] }
  | { status: "failed"; errorMessage: string };

export interface BuiltinExecutor {
  run(input: BuiltinRunInput): Promise<BuiltinOutcome>;
}

export function createBuiltinRouterExecutor(): BuiltinExecutor {
  return {
    async run(input) {
      const stage = input.stage;
      if (stage.executor.kind !== "builtin/router") {
        return {
          status: "failed",
          errorMessage: `builtin/router executor cannot run stage "${stage.name}" with executor.kind=${stage.executor.kind}`,
        };
      }

      const ctx = input.ctx;
      const executor = stage.executor;

      const targetSessionId =
        executor.target.kind === "self" ? ctx.sessionId : executor.target.sessionId;

      const bundles: Array<{ stage: string; count: number }> = [];
      const payloadSections: string[] = [];
      try {
        for (const upstream of executor.fromStages) {
          const artifacts = await ctx.readSiblingArtifacts(upstream);
          bundles.push({ stage: upstream, count: artifacts.length });
          payloadSections.push(formatStageSection(upstream, artifacts));
        }
      } catch (err) {
        return {
          status: "failed",
          errorMessage: `builtin/router failed to read sibling artifacts: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }

      const payload = formatRouterPayload({
        pipelineName: ctx.pipelineName,
        stageName: stage.name,
        loopRound: input.loopRound,
        sections: payloadSections,
      });

      try {
        await ctx.sendToSession(targetSessionId, payload);
      } catch (err) {
        return {
          status: "failed",
          errorMessage: `builtin/router failed to deliver to session "${targetSessionId}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }

      const auditArtifact: ArtifactInput = {
        kind: "json",
        data: {
          builtin: "router",
          targetSessionId,
          bundles,
        },
      };
      return { status: "completed", artifacts: [auditArtifact] };
    },
  };
}

function formatStageSection(
  stageName: string,
  artifacts: ReadonlyArray<Artifact>,
): string {
  const header = `## From stage: ${stageName} (${artifacts.length} artifact${
    artifacts.length === 1 ? "" : "s"
  })`;
  if (artifacts.length === 0) return `${header}\n_no findings_`;
  const body = artifacts.map((a) => "  - " + JSON.stringify(a)).join("\n");
  return `${header}\n${body}`;
}

interface RouterPayload {
  pipelineName: string;
  stageName: string;
  loopRound?: number;
  sections: string[];
}

function formatRouterPayload(p: RouterPayload): string {
  const lines = [
    `# Pipeline routing: ${p.pipelineName} → ${p.stageName}`,
    ...(p.loopRound !== undefined ? [`Loop round: ${p.loopRound}`] : []),
    "",
    ...p.sections,
  ];
  return lines.join("\n");
}
