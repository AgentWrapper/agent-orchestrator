/**
 * Lifecycle Transition Service
 *
 * Centralizes all lifecycle state mutations behind a single boundary.
 * This module ensures:
 * - Consistent timestamp handling
 * - Before/after state capture for observability
 * - Atomic metadata persistence
 * - Validation before mutation
 *
 * All lifecycle changes (from polling, agent reports, spawn, kill) should
 * flow through this module.
 */

import type {
  CanonicalSessionLifecycle,
  CanonicalSessionReason,
  CanonicalSessionState,
  SessionId,
  SessionStatus,
} from "./types.js";
import { cloneLifecycle, deriveLegacyStatus } from "./lifecycle-state.js";
import { updateMetadata, readMetadataRaw, readCanonicalLifecycle } from "./metadata.js";
import type { LifecycleDecision } from "./lifecycle-status-decisions.js";

/**
 * Source of the lifecycle transition — used for audit and observability.
 */
export type TransitionSource =
  | "poll" // Lifecycle manager polling
  | "agent_report" // Agent self-report (ao acknowledge, ao report)
  | "spawn" // Session spawn
  | "restore" // Session restore
  | "kill" // Manual kill
  | "cleanup" // Session cleanup
  | "claim_pr"; // PR claim

/**
 * Result of a lifecycle transition attempt.
 */
export interface TransitionResult {
  success: boolean;
  /** The previous lifecycle state (before mutation). */
  previousLifecycle: CanonicalSessionLifecycle;
  /** The new lifecycle state (after mutation). */
  nextLifecycle: CanonicalSessionLifecycle;
  /** The previous legacy status. */
  previousStatus: SessionStatus;
  /** The new legacy status. */
  nextStatus: SessionStatus;
  /** ISO timestamp when the transition occurred. */
  transitionedAt: string;
  /** Whether the status actually changed. */
  statusChanged: boolean;
  /** Reason if transition was rejected. */
  rejectionReason?: string;
}

/**
 * Input for applying a lifecycle decision.
 */
export interface ApplyDecisionInput {
  dataDir: string;
  sessionId: SessionId;
  decision: LifecycleDecision;
  /** Additional metadata to persist alongside the lifecycle. */
  additionalMetadata?: Record<string, string>;
  /** Source of the transition for observability. */
  source: TransitionSource;
  /** Override the current time (for testing). */
  now?: Date;
}

/**
 * Apply a lifecycle decision to the in-memory lifecycle object.
 * This mutates the lifecycle in place.
 */
export function applyDecisionToLifecycle(
  lifecycle: CanonicalSessionLifecycle,
  decision: LifecycleDecision,
  nowIso: string,
): void {
  // Apply PR state if present
  if (decision.prState) {
    lifecycle.pr.state = decision.prState;
    lifecycle.pr.lastObservedAt = nowIso;
  }
  if (decision.prReason) {
    lifecycle.pr.reason = decision.prReason;
  }

  // Apply session state if present
  if (decision.sessionState && decision.sessionReason) {
    lifecycle.session.state = decision.sessionState;
    lifecycle.session.reason = decision.sessionReason;
    lifecycle.session.lastTransitionAt = nowIso;

    // Handle special timestamp fields (only set if not already set)
    if (decision.sessionState === "working" && lifecycle.session.startedAt === null) {
      lifecycle.session.startedAt = nowIso;
    }
    if (decision.sessionState === "done" && lifecycle.session.completedAt === null) {
      lifecycle.session.completedAt = nowIso;
    }
    if (decision.sessionState === "terminated" && lifecycle.session.terminatedAt === null) {
      lifecycle.session.terminatedAt = nowIso;
    }
  }
}

/**
 * Build the full metadata patch for a lifecycle poll transition.
 * Unlike buildLifecycleMetadataPatch(), this includes detecting metadata
 * (attempts, startedAt, evidenceHash) and lifecycle evidence from the decision.
 * Used exclusively by the lifecycle manager polling loop.
 */
export function buildTransitionMetadataPatch(
  lifecycle: CanonicalSessionLifecycle,
  decision: LifecycleDecision,
): Record<string, string> {
  const patch: Record<string, string> = {
    lifecycle: JSON.stringify(lifecycle),
    // status is NOT persisted — computed on read via deriveLegacyStatus()
  };

  // Include lifecycle evidence
  if (decision.evidence) {
    patch["lifecycleEvidence"] = decision.evidence;
  }

  // Include detecting metadata
  if (decision.detecting.attempts > 0) {
    patch["detectingAttempts"] = String(decision.detecting.attempts);
  } else {
    patch["detectingAttempts"] = "";
  }

  if (decision.detecting.startedAt) {
    patch["detectingStartedAt"] = decision.detecting.startedAt;
  } else {
    patch["detectingStartedAt"] = "";
  }

  if (decision.detecting.evidenceHash) {
    patch["detectingEvidenceHash"] = decision.detecting.evidenceHash;
  } else {
    patch["detectingEvidenceHash"] = "";
  }

  patch["pr"] = lifecycle.pr.url ?? "";

  patch["runtimeHandle"] = lifecycle.runtime.handle ? JSON.stringify(lifecycle.runtime.handle) : "";
  patch["tmuxName"] = lifecycle.runtime.tmuxName ?? "";

  patch["role"] = lifecycle.session.kind === "orchestrator" ? "orchestrator" : "";

  return patch;
}

/**
 * Apply a lifecycle decision and persist to metadata.
 *
 * This is the primary entry point for lifecycle mutations. It:
 * 1. Reads the current lifecycle state
 * 2. Validates the transition (if applicable)
 * 3. Applies the decision to the lifecycle
 * 4. Persists the updated lifecycle and metadata
 * 5. Returns before/after state for observability
 */
export function applyLifecycleDecision(
  input: ApplyDecisionInput,
): TransitionResult {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  // Read current state
  const rawMeta = readMetadataRaw(input.dataDir, input.sessionId);
  if (!rawMeta) {
    const emptyLifecycle = createEmptyLifecycle();
    return {
      success: false,
      previousLifecycle: emptyLifecycle,
      nextLifecycle: emptyLifecycle,
      previousStatus: "working",
      nextStatus: "working",
      transitionedAt: nowIso,
      statusChanged: false,
      rejectionReason: `Session not found: ${input.sessionId}`,
    };
  }

  const currentLifecycle = readCanonicalLifecycle(input.dataDir, input.sessionId);
  if (!currentLifecycle) {
    const emptyLifecycle = createEmptyLifecycle();
    return {
      success: false,
      previousLifecycle: emptyLifecycle,
      nextLifecycle: emptyLifecycle,
      previousStatus: "working",
      nextStatus: "working",
      transitionedAt: nowIso,
      statusChanged: false,
      rejectionReason: `Failed to read lifecycle for session: ${input.sessionId}`,
    };
  }

  const previousLifecycle = cloneLifecycle(currentLifecycle);
  const previousStatus = deriveLegacyStatus(previousLifecycle);

  // Apply the decision to the lifecycle
  const nextLifecycle = cloneLifecycle(currentLifecycle);
  applyDecisionToLifecycle(nextLifecycle, input.decision, nowIso);

  const nextStatus = deriveLegacyStatus(nextLifecycle);
  const statusChanged = nextStatus !== previousStatus;

  // Build metadata patch, starting with additional metadata (so lifecycle keys take precedence)
  const metadataPatch: Record<string, string> = {};

  // Apply additional metadata first
  if (input.additionalMetadata) {
    for (const [key, value] of Object.entries(input.additionalMetadata)) {
      metadataPatch[key] = value;
    }
  }

  // Apply lifecycle patch second (overwrites any conflicting keys from additionalMetadata)
  const lifecyclePatch = buildTransitionMetadataPatch(
    nextLifecycle,
    input.decision,
  );
  for (const [key, value] of Object.entries(lifecyclePatch)) {
    metadataPatch[key] = value;
  }

  // Persist
  updateMetadata(input.dataDir, input.sessionId, metadataPatch);

  return {
    success: true,
    previousLifecycle,
    nextLifecycle,
    previousStatus,
    nextStatus,
    transitionedAt: nowIso,
    statusChanged,
  };
}

/**
 * Create an empty lifecycle for error cases.
 */
function createEmptyLifecycle(): CanonicalSessionLifecycle {
  return {
    version: 2,
    session: {
      kind: "worker",
      state: "not_started",
      reason: "spawn_requested",
      startedAt: null,
      completedAt: null,
      terminatedAt: null,
      lastTransitionAt: new Date().toISOString(),
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

/**
 * Helper to create a minimal lifecycle decision for direct state updates.
 */
export function createStateTransitionDecision(
  status: SessionStatus,
  state: CanonicalSessionState,
  reason: CanonicalSessionReason,
  evidence: string,
): LifecycleDecision {
  return {
    status,
    evidence,
    detecting: { attempts: 0 },
    sessionState: state,
    sessionReason: reason,
  };
}
