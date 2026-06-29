/**
 * Scheduled-tasks model, parsing, and trigger math for the durable scheduler.
 *
 * The durable scheduler (running inside `ao daemon`) reads task definitions from
 * each project's library at `<projectRoot>/.maestro/scheduled-tasks/*.yaml`
 * (schema documented in that folder's SCHEMA.md), computes when each trigger is
 * next due, and fires the task's action. This module owns the *pure* half of
 * that pipeline — loading/validating the YAML and the trigger arithmetic — with
 * no engine, filesystem-watch, or dispatch side effects beyond reading the
 * definition files. The runtime ticker and the real action handlers live in the
 * CLI (`lib/scheduler.ts`); state persistence lives in `scheduler-state.ts`.
 *
 * FAIL-SOFT by design: a malformed or invalid task file is reported and skipped,
 * never thrown — one bad job must not break the others or the daemon.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export type ScheduledTriggerType = "cron" | "interval" | "datetime";
export type ScheduledActionType = "spawn" | "send" | "notify";

export interface ScheduledTaskTrigger {
  type: ScheduledTriggerType;
  /** Interpretation depends on `type`: 5-field cron, a duration, or an ISO-8601 timestamp. */
  expr: string;
}

export interface ScheduledTaskAction {
  type: ScheduledActionType;
  /** spawn */
  prompt?: string;
  skills?: string[];
  model?: string;
  /** send / notify */
  target?: string;
  message?: string;
}

export interface ScheduledTask {
  name: string;
  description?: string;
  enabled: boolean;
  trigger: ScheduledTaskTrigger;
  action: ScheduledTaskAction;
}

/** Default firing tolerance: how late a due slot may be observed and still fire.
 *  Wide enough to absorb tick jitter / a missed tick (the ticker runs once a
 *  minute), narrow enough that a slot missed during real daemon downtime is
 *  skipped — no catch-up, the next due time is just recomputed forward. */
export const DEFAULT_FIRE_GRACE_MS = 90_000;

/**
 * `expr` is always a string in the schema, but an unquoted ISO timestamp in a
 * YAML file parses to a JS Date — normalize that back to a string so a
 * fat-fingered unquoted `datetime` expr still validates instead of being dropped.
 */
const exprSchema = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString() : v),
  z.string().min(1),
);

const triggerSchema = z.object({
  type: z.enum(["cron", "interval", "datetime"]),
  expr: exprSchema,
});

const actionSchema = z
  .object({
    type: z.enum(["spawn", "send", "notify"]),
    prompt: z.string().optional(),
    skills: z.array(z.string()).optional(),
    model: z.string().optional(),
    target: z.string().optional(),
    message: z.string().optional(),
  })
  .superRefine((action, ctx) => {
    if (action.type === "spawn" && !action.prompt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "spawn action requires `prompt`" });
    }
    if (action.type === "send") {
      if (!action.target)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "send action requires `target`" });
      if (!action.message)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "send action requires `message`" });
    }
    if (action.type === "notify" && !action.message) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "notify action requires `message`" });
    }
  });

const scheduledTaskSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean(),
  trigger: triggerSchema,
  action: actionSchema,
});

export interface ParseScheduledTaskResult {
  task?: ScheduledTask;
  error?: string;
}

/** Parse + validate one scheduled-task YAML document. Never throws. */
export function parseScheduledTaskDocument(text: string): ParseScheduledTaskResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return { error: `YAML parse error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const parsed = scheduledTaskSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".");
    return { error: `invalid task: ${path ? `${path}: ` : ""}${issue?.message ?? "validation failed"}` };
  }

  // Reject an expr the trigger arithmetic can't interpret, so a job with a
  // broken schedule surfaces as an error instead of silently never firing.
  const { trigger } = parsed.data;
  if (computeTriggerDue(trigger, new Date(0)) === null) {
    return { error: `invalid ${trigger.type} expr: "${trigger.expr}"` };
  }

  return { task: parsed.data as ScheduledTask };
}

export interface LoadScheduledTasksResult {
  tasks: ScheduledTask[];
  /** Per-file problems, keyed by file name — for logging, not fatal. */
  errors: Array<{ file: string; error: string }>;
}

/**
 * Load every scheduled-task definition from a project's library directory
 * (`<projectRoot>/.maestro/scheduled-tasks/*.yaml`). Returns all valid tasks
 * (including disabled ones — the caller skips `enabled: false`) plus per-file
 * errors. A missing directory yields an empty result.
 */
export function loadScheduledTasks(projectRoot: string): LoadScheduledTasksResult {
  const result: LoadScheduledTasksResult = { tasks: [], errors: [] };
  const dir = join(projectRoot, ".maestro", "scheduled-tasks");
  if (!existsSync(dir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }

  const seenNames = new Set<string>();
  for (const file of entries.sort()) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf-8");
    } catch (err) {
      result.errors.push({ file, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const { task, error } = parseScheduledTaskDocument(text);
    if (error || !task) {
      result.errors.push({ file, error: error ?? "unknown parse failure" });
      continue;
    }
    // Names key the durable state; a duplicate would make two files fight over
    // one slot. Keep the first, report the rest.
    if (seenNames.has(task.name)) {
      result.errors.push({ file, error: `duplicate task name "${task.name}"` });
      continue;
    }
    seenNames.add(task.name);
    result.tasks.push(task);
  }

  return result;
}

// =============================================================================
// Trigger arithmetic
// =============================================================================

/** Parse a duration like `30m`, `1h`, `6h`, `1d` into milliseconds. */
export function parseDurationMs(expr: string): number | null {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(expr.trim());
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2];
  const factor = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return value * factor;
}

/** Parse an ISO-8601 datetime expr into a Date, or null if unparseable. */
export function parseDateTimeExpr(expr: string): Date | null {
  const date = new Date(expr.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Expand one cron field (`*`, `a`, `a-b`, `*\/n`, `a-b/n`, and comma lists) into a set. */
function expandCronField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const piece = part.trim();
    if (!piece) return null;

    let rangePart = piece;
    let step = 1;
    const slash = piece.indexOf("/");
    if (slash !== -1) {
      rangePart = piece.slice(0, slash);
      step = parseInt(piece.slice(slash + 1), 10);
      if (!Number.isFinite(step) || step <= 0) return null;
    }

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
    } else {
      lo = parseInt(rangePart, 10);
      hi = lo;
      if (slash !== -1) hi = max; // `n/step` means from n to max, stepping
    }

    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

/** Parse a 5-field cron expression (`min hour dom mon dow`), host-local time. */
export function parseCronExpr(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minute = expandCronField(parts[0], 0, 59);
  const hour = expandCronField(parts[1], 0, 23);
  const dom = expandCronField(parts[2], 1, 31);
  const month = expandCronField(parts[3], 1, 12);
  // Day-of-week 0-7 with both 0 and 7 meaning Sunday.
  const dowRaw = expandCronField(parts[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;

  const dow = new Set<number>();
  for (const v of dowRaw) dow.add(v === 7 ? 0 : v);

  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

/** Standard cron day match: if both DOM and DOW are restricted, either matching is enough. */
function cronDayMatches(fields: CronFields, date: Date): boolean {
  const domOk = fields.dom.has(date.getDate());
  const dowOk = fields.dow.has(date.getDay());
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk;
  if (fields.domRestricted) return domOk;
  if (fields.dowRestricted) return dowOk;
  return true;
}

// Bound the field-stepping search so an impossible expr (e.g. Feb 31) can't loop
// forever. Coarse skips keep real expressions far under this — even a Feb-29-only
// cron resolves in a handful of month jumps.
const CRON_SEARCH_MAX_STEPS = 500_000;

/** First minute strictly after `after` that matches the cron fields, or null. */
export function computeNextCronTime(fields: CronFields, after: Date): Date | null {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after the current minute

  for (let steps = 0; steps < CRON_SEARCH_MAX_STEPS; steps++) {
    if (!fields.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cronDayMatches(fields, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!fields.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!fields.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(d);
  }
  return null;
}

/**
 * Next time the trigger is due, strictly after `from`.
 * - cron: next matching minute.
 * - interval: `from` + duration.
 * - datetime: the fixed instant (may be in the past; the caller decides).
 * Returns null when the expr is invalid.
 */
export function computeTriggerDue(trigger: ScheduledTaskTrigger, from: Date): Date | null {
  switch (trigger.type) {
    case "cron": {
      const fields = parseCronExpr(trigger.expr);
      return fields ? computeNextCronTime(fields, from) : null;
    }
    case "interval": {
      const ms = parseDurationMs(trigger.expr);
      return ms === null ? null : new Date(from.getTime() + ms);
    }
    case "datetime":
      return parseDateTimeExpr(trigger.expr);
    default:
      return null;
  }
}

// =============================================================================
// Per-job evaluation (anti-double-fire / no-catch-up)
// =============================================================================

/** Durable per-job state persisted across daemon restarts. */
export interface ScheduledJobState {
  /** ISO-8601 of the next slot this job should fire at. */
  nextDueAt?: string;
  /** ISO-8601 of the last time the action actually fired. */
  lastFiredAt?: string;
  /** A `datetime` job that has already passed its single slot — never fires again. */
  spent?: boolean;
}

export interface EvaluateScheduledJobInput {
  task: ScheduledTask;
  state: ScheduledJobState;
  now: Date;
  /** Firing tolerance; defaults to {@link DEFAULT_FIRE_GRACE_MS}. */
  graceMs?: number;
}

export interface EvaluateScheduledJobResult {
  shouldFire: boolean;
  nextState: ScheduledJobState;
}

/**
 * Decide whether a job fires on this tick and compute its next durable state.
 *
 * Contract:
 * - First sighting (no `nextDueAt`): compute the next due time and persist it —
 *   never fire immediately, even for an interval/cron.
 * - Due and on time (`now >= nextDueAt`, within `graceMs`): fire, then advance
 *   `nextDueAt` forward from `now`. Advancing past the just-fired slot is what
 *   makes a restart at the same instant NOT re-fire (anti-double-fire).
 * - Due but stale (`now - nextDueAt > graceMs`, e.g. the slot passed while the
 *   daemon was down): do NOT fire — just recompute `nextDueAt` forward. Missed
 *   slots are never caught up or accumulated.
 * - `datetime` fires at most once: after its slot passes (fired or stale) it is
 *   marked `spent` and never re-evaluated.
 *
 * Pure: no I/O, no clock reads — `now` is injected so the logic is testable.
 */
export function evaluateScheduledJob(input: EvaluateScheduledJobInput): EvaluateScheduledJobResult {
  const { task, state, now } = input;
  const graceMs = input.graceMs ?? DEFAULT_FIRE_GRACE_MS;

  if (!task.enabled || state.spent) {
    return { shouldFire: false, nextState: state };
  }

  // First sighting: seed the next due time, never fire on the seeding tick.
  if (!state.nextDueAt) {
    const due = computeTriggerDue(task.trigger, now);
    if (!due) return { shouldFire: false, nextState: state };
    return { shouldFire: false, nextState: { ...state, nextDueAt: due.toISOString() } };
  }

  const nextDue = new Date(state.nextDueAt);
  if (Number.isNaN(nextDue.getTime()) || now.getTime() < nextDue.getTime()) {
    return { shouldFire: false, nextState: state };
  }

  const onTime = now.getTime() - nextDue.getTime() <= graceMs;

  if (task.trigger.type === "datetime") {
    // Single slot reached — spent regardless of whether it actually fired.
    return {
      shouldFire: onTime,
      nextState: {
        spent: true,
        lastFiredAt: onTime ? now.toISOString() : state.lastFiredAt,
      },
    };
  }

  // Recurring: advance forward from now (no catch-up of missed slots).
  const advanced = computeTriggerDue(task.trigger, now);
  return {
    shouldFire: onTime,
    nextState: {
      ...state,
      nextDueAt: advanced ? advanced.toISOString() : undefined,
      lastFiredAt: onTime ? now.toISOString() : state.lastFiredAt,
    },
  };
}

// =============================================================================
// Action dispatch mapping (handlers injected for testability)
// =============================================================================

export interface ScheduledActionHandlers {
  spawn(opts: {
    projectId: string;
    taskName: string;
    prompt: string;
    skills?: string[];
    model?: string;
  }): Promise<void>;
  send(opts: {
    projectId: string;
    taskName: string;
    target: string;
    message: string;
  }): Promise<void>;
  notify(opts: {
    projectId: string;
    taskName: string;
    message: string;
    target?: string;
  }): Promise<void>;
}

/**
 * Map a fired task's action onto the injected handler. The schema guarantees the
 * required params are present (validated at load), but we guard defensively so a
 * hand-edited state can't crash the ticker.
 */
export async function dispatchScheduledAction(
  task: ScheduledTask,
  projectId: string,
  handlers: ScheduledActionHandlers,
): Promise<void> {
  const action = task.action;
  switch (action.type) {
    case "spawn":
      if (!action.prompt) throw new Error("spawn action missing prompt");
      await handlers.spawn({
        projectId,
        taskName: task.name,
        prompt: action.prompt,
        skills: action.skills,
        model: action.model,
      });
      return;
    case "send":
      if (!action.target || !action.message) throw new Error("send action missing target/message");
      await handlers.send({
        projectId,
        taskName: task.name,
        target: action.target,
        message: action.message,
      });
      return;
    case "notify":
      if (!action.message) throw new Error("notify action missing message");
      await handlers.notify({
        projectId,
        taskName: task.name,
        message: action.message,
        target: action.target,
      });
      return;
    default:
      throw new Error(`unknown action type: ${(action as { type: string }).type}`);
  }
}
