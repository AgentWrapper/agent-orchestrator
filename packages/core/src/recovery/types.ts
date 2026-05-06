/**
 * Recovery Types — Session classification and recovery result types.
 *
 * Part of the orchestrator recovery automation system (Issue #356).
 * These types define how sessions are classified and what actions are taken.
 */

import type { SessionId, SessionStatus, Session, RuntimeHandle, ActivityState } from "../types.js";

/**
 * Classification of a session's recoverability state.
 *
 * - live: Session is running normally, just needs to be re-registered
 * - dead: Runtime is gone, needs cleanup
 * - partial: Some components exist but session is incomplete
 * - unrecoverable: Session is in a terminal state (merged, done) - skip
 */
export type RecoveryClassification = "live" | "dead" | "partial" | "unrecoverable";

/**
 * Action to take for a session during recovery.
 *
 * - recover: Restore session to in-memory state
 * - cleanup: Remove runtime/workspace, archive metadata
 * - escalate: Requires manual intervention
 * - skip: No action needed
 */
export type RecoveryAction = "recover" | "cleanup" | "escalate" | "skip";

/**
 * Assessment of a session's state for recovery purposes.
 */
export interface RecoveryAssessment {
  /** Session ID being assessed */
  sessionId: SessionId;

  /** Project ID this session belongs to */
  projectId: string;

  /** Overall classification */
  classification: RecoveryClassification;

  /** Recommended action */
  action: RecoveryAction;

  /** Human-readable reason for classification */
  reason: string;

  /** Whether the runtime probe itself succeeded */
  runtimeProbeSucceeded: boolean;

  /** Whether the process probe itself succeeded */
  processProbeSucceeded: boolean;

  /** Whether the signals disagree strongly enough to block cleanup */
  signalDisagreement: boolean;

  /** Whether recovery can proceed automatically, needs a human, or should be skipped */
  recoveryRule: "auto" | "human" | "skip";

  // --- Runtime state ---

  /** Whether the runtime (tmux/docker) is alive */
  runtimeAlive: boolean;

  /** Runtime handle if available */
  runtimeHandle: RuntimeHandle | null;

  // --- Workspace state ---

  /** Whether the workspace directory exists */
  workspaceExists: boolean;

  /** Workspace path if known */
  workspacePath: string | null;

  // --- Agent state ---

  /** Whether the agent process appears to be running */
  agentProcessRunning: boolean;

  /** Detected agent activity state */
  agentActivity: ActivityState | null;

  // --- Metadata state ---

  /** Whether metadata file is valid/readable */
  metadataValid: boolean;

  /** Current status from metadata */
  metadataStatus: SessionStatus;

  /** Raw metadata key-value pairs */
  rawMetadata: Record<string, string>;
}

/**
 * Result of attempting to recover a single session.
 */
export interface RecoveryResult {
  /** Whether the operation succeeded */
  success: boolean;

  /** Session ID that was processed */
  sessionId: SessionId;

  /** Action that was taken */
  action: RecoveryAction;

  /** Recovered session object (only for 'recover' action) */
  session?: Session;

  /** Whether manual intervention is required */
  requiresManualIntervention?: boolean;

  reason?: string;

  /** Error message if operation failed */
  error?: string;
}

/**
 * Summary report of a recovery operation.
 */
export interface RecoveryReport {
  /** When the recovery was run */
  timestamp: Date;

  /** Total sessions scanned */
  totalScanned: number;

  /** Sessions that were recovered (live, restored to memory) */
  recovered: SessionId[];

  /** Sessions that were cleaned up (dead, resources removed) */
  cleanedUp: SessionId[];

  /** Sessions that require manual intervention */
  escalated: SessionId[];

  /** Sessions that were skipped (no action needed) */
  skipped: SessionId[];

  /** Errors encountered during recovery */
  errors: Array<{ sessionId: SessionId; error: string }>;

  /** Time taken for recovery in milliseconds */
  durationMs: number;
}

/**
 * Entry in the recovery log.
 */
export interface RecoveryLogEntry {
  /** ISO timestamp */
  timestamp: string;

  /** Session ID */
  sessionId: SessionId;

  /** Action taken */
  action: "recovered" | "cleaned_up" | "escalated" | "skipped" | "error";

  /** Previous status (for recovered sessions) */
  previousStatus?: SessionStatus;

  /** Reason for action (for cleanup/escalate) */
  reason?: string;

  /** Error message (for error action) */
  error?: string;

  /** Additional details */
  details?: Record<string, unknown>;
}

/**
 * Configuration for recovery behavior.
 */
export interface RecoveryConfig {
  /** Enable automatic recovery on orchestrator startup */
  enabled: boolean;

  /** Maximum time for recovery phase in milliseconds */
  timeoutMs: number;

  /** Number of concurrent validation tasks */
  parallelValidation: number;

  /** Path to recovery log file */
  logPath: string;

  /** Automatically cleanup dead sessions */
  autoCleanup: boolean;

  /** Escalate partial sessions (vs. auto-cleanup) */
  escalatePartial: boolean;

  /** Maximum recovery attempts before escalating */
  maxRecoveryAttempts: number;
}

/**
 * Default recovery configuration.
 */
export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  enabled: true,
  timeoutMs: 30_000,
  parallelValidation: 5,
  logPath: "", // Will be set to ~/.agent-orchestrator/recovery.log
  autoCleanup: true,
  escalatePartial: true,
  maxRecoveryAttempts: 3,
};

/**
 * Context passed to recovery functions.
 */
export interface RecoveryContext {
  /** Root config path for the orchestrator */
  configPath: string;

  /** Recovery configuration */
  recoveryConfig: RecoveryConfig;

  /** Whether this is a dry run (no actual changes) */
  dryRun: boolean;

  /**
   * Invoked after every metadata mutation performed by recovery actions
   * (recover/cleanup/escalate). Callers that rely on SessionManager's
   * listCached() cache should pass `sessionManager.invalidateCache` here
   * so the dashboard sees recovery results immediately instead of waiting
   * for the 35s TTL. Optional — omitted callers get a no-op.
   */
  invalidateCache?: () => void;
}
