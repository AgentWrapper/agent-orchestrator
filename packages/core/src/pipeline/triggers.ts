/**
 * Pure trigger evaluation + concurrency policy decisions.
 *
 * Two responsibilities, both deterministic and side-effect-free so the
 * lifecycle-manager integration tests can assert on the decision tier
 * without standing up a real SCM/store.
 *
 *   evaluateTrigger(trigger, event)         → boolean
 *   decideConcurrencyAction(policy, active) → ConcurrencyAction
 *
 * Glob support is intentionally minimal: `*` matches a single path segment,
 * `**` matches any number of segments (including zero). Branch globs use
 * the same matcher because branch names like `release/*` are common and
 * GitHub-style ref-name matching is otherwise just exact-string equality.
 * No bracket character classes, no extglob — anything richer should land
 * in the v1.3 predicate DSL, not here.
 */

import type { PREvent } from "../types.js";
import type {
  ConcurrencyPolicy,
  PipelineTrigger,
  PipelineTriggerEvent,
} from "./types.js";

// ============================================================================
// Glob matching
// ============================================================================

/**
 * Convert a single glob pattern to an anchored RegExp.
 *
 * Rules (matching GitHub Actions glob semantics):
 *  - `**` matches any number of path segments (including zero). When
 *    written as `**\/X` it collapses the separator too, so `**\/*.ts`
 *    matches both `config.ts` (zero segments) and `src/foo.ts`.
 *  - `*` matches anything except `/`.
 *  - All other regex metacharacters are escaped.
 *
 * Patterns are matched against the full string. `src/**` matches paths
 * strictly under `src/` (not `src` itself); use `src` or `src/**` together
 * if you need both.
 */
function compileGlob(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      // `**/` collapses the separator so root-level paths match.
      // `**` not followed by `/` is just any-character (including `/`).
      if (pattern[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i++;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (/[.+?^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Returns true if `value` matches any of `patterns`. An empty/missing
 * pattern list matches every value (filter is "not set").
 */
export function matchesAnyGlob(patterns: string[] | undefined, value: string): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => compileGlob(p).test(value));
}

/**
 * Returns true if any value in `values` matches any pattern in `patterns`.
 * An empty pattern list matches everything (filter is "not set"); an empty
 * values list with non-empty patterns matches nothing (e.g. files filter
 * set but no changed files reported).
 */
export function anyValueMatchesAnyGlob(
  patterns: string[] | undefined,
  values: string[],
): boolean {
  if (!patterns || patterns.length === 0) return true;
  if (values.length === 0) return false;
  const compiled = patterns.map(compileGlob);
  return values.some((v) => compiled.some((re) => re.test(v)));
}

// ============================================================================
// Event-type ↔ trigger-type compatibility
// ============================================================================

/** Map a `PREvent.type` to the `PipelineTriggerEvent` that fires for it. */
export function triggerEventForPREvent(prEventType: PREvent["type"]): PipelineTriggerEvent {
  // Same string identifiers — kept as a function so the boundary stays
  // explicit and a future divergence (e.g. mapping a `pr_synchronized`
  // SCM event to `pr_push`) has a single place to update.
  return prEventType;
}

// ============================================================================
// Trigger evaluation
// ============================================================================

export interface TriggerEvaluationContext {
  trigger: PipelineTrigger;
  event: PREvent;
}

/**
 * Returns true if `trigger` should fire for `event`.
 *
 * - `manual` triggers never fire automatically (they're invoked by
 *   `ao pipeline run`). This function returns `false` for them so callers
 *   don't need a separate skip check.
 * - All filter fields are conjoined: branches AND files AND labels AND
 *   excludeDrafts must all match. Within a single filter (e.g. `files`),
 *   any match is sufficient (disjunctive within a list, conjunctive across
 *   filters).
 */
export function evaluateTrigger({ trigger, event }: TriggerEvaluationContext): boolean {
  if (trigger.on === "manual") return false;
  if (trigger.on !== triggerEventForPREvent(event.type)) return false;

  if (trigger.excludeDrafts === true && event.isDraft) return false;

  if (!matchesAnyGlob(trigger.branches, event.baseBranch)) return false;
  if (!anyValueMatchesAnyGlob(trigger.files, event.changedFiles)) return false;
  if (!anyValueMatchesAnyGlob(trigger.labels, event.labels)) return false;

  return true;
}

// ============================================================================
// Concurrency policy
// ============================================================================

/**
 * The action the dispatcher should take given a trigger match and the
 * current state of the pipeline's loop.
 *
 *  - `start`              — no active run; just dispatch.
 *  - `cancel_then_start`  — active run exists; cancel it then dispatch.
 *  - `skip`               — active run exists; drop the trigger silently.
 *  - `queue`              — active run exists; remember and dispatch later.
 */
export type ConcurrencyAction = "start" | "cancel_then_start" | "skip" | "queue";

export interface ConcurrencyDecisionContext {
  policy: ConcurrencyPolicy;
  /** True if a non-terminal run already exists for this pipeline+session loop. */
  hasActiveRun: boolean;
}

/**
 * Decide what to do for a trigger that just matched, given an active-run
 * state and a configured policy. Pure; no I/O.
 */
export function decideConcurrencyAction({
  policy,
  hasActiveRun,
}: ConcurrencyDecisionContext): ConcurrencyAction {
  if (!hasActiveRun) return "start";
  switch (policy) {
    case "cancel_in_progress":
      return "cancel_then_start";
    case "skip":
      return "skip";
    case "queue":
      return "queue";
  }
}
