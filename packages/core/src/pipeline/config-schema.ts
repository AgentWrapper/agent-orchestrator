/**
 * Zod schema for `pipelines:` blocks in agent-orchestrator.yaml.
 *
 * Mirrors the runtime Pipeline / Stage types in pipeline/types.ts so that
 * `loadConfig()` can surface configured pipelines to the CLI (`ao pipeline list`,
 * `ao pipeline run`).
 *
 * The PipelineId is derived from the map key used in YAML rather than being
 * spelled in each entry — it's branded at the boundary in
 * `configuredPipelineToRuntime`.
 */

import { z } from "zod";

import { findFirstStageCycle } from "./dag.js";
import {
  asPipelineId,
  type ConcurrencyPolicy,
  type Pipeline,
  type PipelineTrigger,
  type Stage,
  type StageExecutor,
  type StageRoutePredicate,
  type StageRoutes,
  type TaskMode,
} from "./types.js";

const TaskModeSchema = z.enum(["review", "code", "answer"]);

const StageTriggerSchema = z.object({
  on: z.array(z.enum(["pr.opened", "pr.updated", "pr.merge_ready", "pr.merged", "manual"])),
});

const AgentExecutorSchema = z.object({
  kind: z.literal("agent"),
  plugin: z.string(),
  mode: TaskModeSchema,
  config: z.record(z.unknown()).optional(),
});

const CommandExecutorSchema = z.object({
  kind: z.literal("command"),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
});

const StageExecutorSchema = z.discriminatedUnion("kind", [
  AgentExecutorSchema,
  CommandExecutorSchema,
]);

const TaskSpecSchema = z.object({
  prompt: z.string().optional(),
  outputSchema: z.record(z.unknown()).optional(),
  inputs: z.record(z.unknown()).optional(),
});

const StagePolicySchema = z.object({
  blocksMerge: z.boolean().optional(),
  stallWindow: z.number().int().nonnegative().optional(),
});

const StageBudgetSchema = z.object({
  maxUsd: z.number().nonnegative().optional(),
  maxDurationMs: z.number().int().nonnegative().optional(),
});

const StageRoutePredicateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("allSucceeded"), stages: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("anySucceeded"), stages: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("anyFailed"), stages: z.array(z.string().min(1)).min(1) }),
]);

const StageRoutesSchema = z.object({
  when: StageRoutePredicateSchema,
});

const PipelineTriggerEventSchema = z.enum([
  "pr_opened",
  "pr_push",
  "pr_review_requested",
  "manual",
]);

const PipelineTriggerSchema = z.object({
  on: PipelineTriggerEventSchema,
  branches: z.array(z.string().min(1)).optional(),
  files: z.array(z.string().min(1)).optional(),
  labels: z.array(z.string().min(1)).optional(),
  excludeDrafts: z.boolean().optional(),
});

const ConcurrencyPolicySchema = z.enum(["cancel_in_progress", "skip", "queue"]);

const StageSchema = z.object({
  name: z.string().min(1),
  trigger: StageTriggerSchema,
  executor: StageExecutorSchema,
  task: TaskSpecSchema.default({}),
  policy: StagePolicySchema.optional(),
  budget: StageBudgetSchema.optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  retries: z.number().int().nonnegative().optional(),
  maxLoopRounds: z.number().int().positive().optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
  routes: StageRoutesSchema.optional(),
});

/**
 * Pipeline config without its branded id — id is derived from the YAML map key.
 * `name` defaults to that same key when omitted.
 *
 * Cross-stage validations (unknown `dependsOn`/`routes` references, self-refs,
 * and cycles in the combined `dependsOn`+`routes` graph) run via `superRefine`
 * so they surface alongside the normal Zod errors at config load — operators
 * see one consolidated failure instead of a runtime deadlock later.
 *
 * Cycle detection treats both `dependsOn` and `routes.when.stages` as graph
 * edges because the runtime scheduler waits for both before evaluating a
 * stage (`arePreconditionsTerminal` in dag.ts). A routes-only cycle would
 * otherwise leave every stage in the cycle stuck `pending` forever.
 */
export const ConfiguredPipelineSchema = z
  .object({
    name: z.string().min(1).optional(),
    stages: z.array(StageSchema).min(1),
    maxConcurrentStages: z.number().int().positive().optional(),
    triggers: z.array(PipelineTriggerSchema).optional(),
    concurrency: ConcurrencyPolicySchema.optional(),
  })
  .superRefine((pipeline, ctx) => {
    const stageNames = new Set(pipeline.stages.map((s) => s.name));

    // Duplicate stage names break dependency resolution and the reducer's
    // per-stage state map; reject early with a precise pointer.
    const seen = new Set<string>();
    for (let i = 0; i < pipeline.stages.length; i++) {
      const name = pipeline.stages[i].name;
      if (seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", i, "name"],
          message: `Duplicate stage name "${name}" — every stage in a pipeline must have a unique name.`,
        });
      }
      seen.add(name);
    }

    // dependsOn / routes references must point to known stage names.
    for (let i = 0; i < pipeline.stages.length; i++) {
      const stage = pipeline.stages[i];
      for (const dep of stage.dependsOn ?? []) {
        if (!stageNames.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", i, "dependsOn"],
            message: `Stage "${stage.name}" depends on unknown stage "${dep}".`,
          });
        }
        if (dep === stage.name) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", i, "dependsOn"],
            message: `Stage "${stage.name}" cannot depend on itself.`,
          });
        }
      }
      const routes = stage.routes;
      if (routes) {
        for (const ref of routes.when.stages) {
          if (!stageNames.has(ref)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["stages", i, "routes", "when", "stages"],
              message: `Stage "${stage.name}" routes references unknown stage "${ref}".`,
            });
          }
          if (ref === stage.name) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["stages", i, "routes", "when", "stages"],
              message: `Stage "${stage.name}" cannot route to itself.`,
            });
          }
        }
      }
    }

    // Cycle detection over the combined dependsOn + routes-refs graph.
    // Iterative DFS; returns the first cycle found in declaration order so
    // the error reads naturally (e.g. "a → b → c → a"). Trivial self-loops
    // (`[X, X]`) are excluded — the explicit self-ref checks above already
    // report those with clearer messages.
    const cycle = findFirstStageCycle(pipeline.stages);
    if (cycle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages"],
        message: `Pipeline has a stage dependency cycle: ${cycle.join(" → ")}.`,
      });
    }
  });

export type ConfiguredPipeline = z.infer<typeof ConfiguredPipelineSchema>;

export const PipelinesConfigSchema = z.record(z.string().min(1), ConfiguredPipelineSchema);

export type PipelinesConfig = z.infer<typeof PipelinesConfigSchema>;

/** Convert a parsed YAML pipeline entry into a runtime Pipeline (branded id). */
export function configuredPipelineToRuntime(key: string, configured: ConfiguredPipeline): Pipeline {
  const stages = configured.stages.map((stage): Stage => {
    const executor: StageExecutor =
      stage.executor.kind === "agent"
        ? {
            kind: "agent",
            plugin: stage.executor.plugin,
            mode: stage.executor.mode as TaskMode,
            ...(stage.executor.config !== undefined ? { config: stage.executor.config } : {}),
          }
        : {
            kind: "command",
            command: stage.executor.command,
            ...(stage.executor.args !== undefined ? { args: stage.executor.args } : {}),
            ...(stage.executor.env !== undefined ? { env: stage.executor.env } : {}),
            ...(stage.executor.cwd !== undefined ? { cwd: stage.executor.cwd } : {}),
          };

    const routes: StageRoutes | undefined = stage.routes
      ? {
          when: {
            kind: stage.routes.when.kind,
            stages: [...stage.routes.when.stages],
          } as StageRoutePredicate,
        }
      : undefined;

    return {
      name: stage.name,
      trigger: { on: [...stage.trigger.on] },
      executor,
      task: { ...stage.task },
      ...(stage.policy ? { policy: { ...stage.policy } } : {}),
      ...(stage.budget ? { budget: { ...stage.budget } } : {}),
      ...(stage.timeoutMs !== undefined ? { timeoutMs: stage.timeoutMs } : {}),
      ...(stage.retries !== undefined ? { retries: stage.retries } : {}),
      ...(stage.maxLoopRounds !== undefined ? { maxLoopRounds: stage.maxLoopRounds } : {}),
      ...(stage.dependsOn !== undefined ? { dependsOn: [...stage.dependsOn] } : {}),
      ...(routes ? { routes } : {}),
    };
  });

  const triggers: PipelineTrigger[] | undefined = configured.triggers
    ? configured.triggers.map((t) => ({
        on: t.on,
        ...(t.branches !== undefined ? { branches: [...t.branches] } : {}),
        ...(t.files !== undefined ? { files: [...t.files] } : {}),
        ...(t.labels !== undefined ? { labels: [...t.labels] } : {}),
        ...(t.excludeDrafts !== undefined ? { excludeDrafts: t.excludeDrafts } : {}),
      }))
    : undefined;

  return {
    id: asPipelineId(key),
    name: configured.name ?? key,
    stages,
    ...(configured.maxConcurrentStages !== undefined
      ? { maxConcurrentStages: configured.maxConcurrentStages }
      : {}),
    ...(triggers !== undefined ? { triggers } : {}),
    ...(configured.concurrency !== undefined
      ? { concurrency: configured.concurrency as ConcurrencyPolicy }
      : {}),
  };
}
