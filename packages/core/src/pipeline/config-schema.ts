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
  type Pipeline,
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

const BuiltinRouterExecutorSchema = z.object({
  kind: z.literal("builtin/router"),
  fromStages: z.array(z.string().min(1)).min(1),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("session"), sessionId: z.string().min(1) }),
    z.object({ kind: z.literal("self") }),
  ]),
});

const BuiltinComposeExecutorSchema = z.object({
  kind: z.literal("builtin/compose"),
  fromStages: z.array(z.string().min(1)).min(1),
});

const StageExecutorSchema = z.discriminatedUnion("kind", [
  AgentExecutorSchema,
  CommandExecutorSchema,
  BuiltinRouterExecutorSchema,
  BuiltinComposeExecutorSchema,
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
  allowFork: z.boolean().optional(),
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

    // fromStages references must point to known stage names and must not
    // self-reference.  They must also be declared in dependsOn so the DAG
    // scheduler guarantees the referenced stages are terminal before the
    // builtin executor reads their artifacts.
    for (let i = 0; i < pipeline.stages.length; i++) {
      const stage = pipeline.stages[i];
      const { executor } = stage;
      if (executor.kind === "builtin/router" || executor.kind === "builtin/compose") {
        for (const ref of executor.fromStages) {
          if (!stageNames.has(ref)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["stages", i, "executor", "fromStages"],
              message: `Stage "${stage.name}" references unknown stage "${ref}" in fromStages.`,
            });
          }
          if (ref === stage.name) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["stages", i, "executor", "fromStages"],
              message: `Stage "${stage.name}" cannot reference itself in fromStages.`,
            });
          }
          if (stageNames.has(ref) && ref !== stage.name && !(stage.dependsOn ?? []).includes(ref)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["stages", i, "executor", "fromStages"],
              message: `Stage "${stage.name}" lists "${ref}" in fromStages but not in dependsOn — execution order is not guaranteed.`,
            });
          }
        }
      }
    }

    // allowFork is only meaningful for command stages.
    for (let i = 0; i < pipeline.stages.length; i++) {
      const stage = pipeline.stages[i];
      if (stage.allowFork !== undefined && stage.executor.kind !== "command") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", i, "allowFork"],
          message: `Stage "${stage.name}" sets allowFork but executor kind "${stage.executor.kind}" ignores it — allowFork is only meaningful for command stages.`,
        });
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
    const executor: StageExecutor = toRuntimeExecutor(stage.executor);

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
      ...(stage.allowFork !== undefined ? { allowFork: stage.allowFork } : {}),
    };
  });

  return {
    id: asPipelineId(key),
    name: configured.name ?? key,
    stages,
    ...(configured.maxConcurrentStages !== undefined
      ? { maxConcurrentStages: configured.maxConcurrentStages }
      : {}),
  };
}

function toRuntimeExecutor(executor: ConfiguredPipeline["stages"][number]["executor"]): StageExecutor {
  switch (executor.kind) {
    case "agent":
      return {
        kind: "agent",
        plugin: executor.plugin,
        mode: executor.mode as TaskMode,
        ...(executor.config !== undefined ? { config: executor.config } : {}),
      };
    case "command":
      return {
        kind: "command",
        command: executor.command,
        ...(executor.args !== undefined ? { args: executor.args } : {}),
        ...(executor.env !== undefined ? { env: executor.env } : {}),
        ...(executor.cwd !== undefined ? { cwd: executor.cwd } : {}),
      };
    case "builtin/router":
      return {
        kind: "builtin/router",
        fromStages: [...executor.fromStages],
        target:
          executor.target.kind === "session"
            ? { kind: "session", sessionId: executor.target.sessionId }
            : { kind: "self" },
      };
    case "builtin/compose":
      return {
        kind: "builtin/compose",
        fromStages: [...executor.fromStages],
      };
    default: {
      const exhaustive: never = executor;
      throw new Error(`Unhandled executor kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
