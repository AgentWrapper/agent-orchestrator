/**
 * Agent Report — explicit workflow transitions declared by the worker agent.
 *
 * Stage 3 of the state-machine redesign. Agents run `ao acknowledge` and
 * `ao report <state>` from inside a managed session to declare the workflow
 * phase they are entering. The lifecycle manager prefers fresh agent reports
 * over weak inference, but runtime evidence (process death, merged PR) and
 * SCM ground-truth (CI, review decisions) still take precedence.
 *
 * Fallback matrix (highest precedence first):
 *   1. Runtime dead + no recent activity                  → terminated/stuck
 *   2. Agent activity plugin surfaces waiting_input/exited
 *   3. SCM/PR ground truth (merged, closed, CI, reviews)
 *   4. Fresh agent report (this module)
 *   5. Idle-beyond-threshold promotion                    → stuck
 *   6. Default to working
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CanonicalSessionLifecycle,
  CanonicalSessionReason,
  CanonicalSessionState,
  SessionId,
  SessionStatus,
} from "./types.js";
import { mutateMetadata, readMetadataRaw } from "./metadata.js";
import { buildLifecycleMetadataPatch, cloneLifecycle, deriveLegacyStatus, parseCanonicalLifecycle } from "./lifecycle-state.js";
import { parsePrFromUrl } from "./utils/pr.js";
import { assertValidSessionIdComponent } from "./utils/session-id.js";
import { validateStatus } from "./utils/validation.js";

/**
 * Canonical set of states an agent can self-declare.
 *
 * - `started`           — agent has begun the task after planning
 * - `working`           — generic working signal, useful after a pause
 * - `waiting`           — blocked on an external dependency agent cannot unblock
 * - `needs_input`       — blocked on human input
 * - `fixing_ci`         — responding to a failing CI run
 * - `addressing_reviews`— responding to requested review changes
 * - `pr_created` / `draft_pr_created` / `ready_for_review`
 *                       — non-terminal PR workflow events with optional PR metadata
 * - `completed`         — finished research/non-coding work (not "merged")
 *
 * Note: agents cannot self-report `done`, `terminated`, or terminal PR states
 * like `merged` / `closed`. Those remain owned by AO so ground-truth sources
 * (SCM, runtime) stay authoritative.
 */
export const AGENT_REPORTED_STATES = [
  "started",
  "working",
  "waiting",
  "needs_input",
  "fixing_ci",
  "addressing_reviews",
  "pr_created",
  "draft_pr_created",
  "ready_for_review",
  "completed",
] as const;

export type AgentReportedState = (typeof AGENT_REPORTED_STATES)[number];

export interface AgentReport {
  state: AgentReportedState;
  /** ISO 8601 timestamp — when the agent issued the report. */
  timestamp: string;
  /** Optional free-text note the agent may include (e.g. brief status line). */
  note?: string;
  /** Optional PR number attached to PR workflow reports. */
  prNumber?: number;
  /** Optional PR URL attached to PR workflow reports. */
  prUrl?: string;
  /** Optional draft hint attached to PR workflow reports. */
  prIsDraft?: boolean;
  /** Local actor identity when available (e.g. $USER). */
  actor?: string;
  /** Which CLI surface produced this report. */
  source?: "acknowledge" | "report";
}

export interface AgentReportAuditSnapshot {
  legacyStatus: SessionStatus;
  sessionState: CanonicalSessionState;
  sessionReason: CanonicalSessionReason;
  lastTransitionAt: string | null;
}

export interface AgentReportAuditEntry {
  timestamp: string;
  actor: string;
  source: "acknowledge" | "report";
  reportState: AgentReportedState;
  note?: string;
  prNumber?: number;
  prUrl?: string;
  prIsDraft?: boolean;
  accepted: boolean;
  rejectionReason?: string;
  before: AgentReportAuditSnapshot;
  after: AgentReportAuditSnapshot;
}

/** Metadata keys written by `applyAgentReport`. Keep in sync with CLI parsing. */
export const AGENT_REPORT_METADATA_KEYS = {
  STATE: "agentReportedState",
  AT: "agentReportedAt",
  NOTE: "agentReportedNote",
  PR_NUMBER: "agentReportedPrNumber",
  PR_URL: "agentReportedPrUrl",
  PR_IS_DRAFT: "agentReportedPrIsDraft",
} as const;

/** Freshness window — agent reports older than this are ignored. */
export const AGENT_REPORT_FRESHNESS_MS = 300_000; // 5 minutes
export const AGENT_REPORT_CLOCK_SKEW_TOLERANCE_MS = 60_000; // 60 seconds

/**
 * CLI surface accepts these hyphen/underscore aliases for convenience.
 *
 * Note: `done` is intentionally NOT an alias — agents cannot self-report
 * terminal `done` state (AO owns that transition via SCM ground truth). Use
 * `completed` for finished non-coding research/analysis work.
 */
const INPUT_ALIASES: Record<string, AgentReportedState> = {
  start: "started",
  started: "started",
  working: "working",
  work: "working",
  wait: "waiting",
  waiting: "waiting",
  "needs-input": "needs_input",
  needs_input: "needs_input",
  input: "needs_input",
  "fixing-ci": "fixing_ci",
  fixing_ci: "fixing_ci",
  ci: "fixing_ci",
  "addressing-reviews": "addressing_reviews",
  addressing_reviews: "addressing_reviews",
  reviews: "addressing_reviews",
  "pr-created": "pr_created",
  pr_created: "pr_created",
  "draft-pr-created": "draft_pr_created",
  draft_pr_created: "draft_pr_created",
  "ready-for-review": "ready_for_review",
  ready_for_review: "ready_for_review",
  completed: "completed",
  complete: "completed",
};

/** Normalize a user-supplied report name into the canonical form. */
export function normalizeAgentReportedState(input: string): AgentReportedState | null {
  if (!input) return null;
  return INPUT_ALIASES[input.trim().toLowerCase()] ?? null;
}

/** Canonical mapping: AgentReportedState → (canonical session state, reason). */
export function mapAgentReportToLifecycle(state: AgentReportedState): {
  sessionState: CanonicalSessionState;
  sessionReason: CanonicalSessionReason;
} {
  switch (state) {
    case "started":
      return { sessionState: "working", sessionReason: "agent_acknowledged" };
    case "working":
      return { sessionState: "working", sessionReason: "task_in_progress" };
    case "waiting":
      return { sessionState: "idle", sessionReason: "awaiting_external_review" };
    case "needs_input":
      return { sessionState: "needs_input", sessionReason: "awaiting_user_input" };
    case "fixing_ci":
      return { sessionState: "working", sessionReason: "fixing_ci" };
    case "addressing_reviews":
      return { sessionState: "working", sessionReason: "resolving_review_comments" };
    case "pr_created":
      return { sessionState: "idle", sessionReason: "pr_created" };
    case "draft_pr_created":
      return { sessionState: "working", sessionReason: "task_in_progress" };
    case "ready_for_review":
      return { sessionState: "idle", sessionReason: "awaiting_external_review" };
    case "completed":
      return { sessionState: "idle", sessionReason: "research_complete" };
  }
}

function isPRWorkflowReport(state: AgentReportedState): boolean {
  return state === "pr_created" || state === "draft_pr_created" || state === "ready_for_review";
}

export interface AgentReportTransitionResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate whether an agent-issued report is allowed given the current lifecycle.
 *
 * Rules:
 * - Orchestrator sessions cannot accept agent reports (orchestrator sessions
 *   are read-only coordinators).
 * - Terminal states (`done`, `terminated`) cannot be re-opened by an agent.
 * - Merged PRs cannot be re-opened by an agent (`completed`/`working` etc.
 *   attempts are rejected).
 * - Runtime state of `missing`/`exited` means the agent cannot possibly be
 *   reporting — reject so we don't silently contradict runtime truth.
 */
export function validateAgentReportTransition(
  lifecycle: CanonicalSessionLifecycle,
  _next: AgentReportedState,
): AgentReportTransitionResult {
  if (lifecycle.session.kind === "orchestrator") {
    return { ok: false, reason: "orchestrator sessions cannot self-report" };
  }
  if (lifecycle.session.state === "terminated") {
    return { ok: false, reason: "session is terminated" };
  }
  // Terminal states cannot be re-opened by an agent — including `completed`,
  // which maps back to `idle` and would otherwise reanimate a `done` session.
  if (lifecycle.session.state === "done") {
    return { ok: false, reason: "session is already done" };
  }
  if (lifecycle.pr.state === "merged" || lifecycle.pr.state === "closed") {
    return { ok: false, reason: `PR already ${lifecycle.pr.state}` };
  }
  if (lifecycle.runtime.state === "missing" || lifecycle.runtime.state === "exited") {
    return { ok: false, reason: "runtime is not alive" };
  }
  return { ok: true };
}

export interface ApplyAgentReportInput {
  state: AgentReportedState;
  note?: string;
  prNumber?: number;
  prUrl?: string;
  actor?: string;
  source?: "acknowledge" | "report";
  /** Override the current clock — used by tests. */
  now?: Date;
}

export interface ApplyAgentReportResult {
  report: AgentReport;
  legacyStatus: SessionStatus;
  previousState: CanonicalSessionState;
  nextState: CanonicalSessionState;
  auditEntry: AgentReportAuditEntry;
}

function buildAuditDir(dataDir: string): string {
  return join(dataDir, ".agent-report-audit");
}

const AGENT_REPORT_AUDIT_MAX_BYTES = 256 * 1024;
const AGENT_REPORT_AUDIT_MAX_ENTRIES = 200;

function validateAuditSessionId(sessionId: SessionId): void {
  assertValidSessionIdComponent(sessionId);
}

function buildAuditFilePath(dataDir: string, sessionId: SessionId): string {
  validateAuditSessionId(sessionId);
  return join(buildAuditDir(dataDir), `${sessionId}.ndjson`);
}

function normalizeActor(actor: string | undefined): string {
  const trimmed = actor?.trim();
  if (trimmed) return trimmed;
  return "unknown";
}

function buildAuditSnapshot(
  lifecycle: CanonicalSessionLifecycle,
  legacyStatus: SessionStatus,
): AgentReportAuditSnapshot {
  return {
    legacyStatus,
    sessionState: lifecycle.session.state,
    sessionReason: lifecycle.session.reason,
    lastTransitionAt: lifecycle.session.lastTransitionAt,
  };
}

function appendAgentReportAuditEntry(
  dataDir: string,
  sessionId: SessionId,
  entry: AgentReportAuditEntry,
): void {
  const auditDir = buildAuditDir(dataDir);
  mkdirSync(auditDir, { recursive: true });
  const auditFilePath = buildAuditFilePath(dataDir, sessionId);
  const serializedEntry = `${JSON.stringify(entry)}\n`;
  if (existsSync(auditFilePath)) {
    const current = readFileSync(auditFilePath, "utf8");
    let entries = current
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-(AGENT_REPORT_AUDIT_MAX_ENTRIES - 1));
    entries.push(serializedEntry.trimEnd());
    while (
      entries.length > 1 &&
      Buffer.byteLength(`${entries.join("\n")}\n`, "utf8") > AGENT_REPORT_AUDIT_MAX_BYTES
    ) {
      entries = entries.slice(1);
    }
    if (entries.length > AGENT_REPORT_AUDIT_MAX_ENTRIES) {
      entries = entries.slice(-AGENT_REPORT_AUDIT_MAX_ENTRIES);
    }
    if (
      Buffer.byteLength(current, "utf8") + Buffer.byteLength(serializedEntry, "utf8") >=
      AGENT_REPORT_AUDIT_MAX_BYTES
    ) {
      writeFileSync(auditFilePath, `${entries.join("\n")}\n`, "utf8");
      return;
    }
  }
  appendFileSync(auditFilePath, serializedEntry, "utf8");
}

export function readAgentReportAuditTrail(
  dataDir: string,
  sessionId: SessionId,
): AgentReportAuditEntry[] {
  const auditFilePath = buildAuditFilePath(dataDir, sessionId);
  if (!existsSync(auditFilePath)) {
    return [];
  }

  return parseAgentReportAuditTrail(readFileSync(auditFilePath, "utf8"));
}

export async function readAgentReportAuditTrailAsync(
  dataDir: string,
  sessionId: SessionId,
): Promise<AgentReportAuditEntry[]> {
  const auditFilePath = buildAuditFilePath(dataDir, sessionId);
  if (!existsSync(auditFilePath)) {
    return [];
  }

  return parseAgentReportAuditTrail(await readFile(auditFilePath, "utf8"));
}

function parseAgentReportAuditTrail(content: string): AgentReportAuditEntry[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Partial<AgentReportAuditEntry>;
        if (
          typeof parsed.timestamp !== "string" ||
          typeof parsed.actor !== "string" ||
          (parsed.source !== "acknowledge" && parsed.source !== "report") ||
          !AGENT_REPORTED_STATES.includes(parsed.reportState as AgentReportedState) ||
          typeof parsed.accepted !== "boolean" ||
          !parsed.before ||
          !parsed.after
        ) {
          return [];
        }
        return [parsed as AgentReportAuditEntry];
      } catch {
        return [];
      }
    })
    .reverse();
}

/**
 * Apply an agent report to a session: update the canonical lifecycle on disk
 * and persist the report metadata keys. Throws when the transition is rejected.
 *
 * The write is idempotent: applying the same report twice is safe (lifecycle
 * fields are already set, metadata timestamp refreshes).
 */
export function applyAgentReport(
  dataDir: string,
  sessionId: SessionId,
  input: ApplyAgentReportInput,
): ApplyAgentReportResult {
  const raw = readMetadataRaw(dataDir, sessionId);
  if (!raw) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  validateAuditSessionId(sessionId);
  const now = (input.now ?? new Date()).toISOString();
  const source = input.source ?? "report";
  const actor = normalizeActor(input.actor);
  const trimmedNote = input.note?.trim() || undefined;
  const trimmedPrUrl = input.prUrl?.trim() || undefined;
  const parsedPrNumber =
    typeof input.prNumber === "number" && Number.isInteger(input.prNumber) && input.prNumber > 0
      ? input.prNumber
      : undefined;
  const parsedPrFromUrl = trimmedPrUrl ? parsePrFromUrl(trimmedPrUrl) : null;
  const urlPrNumber = parsedPrFromUrl?.number;
  if (
    trimmedPrUrl &&
    parsedPrNumber !== undefined &&
    urlPrNumber !== undefined &&
    parsedPrNumber !== urlPrNumber
  ) {
    throw new Error(`PR number ${parsedPrNumber} does not match PR URL ${trimmedPrUrl}`);
  }
  const inferredPrNumber = urlPrNumber;
  const prNumber = parsedPrNumber ?? inferredPrNumber;
  const prIsDraft =
    input.state === "draft_pr_created"
      ? true
      : input.state === "pr_created" || input.state === "ready_for_review"
        ? false
        : undefined;
  const existingPrUrl = raw[AGENT_REPORT_METADATA_KEYS.PR_URL]?.trim() || undefined;
  const existingPrNumberRaw = raw[AGENT_REPORT_METADATA_KEYS.PR_NUMBER];
  const existingPrNumber =
    existingPrNumberRaw && /^\d+$/.test(existingPrNumberRaw)
      ? Number.parseInt(existingPrNumberRaw, 10)
      : undefined;
  let before: AgentReportAuditSnapshot | null = null;
  let previousState: CanonicalSessionState | null = null;
  let nextState: CanonicalSessionState | null = null;
  let legacyStatus: SessionStatus | null = null;
  let previousLegacyStatus: SessionStatus | null = null;

  const nextMetadata = mutateMetadata(dataDir, sessionId, (existing) => {
    const current = cloneLifecycle(
      parseCanonicalLifecycle(existing, {
        sessionId,
        status: validateStatus(existing["status"]),
      }),
    );
    previousLegacyStatus = deriveLegacyStatus(current);
    before = buildAuditSnapshot(current, previousLegacyStatus);
    const validation = validateAgentReportTransition(current, input.state);
    if (!validation.ok) {
      appendAgentReportAuditEntry(dataDir, sessionId, {
        timestamp: now,
        actor,
        source,
        reportState: input.state,
        note: trimmedNote,
        prNumber,
        prUrl: trimmedPrUrl,
        prIsDraft,
        accepted: false,
        rejectionReason: validation.reason ?? "transition rejected",
        before,
        after: before,
      });
      throw new Error(validation.reason ?? "transition rejected");
    }
    const mapped = mapAgentReportToLifecycle(input.state);
    previousState = current.session.state;
    nextState = mapped.sessionState;
    current.session.state = mapped.sessionState;
    current.session.reason = mapped.sessionReason;
    current.session.lastTransitionAt = now;
    if (isPRWorkflowReport(input.state)) {
      const effectivePrUrl = trimmedPrUrl ?? current.pr.url ?? existingPrUrl;
      const effectivePrNumber =
        prNumber ?? current.pr.number ?? existingPrNumber ?? parsedPrFromUrl?.number;
      const canAdvancePrState =
        effectivePrUrl !== undefined ||
        effectivePrNumber !== undefined ||
        current.pr.state !== "none";
      if (canAdvancePrState) {
        current.pr.state = "open";
        current.pr.reason =
          input.state === "ready_for_review" ? "review_pending" : "in_progress";
        current.pr.lastObservedAt = now;
      }
      if (effectivePrUrl) {
        current.pr.url = effectivePrUrl;
      }
      if (effectivePrNumber !== undefined) {
        current.pr.number = effectivePrNumber;
      }
    }
    if (mapped.sessionState === "working" && current.session.startedAt === null) {
      current.session.startedAt = now;
    }
    legacyStatus = deriveLegacyStatus(current);
    const next = { ...existing };
    Object.assign(
      next,
      buildLifecycleMetadataPatch(current),
      {
        [AGENT_REPORT_METADATA_KEYS.STATE]: input.state,
        [AGENT_REPORT_METADATA_KEYS.AT]: now,
      },
    );
    if (trimmedNote) {
      next[AGENT_REPORT_METADATA_KEYS.NOTE] = trimmedNote;
    } else {
      next[AGENT_REPORT_METADATA_KEYS.NOTE] = "";
    }
    if (isPRWorkflowReport(input.state)) {
      if (trimmedPrUrl) {
        next[AGENT_REPORT_METADATA_KEYS.PR_URL] = trimmedPrUrl;
      }
      if (prNumber !== undefined) {
        next[AGENT_REPORT_METADATA_KEYS.PR_NUMBER] = String(prNumber);
      }
      if (prIsDraft !== undefined) {
        next[AGENT_REPORT_METADATA_KEYS.PR_IS_DRAFT] = prIsDraft ? "true" : "false";
      }
    }
    return next;
  });

  if (!nextMetadata || !before || !previousState || !nextState || !legacyStatus) {
    throw new Error(`Failed to apply agent report for session ${sessionId}`);
  }

  const nextLifecycle = parseCanonicalLifecycle(nextMetadata, {
    sessionId,
    status: validateStatus(nextMetadata["status"]),
  });

  const after = buildAuditSnapshot(nextLifecycle, legacyStatus);
  const auditEntry: AgentReportAuditEntry = {
    timestamp: now,
    actor,
    source,
    reportState: input.state,
    note: trimmedNote,
    prNumber,
    prUrl: trimmedPrUrl,
    prIsDraft,
    accepted: true,
    before,
    after,
  };
  appendAgentReportAuditEntry(dataDir, sessionId, auditEntry);

  return {
    report: {
      state: input.state,
      timestamp: now,
      note: trimmedNote,
      prNumber,
      prUrl: trimmedPrUrl,
      prIsDraft,
      actor,
      source,
    },
    legacyStatus,
    previousState,
    nextState,
    auditEntry,
  };
}

/** Read an agent report out of a session's raw metadata, or null if absent. */
export function readAgentReport(
  meta: Record<string, string> | null | undefined,
): AgentReport | null {
  if (!meta) return null;
  const state = meta[AGENT_REPORT_METADATA_KEYS.STATE];
  const at = meta[AGENT_REPORT_METADATA_KEYS.AT];
  if (!state || !at) return null;
  if (!AGENT_REPORTED_STATES.includes(state as AgentReportedState)) return null;
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return null;
  const note = meta[AGENT_REPORT_METADATA_KEYS.NOTE];
  const rawPrNumber = meta[AGENT_REPORT_METADATA_KEYS.PR_NUMBER];
  const prNumber =
    rawPrNumber && /^\d+$/.test(rawPrNumber) ? Number.parseInt(rawPrNumber, 10) : undefined;
  const prUrl = meta[AGENT_REPORT_METADATA_KEYS.PR_URL] || undefined;
  const rawPrIsDraft = meta[AGENT_REPORT_METADATA_KEYS.PR_IS_DRAFT];
  const prIsDraft = rawPrIsDraft === "true" ? true : rawPrIsDraft === "false" ? false : undefined;
  return {
    state: state as AgentReportedState,
    timestamp: new Date(parsed).toISOString(),
    note: note && note.length > 0 ? note : undefined,
    prNumber,
    prUrl,
    prIsDraft,
  };
}

/**
 * Check whether an agent report is fresh (within the freshness window).
 *
 * Future timestamps (clock skew, malformed input) are rejected — otherwise a
 * single skewed `agentReportedAt` could appear "fresh" indefinitely and
 * override stronger inference signals.
 */
export function isAgentReportFresh(
  report: AgentReport,
  now: Date = new Date(),
  windowMs: number = AGENT_REPORT_FRESHNESS_MS,
  clockSkewToleranceMs: number = AGENT_REPORT_CLOCK_SKEW_TOLERANCE_MS,
): boolean {
  const reportedAt = Date.parse(report.timestamp);
  if (Number.isNaN(reportedAt)) return false;
  const currentTime = now.getTime();
  if (reportedAt > currentTime + clockSkewToleranceMs) return false;
  return currentTime - reportedAt <= windowMs;
}
