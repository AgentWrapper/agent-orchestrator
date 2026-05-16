/**
 * Typed predicate DSL — parser (Zod) + pure evaluator.
 *
 * Used in two places:
 *  - `Stage.routes.when` — gates a stage's activation on prior stage state
 *    (new form alongside v1.1's hardcoded `StageRoutePredicate`).
 *  - `Pipeline.exitPredicates` — decides whether a fully-terminal run is
 *    `loop_succeeded` (done) or `loop_failed` (stalled).
 *
 * Leaves:
 *  - `all_pass`            — every referenced stage's terminal status is
 *                            `succeeded` (or `verdict === "pass"` when set).
 *                            Empty scope is vacuously true; the caller is
 *                            responsible for choosing a sensible default scope.
 *  - `any_failed`          — at least one referenced stage's terminal status
 *                            is `failed` specifically (not `skipped` or
 *                            `outdated`). Mirrors v1.1's `anyFailed` exactly
 *                            so the legacy bridge can preserve semantics for
 *                            existing route configs.
 *  - `no_open_findings`    — zero finding artifacts in scope have
 *                            `status === "open"`.
 *  - `finding_count_below` — strictly fewer than `n` open findings in scope.
 *
 * Boolean ops (`and`/`or`/`not`) compose them; nesting depth is bounded only
 * by Zod's recursion guard so deeply pathological configs fail at parse time.
 *
 * Pure: no I/O, no clock reads, no allocation that escapes the call.
 */

import { z } from "zod";

import type {
  Artifact,
  FindingArtifactInput,
  Predicate,
  StageRoutePredicate,
  StageState,
} from "./types.js";

// ============================================================================
// Zod schema
// ============================================================================

const StagesScope = z.array(z.string().min(1)).optional();

/**
 * Recursive Zod schema for `Predicate`. `z.ZodType<Predicate>` short-circuits
 * the type inference Zod can't perform across the lazy reference; without it
 * the inferred output of `z.lazy(() => PredicateSchema)` becomes `any` and we
 * lose the precise discriminator narrowing in callers.
 */
export const PredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("all_pass"), stages: StagesScope }),
    z.object({ kind: z.literal("any_failed"), stages: StagesScope }),
    z.object({ kind: z.literal("no_open_findings"), stages: StagesScope }),
    z.object({
      kind: z.literal("finding_count_below"),
      n: z.number().int().nonnegative(),
      stages: StagesScope,
    }),
    z.object({ kind: z.literal("and"), predicates: z.array(PredicateSchema).min(1) }),
    z.object({ kind: z.literal("or"), predicates: z.array(PredicateSchema).min(1) }),
    z.object({ kind: z.literal("not"), predicate: PredicateSchema }),
  ]),
);

// ============================================================================
// Evaluator
// ============================================================================

export interface PredicateContext {
  /** Live stage states keyed by stage name. */
  stages: Record<string, StageState>;
  /** Artifacts produced during the run, keyed by stage name. */
  artifactsByStage: Record<string, Artifact[]>;
  /**
   * All stage names declared by the pipeline, in declaration order. Used when
   * a leaf omits its `stages` scope (default = "every stage in the run").
   */
  allStageNames: string[];
}

/**
 * Evaluate a typed `Predicate` against runtime state.
 *
 * Stage references that don't appear in `context.stages` are treated as
 * non-terminal (i.e. `all_pass` returns false). The reducer guarantees every
 * stage in `pipelineConfigSnapshot` has an entry in `RunState.stages`, so this
 * fallback only ever fires when a predicate references a stage outside the
 * pipeline — which the schema rejects at config load.
 */
export function evaluatePredicate(predicate: Predicate, context: PredicateContext): boolean {
  switch (predicate.kind) {
    case "all_pass": {
      const scope = predicate.stages ?? context.allStageNames;
      if (scope.length === 0) return true;
      // Legacy bridge: v1.1's `allSucceeded` / `anySucceeded` checked status
      // only — preserve that exact semantics. New DSL callers consult the
      // verdict-aware path.
      const check = isLegacyAllPass(predicate) ? isStageSucceededByStatus : isStagePassing;
      return scope.every((name) => check(context.stages[name]));
    }
    case "any_failed": {
      const scope = predicate.stages ?? context.allStageNames;
      // Empty scope is vacuously false — "no stages were failed" is the
      // only consistent answer when the set is empty.
      return scope.some((name) => context.stages[name]?.status === "failed");
    }
    case "no_open_findings": {
      return collectOpenFindings(predicate.stages, context).length === 0;
    }
    case "finding_count_below": {
      return collectOpenFindings(predicate.stages, context).length < predicate.n;
    }
    case "and":
      return predicate.predicates.every((p) => evaluatePredicate(p, context));
    case "or":
      return predicate.predicates.some((p) => evaluatePredicate(p, context));
    case "not":
      return !evaluatePredicate(predicate.predicate, context);
  }
}

function isStagePassing(stage: StageState | undefined): boolean {
  if (!stage) return false;
  if (stage.verdict !== undefined) return stage.verdict === "pass";
  return stage.status === "succeeded";
}

/**
 * Status-only check used by the legacy `allSucceeded` / `anySucceeded`
 * bridge. v1.1's evaluator never looked at `verdict`; mirroring that here
 * keeps legacy route configs evaluating identically across the upgrade.
 */
function isStageSucceededByStatus(stage: StageState | undefined): boolean {
  return stage?.status === "succeeded";
}

function collectOpenFindings(
  stagesScope: string[] | undefined,
  context: PredicateContext,
): FindingArtifactInput[] {
  const scope = stagesScope ?? context.allStageNames;
  const out: FindingArtifactInput[] = [];
  for (const name of scope) {
    const artifacts = context.artifactsByStage[name];
    if (!artifacts) continue;
    for (const a of artifacts) {
      if (a.kind !== "finding") continue;
      if (a.status !== "open") continue;
      out.push(a);
    }
  }
  return out;
}

// ============================================================================
// Bridge: legacy v1.1 routes → new DSL
// ============================================================================

/**
 * Convert a v1.1 `StageRoutePredicate` into an equivalent `Predicate`. The
 * scheduler keeps both shapes accepted so existing pipelines don't need a
 * rewrite, but evaluation goes through a single code path.
 *
 *  - `allSucceeded` / `anySucceeded` — v1.1's evaluator checked `status ===
 *    "succeeded"` directly and ignored `verdict`. The new `all_pass` leaf
 *    prefers `verdict` over `status`, which would (silently) change
 *    semantics for any stage that sets a non-`"pass"` verdict on a succeeded
 *    stage. We tag the bridged predicates with an internal marker so the
 *    evaluator falls back to a status-only check for legacy routes.
 *  - `anyFailed` → `any_failed`. v1.1's `anyFailed` matches `status ===
 *    "failed"` specifically — `not(all_pass)` would (wrongly) also fire for
 *    `skipped` / `outdated` stages, which v1.1's evaluator never treated as
 *    failures. The dedicated `any_failed` leaf preserves the exact semantics.
 */
export function fromLegacyRoutePredicate(legacy: StageRoutePredicate): Predicate {
  switch (legacy.kind) {
    case "allSucceeded":
      return tagLegacy({ kind: "all_pass", stages: [...legacy.stages] });
    case "anySucceeded":
      return {
        kind: "or",
        predicates: legacy.stages.map((s) => tagLegacy({ kind: "all_pass" as const, stages: [s] })),
      };
    case "anyFailed":
      return { kind: "any_failed", stages: [...legacy.stages] };
  }
}

/**
 * Internal marker attached to `all_pass` leaves bridged from v1.1's
 * `allSucceeded` / `anySucceeded`. Surfaces as a non-enumerable boolean
 * property so it doesn't leak through Zod / JSON serialization (legacy
 * routes are parsed via `StageRoutePredicateSchema` and re-bridged on every
 * evaluation, so the tag is regenerated rather than persisted).
 *
 * The evaluator reads this through `isLegacyAllPass` to decide whether to
 * consult `verdict` or fall back to status-only — the legacy bridge is the
 * only place this gates evaluation.
 */
const LEGACY_TAG: unique symbol = Symbol.for("ao.pipeline.predicate.legacyAllPass");

function tagLegacy<P extends Predicate>(predicate: P): P {
  Object.defineProperty(predicate, LEGACY_TAG, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return predicate;
}

function isLegacyAllPass(predicate: Predicate): boolean {
  return (predicate as unknown as Record<symbol, unknown>)[LEGACY_TAG] === true;
}

const LEGACY_KINDS = new Set(["allSucceeded", "anySucceeded", "anyFailed"]);

/** Type-guard: is this an old StageRoutePredicate rather than the typed DSL? */
export function isLegacyRoutePredicate(
  value: StageRoutePredicate | Predicate,
): value is StageRoutePredicate {
  return LEGACY_KINDS.has(value.kind);
}

/** Normalize either shape into the typed DSL for unified evaluation. */
export function normalizeRoutePredicate(value: StageRoutePredicate | Predicate): Predicate {
  return isLegacyRoutePredicate(value) ? fromLegacyRoutePredicate(value) : value;
}

/**
 * Collect every stage name a predicate references (transitive — boolean
 * combinators descend). Used by `dag.ts` to figure out which upstream stages
 * a stage's routes wait on, and by validation to verify references resolve.
 */
export function collectReferencedStages(value: StageRoutePredicate | Predicate): string[] {
  const predicate = normalizeRoutePredicate(value);
  const refs = new Set<string>();
  walk(predicate);
  return [...refs];

  function walk(p: Predicate): void {
    switch (p.kind) {
      case "all_pass":
      case "any_failed":
      case "no_open_findings":
      case "finding_count_below":
        for (const s of p.stages ?? []) refs.add(s);
        return;
      case "and":
      case "or":
        for (const child of p.predicates) walk(child);
        return;
      case "not":
        walk(p.predicate);
        return;
    }
  }
}

/**
 * Combine multiple pipeline exit predicates into a single decision. Returns
 * `true` when the array is empty (callers default to "no predicate → success"
 * to preserve v1.1 behavior).
 */
export function evaluateExitPredicates(
  predicates: Predicate[] | undefined,
  context: PredicateContext,
): boolean {
  if (!predicates || predicates.length === 0) return true;
  return predicates.every((p) => evaluatePredicate(p, context));
}

/**
 * Validate that every leaf inside a route predicate has an explicit, non-empty
 * `stages` scope. Routes are activation gates — a leaf with no scope defaults
 * to "every stage in the run," which makes `arePreconditionsTerminal` trivially
 * true at trigger time (`collectReferencedStages` returns nothing to await) and
 * lets the predicate evaluate immediately against still-pending stages. The
 * common failure mode is `{ kind: "all_pass" }` (no stages) on a stage that
 * cascade-skips before it can run, because the stage's own `pending` status
 * makes the predicate false. Exit predicates don't have this problem — they
 * only fire when every stage is already terminal, so "all stages" is a
 * well-defined default there.
 *
 * Returns a list of human-readable problems; an empty list means the predicate
 * is route-safe. Callers attach `stages: [i, "routes", "when"]` etc. to the
 * Zod issue context.
 */
export function validateRoutePredicateScope(value: StageRoutePredicate | Predicate): string[] {
  if (isLegacyRoutePredicate(value)) {
    // Legacy shapes have a required, min(1) `stages` field at the schema
    // level; nothing to validate here.
    return [];
  }
  const problems: string[] = [];
  walk(value, problems);
  return problems;

  function walk(p: Predicate, out: string[]): void {
    switch (p.kind) {
      case "all_pass":
      case "any_failed":
      case "no_open_findings":
      case "finding_count_below":
        if (!p.stages || p.stages.length === 0) {
          out.push(
            `${p.kind} leaf in routes.when must declare an explicit, non-empty "stages" scope (route predicates evaluate at trigger time, so the "all stages" default would consume the host stage itself and immediately skip it)`,
          );
        }
        return;
      case "and":
      case "or":
        for (const child of p.predicates) walk(child, out);
        return;
      case "not":
        walk(p.predicate, out);
        return;
    }
  }
}

/**
 * Predicate-tree depth (defense-in-depth against deeply-nested config).
 * `0` for a leaf, `1 + max(child depths)` for combinators.
 *
 * Treats an empty `and` / `or` combinator as a leaf (depth `0`) instead of
 * `-Infinity` from `Math.max(...[])`. The Zod schema rejects `predicates:
 * []` via `.min(1)`, but a programmatically-constructed Predicate can hit
 * this path (e.g. defensive `validatePipelineExitPredicates` below).
 */
export function predicateDepth(predicate: Predicate): number {
  switch (predicate.kind) {
    case "all_pass":
    case "any_failed":
    case "no_open_findings":
    case "finding_count_below":
      return 0;
    case "and":
    case "or":
      if (predicate.predicates.length === 0) return 0;
      return 1 + Math.max(...predicate.predicates.map(predicateDepth));
    case "not":
      return 1 + predicateDepth(predicate.predicate);
  }
}

/** Maximum predicate nesting depth accepted at config load. */
export const MAX_PREDICATE_DEPTH = 16;
