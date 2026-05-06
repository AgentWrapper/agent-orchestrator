import type {
  CanonicalPRReason,
  CanonicalPRState,
  CanonicalRuntimeReason,
  CanonicalRuntimeState,
  CanonicalSessionLifecycle,
  CanonicalSessionReason,
  CanonicalSessionState,
  RuntimeHandle,
  SessionKind,
  SessionStatus,
} from "./types.js";
import { z } from "zod";
import { parsePrFromUrl } from "./utils/pr.js";
import { safeJsonParse, validateStatus } from "./utils/validation.js";

interface ParseCanonicalLifecycleOptions {
  sessionId?: string;
  status?: SessionStatus;
  runtimeHandle?: RuntimeHandle | null;
  createdAt?: Date;
  /**
   * When provided, overrides the id-based heuristic for `session.kind`.
   * Use this from call sites that know the project's sessionPrefix and can
   * apply the stricter predicate — avoids leaking foreign-prefix legacy
   * records (e.g. `{projectId}-orchestrator` where projectId ≠ sessionPrefix)
   * through as orchestrators via the `endsWith("-orchestrator")` fallback.
   */
  sessionKind?: SessionKind;
}

const TimestampSchema = z.string().nullable();

const RuntimeHandleSchema = z.object({
  id: z.string(),
  runtimeName: z.string(),
  data: z.preprocess((value) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
    return {};
  }, z.record(z.unknown())),
});

const CanonicalSessionLifecycleSchema = z.object({
  version: z.literal(2),
  session: z
    .object({
      kind: z.enum(["worker", "orchestrator"]),
      state: z.enum([
        "not_started",
        "working",
        "idle",
        "needs_input",
        "stuck",
        "detecting",
        "done",
        "terminated",
      ]),
      reason: z.enum([
        "spawn_requested",
        "agent_acknowledged",
        "task_in_progress",
        "pr_created",
        "pr_closed_waiting_decision",
        "fixing_ci",
        "resolving_review_comments",
        "awaiting_user_input",
        "awaiting_external_review",
        "research_complete",
        "merged_waiting_decision",
        "manually_killed",
        "runtime_lost",
        "agent_process_exited",
        "probe_failure",
        "error_in_process",
        "auto_cleanup",
        "pr_merged",
      ]),
      startedAt: TimestampSchema,
      completedAt: TimestampSchema,
      terminatedAt: TimestampSchema,
      lastTransitionAt: z.string(),
    })
    .partial()
    .optional(),
  pr: z
    .object({
      state: z.enum(["none", "open", "merged", "closed"]),
      reason: z.enum([
        "not_created",
        "in_progress",
        "ci_failing",
        "review_pending",
        "changes_requested",
        "approved",
        "merge_ready",
        "merged",
        "closed_unmerged",
        "cleared_on_restore",
      ]),
      number: z.number().int().nullable(),
      url: z.string().nullable(),
      lastObservedAt: TimestampSchema,
    })
    .partial()
    .optional(),
  runtime: z
    .object({
      state: z.enum(["unknown", "alive", "exited", "missing", "probe_failed"]),
      reason: z.enum([
        "spawn_incomplete",
        "process_running",
        "process_missing",
        "tmux_missing",
        "manual_kill_requested",
        "probe_error",
        "pr_merged_cleanup",
        "auto_cleanup",
      ]),
      lastObservedAt: TimestampSchema,
      handle: RuntimeHandleSchema.nullable(),
      tmuxName: z.string().nullable(),
    })
    .partial()
    .optional(),
});

type ParsedCanonicalSessionLifecycle = z.infer<typeof CanonicalSessionLifecycleSchema>;

function normalizeTimestamp(value: unknown, fallback: string | null = null): string | null {
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

function normalizeRuntimeHandle(value: unknown): RuntimeHandle | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || typeof record["runtimeName"] !== "string") return null;
  const data = record["data"];
  return {
    id: record["id"],
    runtimeName: record["runtimeName"],
    data: data && typeof data === "object" ? (data as Record<string, unknown>) : {},
  };
}

export function createInitialCanonicalLifecycle(
  kind: SessionKind,
  now = new Date(),
): CanonicalSessionLifecycle {
  const timestamp = now.toISOString();
  return {
    version: 2,
    session: {
      kind,
      state: "not_started",
      reason: "spawn_requested",
      startedAt: null,
      completedAt: null,
      terminatedAt: null,
      lastTransitionAt: timestamp,
    },
    pr: {
      state: "none",
      reason: "not_created",
      number: null,
      url: null,
      lastObservedAt: null,
    },
    runtime: {
      state: "unknown",
      reason: "spawn_incomplete",
      lastObservedAt: null,
      handle: null,
      tmuxName: null,
    },
  };
}

function synthesizeSessionState(
  status: SessionStatus,
): { state: CanonicalSessionState; reason: CanonicalSessionReason } {
  switch (status) {
    case "spawning":
      return { state: "not_started", reason: "spawn_requested" };
    case "needs_input":
      return { state: "needs_input", reason: "awaiting_user_input" };
    case "stuck":
      return { state: "stuck", reason: "probe_failure" };
    case "errored":
      return { state: "terminated", reason: "error_in_process" };
    case "killed":
    case "terminated":
    case "cleanup":
      return { state: "terminated", reason: "manually_killed" };
    case "done":
      return { state: "done", reason: "research_complete" };
    case "merged":
      return { state: "idle", reason: "merged_waiting_decision" };
    case "idle":
      return { state: "idle", reason: "awaiting_external_review" };
    default:
      return { state: "working", reason: "task_in_progress" };
  }
}

function synthesizePRState(meta: Record<string, string>, status: SessionStatus): {
  state: CanonicalPRState;
  reason: CanonicalPRReason;
  number: number | null;
  url: string | null;
} {
  const prUrl = meta["pr"] ?? null;
  if (!prUrl) {
    // Legacy metadata can record `status=merged` without `pr=` (the PR URL was
    // never written, or was pruned). Preserve the terminal truth — the legacy
    // status is authoritative for session terminality — so downstream
    // consumers like isTerminalSession don't lose the "merged" signal.
    if (status === "merged") {
      return { state: "merged", reason: "merged", number: null, url: null };
    }
    return { state: "none", reason: "not_created", number: null, url: null };
  }
  const parsed = parsePrFromUrl(prUrl);
  return {
    state: status === "merged" ? "merged" : "open",
    reason: status === "merged" ? "merged" : "in_progress",
    number: parsed?.number ?? null,
    url: prUrl,
  };
}

function synthesizeRuntimeState(
  meta: Record<string, string>,
  runtimeHandle: RuntimeHandle | null,
): { state: CanonicalRuntimeState; reason: CanonicalRuntimeReason; handle: RuntimeHandle | null; tmuxName: string | null } {
  const tmuxName = meta["tmuxName"]?.trim() || null;
  const handle =
    runtimeHandle ?? (meta["runtimeHandle"] ? safeJsonParse<RuntimeHandle>(meta["runtimeHandle"]) : null);
  if (handle || tmuxName) {
    return {
      state: "unknown",
      reason: "spawn_incomplete",
      handle: handle ?? null,
      tmuxName,
    };
  }
  return {
    state: "unknown",
    reason: "spawn_incomplete",
    handle: null,
    tmuxName: null,
  };
}

function synthesizeCanonicalLifecycle(
  meta: Record<string, string>,
  options: ParseCanonicalLifecycleOptions = {},
): CanonicalSessionLifecycle {
  const status = options.status ?? validateStatus(meta["status"]);
  const sessionKind: SessionKind =
    options.sessionKind ??
    (meta["role"] === "orchestrator" || options.sessionId?.endsWith("-orchestrator")
      ? "orchestrator"
      : "worker");
  const now =
    options.createdAt?.toISOString() ??
    normalizeTimestamp(meta["createdAt"], new Date().toISOString()) ??
    new Date().toISOString();
  const sessionState = synthesizeSessionState(status);
  const pr = synthesizePRState(meta, status);
  const runtime = synthesizeRuntimeState(meta, options.runtimeHandle ?? null);

  return {
    version: 2,
    session: {
      kind: sessionKind,
      state: sessionState.state,
      reason: sessionState.reason,
      startedAt: status === "spawning" ? null : now,
      completedAt: status === "done" ? now : null,
      terminatedAt:
        status === "killed" || status === "terminated" || status === "cleanup" ? now : null,
      lastTransitionAt: now,
    },
    pr: {
      state: pr.state,
      reason: pr.reason,
      number: pr.number,
      url: pr.url,
      lastObservedAt: pr.url ? now : null,
    },
    runtime: {
      state: runtime.state,
      reason: runtime.reason,
      lastObservedAt: runtime.handle || runtime.tmuxName ? now : null,
      handle: runtime.handle,
      tmuxName: runtime.tmuxName,
    },
  };
}

function normalizePayloadLifecycle(
  payload: ParsedCanonicalSessionLifecycle,
  meta: Record<string, string>,
  options: ParseCanonicalLifecycleOptions = {},
): CanonicalSessionLifecycle {
  const synthesized = synthesizeCanonicalLifecycle(meta, options);
  const payloadSession = payload.session;
  const payloadPr = payload.pr;
  const payloadRuntime = payload.runtime;
  const hasPayloadSessionKind = Object.hasOwn(payloadSession ?? {}, "kind");
  const hasPayloadSessionState = Object.hasOwn(payloadSession ?? {}, "state");
  const hasPayloadSessionReason = Object.hasOwn(payloadSession ?? {}, "reason");
  const hasPayloadSessionStartedAt = Object.hasOwn(payloadSession ?? {}, "startedAt");
  const hasPayloadSessionCompletedAt = Object.hasOwn(payloadSession ?? {}, "completedAt");
  const hasPayloadSessionTerminatedAt = Object.hasOwn(payloadSession ?? {}, "terminatedAt");
  const hasPayloadSessionLastTransitionAt = Object.hasOwn(payloadSession ?? {}, "lastTransitionAt");
  const hasPayloadPrState = Object.hasOwn(payloadPr ?? {}, "state");
  const hasPayloadPrReason = Object.hasOwn(payloadPr ?? {}, "reason");
  const hasPayloadPrNumber = Object.hasOwn(payloadPr ?? {}, "number");
  const hasPayloadPrUrl = Object.hasOwn(payloadPr ?? {}, "url");
  const hasPayloadPrLastObservedAt = Object.hasOwn(payloadPr ?? {}, "lastObservedAt");
  const hasPayloadRuntimeState = Object.hasOwn(payloadRuntime ?? {}, "state");
  const hasPayloadRuntimeReason = Object.hasOwn(payloadRuntime ?? {}, "reason");
  const hasPayloadRuntimeLastObservedAt = Object.hasOwn(payloadRuntime ?? {}, "lastObservedAt");
  const hasPayloadRuntimeHandle = Object.hasOwn(payloadRuntime ?? {}, "handle");
  const hasPayloadRuntimeTmuxName = Object.hasOwn(payloadRuntime ?? {}, "tmuxName");

  return {
    version: 2,
    session: {
      kind: hasPayloadSessionKind
        ? payloadSession?.kind === "orchestrator"
          ? "orchestrator"
          : "worker"
        : synthesized.session.kind,
      state: hasPayloadSessionState
        ? (payloadSession?.state as CanonicalSessionState | undefined) ?? synthesized.session.state
        : synthesized.session.state,
      reason:
        hasPayloadSessionReason
          ? (payloadSession?.reason as CanonicalSessionReason | undefined) ?? synthesized.session.reason
          : synthesized.session.reason,
      startedAt: hasPayloadSessionStartedAt
        ? normalizeTimestamp(payloadSession?.startedAt)
        : synthesized.session.startedAt,
      completedAt: hasPayloadSessionCompletedAt
        ? normalizeTimestamp(payloadSession?.completedAt)
        : synthesized.session.completedAt,
      terminatedAt: hasPayloadSessionTerminatedAt
        ? normalizeTimestamp(payloadSession?.terminatedAt)
        : synthesized.session.terminatedAt,
      lastTransitionAt: hasPayloadSessionLastTransitionAt
        ? normalizeTimestamp(payloadSession?.lastTransitionAt, synthesized.session.lastTransitionAt) ??
          synthesized.session.lastTransitionAt
        : synthesized.session.lastTransitionAt,
    },
    pr: {
      state: hasPayloadPrState
        ? (payloadPr?.state as CanonicalPRState | undefined) ?? synthesized.pr.state
        : synthesized.pr.state,
      reason: hasPayloadPrReason
        ? (payloadPr?.reason as CanonicalPRReason | undefined) ?? synthesized.pr.reason
        : synthesized.pr.reason,
      number: hasPayloadPrNumber
        ? typeof payloadPr?.number === "number"
          ? payloadPr.number
          : null
        : synthesized.pr.number,
      url: hasPayloadPrUrl ? (typeof payloadPr?.url === "string" ? payloadPr.url : null) : synthesized.pr.url,
      lastObservedAt: hasPayloadPrLastObservedAt
        ? normalizeTimestamp(payloadPr?.lastObservedAt)
        : synthesized.pr.lastObservedAt,
    },
    runtime: {
      state: hasPayloadRuntimeState
        ? (payloadRuntime?.state as CanonicalRuntimeState | undefined) ?? synthesized.runtime.state
        : synthesized.runtime.state,
      reason:
        hasPayloadRuntimeReason
          ? (payloadRuntime?.reason as CanonicalRuntimeReason | undefined) ??
            synthesized.runtime.reason
          : synthesized.runtime.reason,
      lastObservedAt: hasPayloadRuntimeLastObservedAt
        ? normalizeTimestamp(payloadRuntime?.lastObservedAt)
        : synthesized.runtime.lastObservedAt,
      handle: hasPayloadRuntimeHandle
        ? normalizeRuntimeHandle(payloadRuntime?.handle)
        : synthesized.runtime.handle,
      tmuxName: hasPayloadRuntimeTmuxName
        ? typeof payloadRuntime?.tmuxName === "string"
          ? payloadRuntime.tmuxName
          : null
        : synthesized.runtime.tmuxName,
    },
  };
}

export function parseCanonicalLifecycle(
  meta: Record<string, string>,
  options: ParseCanonicalLifecycleOptions = {},
): CanonicalSessionLifecycle {
  const parsed =
    meta["lifecycle"]
      ? safeJsonParse<unknown>(meta["lifecycle"])
      : meta["statePayload"] && meta["stateVersion"] === "2"
        ? safeJsonParse<unknown>(meta["statePayload"])
        : null;
  const validated = CanonicalSessionLifecycleSchema.safeParse(parsed);
  if (validated.success) {
    return normalizePayloadLifecycle(validated.data, meta, options);
  }
  return synthesizeCanonicalLifecycle(meta, options);
}

export function deriveLegacyStatus(
  lifecycle: CanonicalSessionLifecycle,
): SessionStatus {
  switch (lifecycle.session.state) {
    case "not_started":
      return "spawning";
    case "needs_input":
      return "needs_input";
    case "stuck":
      return "stuck";
    case "done":
      return "done";
    case "terminated":
      // Derive specific terminal status from lifecycle reason
      switch (lifecycle.session.reason) {
        case "manually_killed":
        case "runtime_lost":
          return "killed";
        case "auto_cleanup":
        case "pr_merged":
          return "cleanup";
        case "error_in_process":
        case "probe_failure":
          return "errored";
        default:
          return "terminated";
      }
    case "detecting":
      return "detecting";
    default:
      // "idle" and "working" fall through to PR-state checks below.
      // idle + merged PR → "merged"; idle + open PR → PR-specific status;
      // working + open PR → PR-specific status; otherwise → session state directly.
      break;
  }

  if (lifecycle.pr.state === "merged") {
    return "merged";
  }
  if (lifecycle.pr.state === "open") {
    if (lifecycle.pr.reason === "ci_failing") return "ci_failed";
    if (lifecycle.pr.reason === "changes_requested") return "changes_requested";
    if (lifecycle.pr.reason === "review_pending") return "review_pending";
    if (lifecycle.pr.reason === "approved") return "approved";
    if (lifecycle.pr.reason === "merge_ready") return "mergeable";
    return "pr_open";
  }

  switch (lifecycle.session.state) {
    case "idle":
      return "idle";
    case "working":
      return "working";
    default:
      return "working";
  }
}

/**
 * Build a minimal metadata patch for persisting lifecycle state outside the polling loop.
 * Used by writeCanonicalLifecycle() and agent-report writes. Does NOT include detecting
 * or evidence metadata — use buildTransitionMetadataPatch() for lifecycle poll transitions.
 */
export function buildLifecycleMetadataPatch(
  lifecycle: CanonicalSessionLifecycle,
): Partial<Record<string, string>> {
  return {
    lifecycle: JSON.stringify(lifecycle),
    // status is NOT persisted — computed on read via deriveLegacyStatus()
    pr: lifecycle.pr.url ?? "",
    runtimeHandle: lifecycle.runtime.handle ? JSON.stringify(lifecycle.runtime.handle) : "",
    tmuxName: lifecycle.runtime.tmuxName ?? "",
    role: lifecycle.session.kind === "orchestrator" ? "orchestrator" : "",
  };
}

export function cloneLifecycle(lifecycle: CanonicalSessionLifecycle): CanonicalSessionLifecycle {
  return {
    version: 2,
    session: { ...lifecycle.session },
    pr: { ...lifecycle.pr },
    runtime: {
      ...lifecycle.runtime,
      handle: lifecycle.runtime.handle
        ? {
            id: lifecycle.runtime.handle.id,
            runtimeName: lifecycle.runtime.handle.runtimeName,
            data: structuredClone(lifecycle.runtime.handle.data),
          }
        : null,
    },
  };
}
