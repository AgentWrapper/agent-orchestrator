/**
 * Pipeline config-change classification — distinguishes "structural" changes
 * that invalidate an in-flight run from "tuning" changes the engine can pick
 * up live.
 *
 * v1.3 spec (issue #1632):
 *   structural — adds, removes, renames, or reshapes stages; alters dependsOn;
 *                changes a stage's executor (kind / plugin / mode / command).
 *   tuning      — predicate-threshold changes, retry counts, timeout / budget
 *                values, exit-predicate body, maxLoopRounds, workspaceClass
 *                annotations. The engine can apply these without aborting the
 *                current run.
 *
 * Used by the driver (CLI / config-watcher) to decide whether to emit a
 * `CONFIG_CHANGED` event (terminating the run) or to hot-reload the
 * pipeline snapshot mid-run. Pure: deterministic, no I/O.
 */

import type { Pipeline, Stage } from "./types.js";

export type ConfigChangeKind = "none" | "tuning" | "structural";

export interface ConfigChangeClassification {
  kind: ConfigChangeKind;
  /** Stable, human-readable reasons. First entry is the dominant reason. */
  reasons: string[];
}

/**
 * Compare two pipeline configurations and classify the delta. The contract:
 *   - `none`        → snapshots are deeply equivalent
 *   - `tuning`      → only tuning-class fields changed (engine may hot-reload)
 *   - `structural`  → at least one structural field changed (run must abort)
 *
 * Classification short-circuits on the first structural diff — once we know
 * a change is structural, the engine has to terminate the run regardless of
 * other diffs, so we don't waste cycles enumerating them all. The `reasons`
 * array still records all detected differences for diagnostics.
 */
export function classifyConfigChange(prev: Pipeline, next: Pipeline): ConfigChangeClassification {
  const reasons: string[] = [];
  const acc: { kind: ConfigChangeKind } = { kind: "none" };

  const bumpTo = (level: Exclude<ConfigChangeKind, "none">, reason: string): void => {
    reasons.push(reason);
    if (acc.kind === "structural") return;
    if (level === "structural" || acc.kind === "none") acc.kind = level;
  };

  if (prev.name !== next.name) bumpTo("structural", `pipeline name changed`);
  if ((prev.maxConcurrentStages ?? 1) !== (next.maxConcurrentStages ?? 1)) {
    bumpTo("tuning", `maxConcurrentStages changed`);
  }
  if ((prev.maxLoopRounds ?? null) !== (next.maxLoopRounds ?? null)) {
    bumpTo("tuning", `maxLoopRounds changed`);
  }
  if (!deepEqual(prev.exitPredicates ?? [], next.exitPredicates ?? [])) {
    bumpTo("tuning", `exitPredicates changed`);
  }

  // Stage-list shape: any rename, add, remove, or reorder is structural — the
  // DAG depends on declaration order for slot allocation, and stage names are
  // the join key for runtime state.
  const prevNames = prev.stages.map((s) => s.name);
  const nextNames = next.stages.map((s) => s.name);
  if (!arraysEqual(prevNames, nextNames)) {
    bumpTo("structural", `stage list changed (${prevNames.join(",")} → ${nextNames.join(",")})`);
    return { kind: acc.kind, reasons };
  }

  for (let i = 0; i < prev.stages.length; i++) {
    const before = prev.stages[i];
    const after = next.stages[i];
    classifyStage(before, after, bumpTo);
    if (acc.kind === "structural") return { kind: acc.kind, reasons };
  }

  return { kind: acc.kind, reasons };
}

function classifyStage(
  before: Stage,
  after: Stage,
  bump: (level: Exclude<ConfigChangeKind, "none">, reason: string) => void,
): void {
  // Executor is structural: changing the plugin or kind invalidates the
  // running subprocess. Mode/command changes mean the agent would do
  // different work, so they're also structural.
  if (!deepEqual(before.executor, after.executor)) {
    bump("structural", `stage "${after.name}" executor changed`);
  }
  if (!arraysEqual(before.dependsOn ?? [], after.dependsOn ?? [])) {
    bump("structural", `stage "${after.name}" dependsOn changed`);
  }
  // Trigger events are structural — they decide whether a stage even runs.
  if (!arraysEqual([...before.trigger.on], [...after.trigger.on])) {
    bump("structural", `stage "${after.name}" trigger.on changed`);
  }
  if (!deepEqual(before.routes ?? null, after.routes ?? null)) {
    // Routes are part of the DAG shape — predicate thresholds aren't, but the
    // route topology itself is. We don't try to distinguish "same DAG, looser
    // predicate" from "different DAG" here; any route change is structural.
    // Tuning-only predicate edits should live in `exitPredicates`.
    bump("structural", `stage "${after.name}" routes changed`);
  }

  // Tuning-class fields below.
  if (!deepEqual(before.task ?? {}, after.task ?? {})) {
    bump("tuning", `stage "${after.name}" task changed`);
  }
  if (!deepEqual(before.policy ?? {}, after.policy ?? {})) {
    bump("tuning", `stage "${after.name}" policy changed`);
  }
  if (!deepEqual(before.budget ?? {}, after.budget ?? {})) {
    bump("tuning", `stage "${after.name}" budget changed`);
  }
  if ((before.timeoutMs ?? null) !== (after.timeoutMs ?? null)) {
    bump("tuning", `stage "${after.name}" timeoutMs changed`);
  }
  if ((before.retries ?? null) !== (after.retries ?? null)) {
    bump("tuning", `stage "${after.name}" retries changed`);
  }
  if ((before.maxLoopRounds ?? null) !== (after.maxLoopRounds ?? null)) {
    bump("tuning", `stage "${after.name}" maxLoopRounds changed`);
  }
  if ((before.workspaceClass ?? "independent") !== (after.workspaceClass ?? "independent")) {
    // Workspace class affects future stage invocations only — current
    // invocation is unaffected. Tuning.
    bump("tuning", `stage "${after.name}" workspaceClass changed`);
  }
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Structural deep-equal for plain-data records.
 *
 * `JSON.stringify` is NOT safe here: V8 preserves insertion order, so a YAML
 * reformatter that reorders `executor.config` keys (e.g. `{ tone, depth }` →
 * `{ depth, tone }`) would stringify to different strings and falsely
 * classify the diff as structural — aborting a live run for a no-op edit.
 *
 * Pipelines/Stages contain only plain values: primitives, arrays, and
 * string-keyed objects from a parsed YAML/JSON tree. No Maps, Sets, Dates,
 * class instances, or symbol-keyed properties to worry about. The recursive
 * comparator below sorts keys lexicographically at every object level so the
 * comparison is order-independent.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).sort();
  const bKeys = Object.keys(bo).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) if (aKeys[i] !== bKeys[i]) return false;
  for (const k of aKeys) if (!deepEqual(ao[k], bo[k])) return false;
  return true;
}
