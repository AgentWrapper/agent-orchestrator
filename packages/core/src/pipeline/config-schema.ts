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
  collectReferencedStages,
  MAX_PREDICATE_DEPTH,
  PredicateSchema,
  predicateDepth,
  validateRoutePredicateScope,
} from "./predicate.js";
import {
  asPipelineId,
  type Pipeline,
  type Predicate,
  type Stage,
  type StageExecutor,
  type StageRoutePredicate,
  type StageRoutes,
  type TaskMode,
  type WorkspaceClass,
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

/**
 * v1.1's hardcoded route predicates. Kept alongside the v1.3 typed DSL so
 * existing pipeline configs continue to parse without rewrites — the union
 * below accepts either shape.
 */
const StageRoutePredicateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("allSucceeded"), stages: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("anySucceeded"), stages: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("anyFailed"), stages: z.array(z.string().min(1)).min(1) }),
]);

const StageRoutesSchema = z.object({
  when: z.union([StageRoutePredicateSchema, PredicateSchema]),
});

const WorkspaceClassSchema = z.enum(["independent", "read-siblings"]);

const LEGACY_ROUTE_KINDS = new Set<string>(["allSucceeded", "anySucceeded", "anyFailed"]);

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
  workspaceClass: WorkspaceClassSchema.optional(),
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
    /**
     * v1.3 — pipeline-level run-completion conditions (AND-combined).
     * Empty / unset preserves v1.1 behavior (every terminal run is "done").
     */
    exitPredicates: z.array(PredicateSchema).optional(),
    /** v1.3 — pipeline-level loop cap. See `Pipeline.maxLoopRounds`. */
    maxLoopRounds: z.number().int().positive().optional(),
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
    // WorkspaceGuard: `read-siblings` requires at least one upstream stage
    // (dependsOn, route reference, or a prior-declared stage). Reject orphans
    // at config load so runtime never has to handle a "no siblings to read"
    // case.
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
        // Cast: superRefine receives the parsed-but-not-narrowed input.
        // `collectReferencedStages` accepts either shape.
        const refs = collectReferencedStages(routes.when as StageRoutePredicate | Predicate);
        for (const ref of refs) {
          if (!stageNames.has(ref)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["stages", i, "routes", "when"],
              message: `Stage "${stage.name}" routes references unknown stage "${ref}".`,
            });
          }
          if (ref === stage.name) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["stages", i, "routes", "when"],
              message: `Stage "${stage.name}" cannot route to itself.`,
            });
          }
        }
        // Bound predicate nesting so malformed configs can't OOM the evaluator.
        for (const wh of [routes.when as StageRoutePredicate | Predicate]) {
          // Legacy shapes are flat (depth 0); only DSL predicates need depth
          // checks. Detect by `kind` to avoid `predicateDepth` blowing up on
          // legacy shapes it doesn't know about.
          if (!LEGACY_ROUTE_KINDS.has(wh.kind)) {
            const depth = predicateDepth(wh as Predicate);
            if (depth > MAX_PREDICATE_DEPTH) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["stages", i, "routes", "when"],
                message: `Stage "${stage.name}" route predicate is nested ${depth} levels deep; the maximum is ${MAX_PREDICATE_DEPTH}.`,
              });
            }
          }
        }
        // Routes-only constraint: every DSL leaf must declare an explicit
        // `stages` scope. An unset-scope leaf would evaluate over "all
        // stages" at trigger time, find the host stage still `pending`, and
        // immediately cascade-skip it. Legacy shapes already require
        // `stages` at the schema level.
        for (const problem of validateRoutePredicateScope(
          routes.when as StageRoutePredicate | Predicate,
        )) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", i, "routes", "when"],
            message: `Stage "${stage.name}" routes.when: ${problem}.`,
          });
        }
      }

      if (stage.workspaceClass === "read-siblings") {
        // Engine's `collectSiblingArtifacts` (engine.ts) walks `dependsOn`
        // transitively and nothing else — route refs and positional
        // neighbors don't seed the BFS. Reject any read-siblings stage that
        // wouldn't actually receive artifacts at runtime, so the prompt
        // block isn't silently omitted.
        if ((stage.dependsOn?.length ?? 0) === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", i, "workspaceClass"],
            message: `Stage "${stage.name}" declares workspaceClass="read-siblings" but has no dependsOn; artifact collection follows only the dependsOn graph at runtime, so sibling artifacts would be empty. Add a dependsOn entry for each upstream stage whose artifacts this stage should read.`,
          });
        }
      }
    }

    // Validate pipeline-level exitPredicates references and depth.
    for (let p = 0; p < (pipeline.exitPredicates?.length ?? 0); p++) {
      const pred = pipeline.exitPredicates![p];
      const depth = predicateDepth(pred);
      if (depth > MAX_PREDICATE_DEPTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["exitPredicates", p],
          message: `exitPredicates[${p}] is nested ${depth} levels deep; the maximum is ${MAX_PREDICATE_DEPTH}.`,
        });
      }
      for (const ref of collectReferencedStages(pred)) {
        if (!stageNames.has(ref)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["exitPredicates", p],
            message: `exitPredicates[${p}] references unknown stage "${ref}".`,
          });
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
      ? { when: cloneRouteWhen(stage.routes.when as StageRoutePredicate | Predicate) }
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
      ...(stage.workspaceClass !== undefined
        ? { workspaceClass: stage.workspaceClass as WorkspaceClass }
        : {}),
    };
  });

  return {
    id: asPipelineId(key),
    name: configured.name ?? key,
    stages,
    ...(configured.maxConcurrentStages !== undefined
      ? { maxConcurrentStages: configured.maxConcurrentStages }
      : {}),
    ...(configured.exitPredicates !== undefined
      ? { exitPredicates: configured.exitPredicates.map(clonePredicate) }
      : {}),
    ...(configured.maxLoopRounds !== undefined ? { maxLoopRounds: configured.maxLoopRounds } : {}),
  };
}

/**
 * Deep clone a route's `when` so the runtime Pipeline is fully detached from
 * the Zod-parsed object. Legacy shapes stay legacy; DSL shapes stay DSL —
 * the runtime evaluator handles both.
 */
function cloneRouteWhen(when: StageRoutePredicate | Predicate): StageRoutePredicate | Predicate {
  if (LEGACY_ROUTE_KINDS.has(when.kind)) {
    const legacy = when as StageRoutePredicate;
    return { kind: legacy.kind, stages: [...legacy.stages] } as StageRoutePredicate;
  }
  return clonePredicate(when as Predicate);
}

function clonePredicate(p: Predicate): Predicate {
  switch (p.kind) {
    case "all_pass":
    case "any_failed":
    case "no_open_findings":
      return p.stages !== undefined ? { kind: p.kind, stages: [...p.stages] } : { kind: p.kind };
    case "finding_count_below":
      return p.stages !== undefined
        ? { kind: "finding_count_below", n: p.n, stages: [...p.stages] }
        : { kind: "finding_count_below", n: p.n };
    case "and":
      return { kind: "and", predicates: p.predicates.map(clonePredicate) };
    case "or":
      return { kind: "or", predicates: p.predicates.map(clonePredicate) };
    case "not":
      return { kind: "not", predicate: clonePredicate(p.predicate) };
  }
}
