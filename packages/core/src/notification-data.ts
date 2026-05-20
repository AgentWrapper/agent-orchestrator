import type {
  CICheck,
  CIStatus,
  EventType,
  PREnrichmentData,
  ReviewDecision,
  SessionId,
  SessionStatus,
} from "./types.js";

export const NOTIFICATION_DATA_SCHEMA_VERSION = 3;

export interface NotificationPRContext {
  url: string;
  title: string | null;
  number: number;
  branch: string;
  baseBranch?: string;
  owner?: string;
  repo?: string;
  isDraft?: boolean;
}

export interface NotificationEventContext {
  pr: NotificationPRContext | null;
  issueId: string | null;
  issueTitle: string | null;
  summary: string | null;
  branch: string | null;
}

export interface NotificationSessionSubject {
  id: SessionId;
  projectId: string;
}

export interface NotificationPRSubject {
  number: number;
  url: string;
  branch?: string;
  title?: string;
  baseBranch?: string;
  owner?: string;
  repo?: string;
  isDraft?: boolean;
}

export interface NotificationIssueSubject {
  id: string;
  title?: string;
}

export interface NotificationSubject {
  session: NotificationSessionSubject;
  pr?: NotificationPRSubject;
  issue?: NotificationIssueSubject;
  summary?: string;
  branch?: string;
}

export interface NotificationTransition {
  kind: "session_status" | "pr_state";
  from: string;
  to: string;
}

export interface NotificationCICheck {
  name: string;
  status: CICheck["status"];
  conclusion?: string;
  url?: string;
}

export interface NotificationCI {
  status: CIStatus;
  failedChecks?: NotificationCICheck[];
}

export interface NotificationReview {
  decision?: ReviewDecision;
  unresolvedThreads?: number;
  url?: string;
}

export interface NotificationMerge {
  ready?: boolean;
  conflicts?: boolean;
  baseBranch?: string;
  isBehind?: boolean;
  blockers?: string[];
}

export interface NotificationReaction {
  key: string;
  action: "notify" | "send-to-agent" | "auto-merge" | "escalated";
}

export interface NotificationEscalation {
  attempts: number;
  cause: "max_retries" | "max_attempts" | "max_duration";
  durationMs?: number;
}

export interface NotificationDataV3 {
  [key: string]: unknown;
  schemaVersion: typeof NOTIFICATION_DATA_SCHEMA_VERSION;
  semanticType?: string;
  subject: NotificationSubject;
  transition?: NotificationTransition;
  ci?: NotificationCI;
  review?: NotificationReview;
  merge?: NotificationMerge;
  reaction?: NotificationReaction;
  escalation?: NotificationEscalation;
}

export interface NotificationDataBaseInput {
  sessionId: SessionId;
  projectId: string;
  context: NotificationEventContext;
  semanticType?: string;
}

export interface SessionTransitionNotificationInput extends NotificationDataBaseInput {
  eventType: EventType;
  oldStatus: SessionStatus;
  newStatus: SessionStatus;
  enrichment?: PREnrichmentData;
}

export interface PRStateNotificationInput extends NotificationDataBaseInput {
  eventType: EventType;
  oldPRState: string;
  newPRState: string;
  enrichment?: PREnrichmentData;
}

export interface CIFailureNotificationInput extends NotificationDataBaseInput {
  failedChecks: CICheck[];
}

export interface ReactionNotificationInput extends NotificationDataBaseInput {
  eventType: "reaction.triggered" | "reaction.escalated";
  reactionKey: string;
  action: NotificationReaction["action"];
  enrichment?: PREnrichmentData;
}

export interface ReactionEscalationNotificationInput extends ReactionNotificationInput {
  attempts: number;
  cause: NotificationEscalation["cause"];
  durationMs?: number;
}

const REACTION_SEMANTIC_TYPES: Record<string, string> = {
  "pr-closed": "pr.closed",
  "ci-failed": "ci.failing",
  "changes-requested": "review.changes_requested",
  "bugbot-comments": "automated_review.found",
  "merge-conflicts": "merge.conflicts",
  "approved-and-green": "merge.ready",
  "agent-stuck": "session.stuck",
  "agent-needs-input": "session.needs_input",
  "agent-exited": "session.killed",
  "all-complete": "summary.all_complete",
  "report-no-acknowledge": "report.no_acknowledge",
  "report-stale": "report.stale",
  "report-needs-input": "report.needs_input",
};

function maybeString(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function serializeCheck(check: CICheck): NotificationCICheck {
  const conclusion = maybeString(check.conclusion);
  const url = maybeString(check.url);
  return {
    name: check.name,
    status: check.status,
    ...(conclusion ? { conclusion } : {}),
    ...(url ? { url } : {}),
  };
}

export function semanticTypeForReactionKey(
  reactionKey: string,
  fallback: EventType | string,
): string {
  return REACTION_SEMANTIC_TYPES[reactionKey] ?? fallback;
}

export function buildNotificationSubject(input: NotificationDataBaseInput): NotificationSubject {
  const { context, sessionId, projectId } = input;
  const subject: NotificationSubject = {
    session: { id: sessionId, projectId },
  };

  if (context.pr) {
    const branch = maybeString(context.pr.branch);
    const title = maybeString(context.pr.title);
    const baseBranch = maybeString(context.pr.baseBranch);
    const owner = maybeString(context.pr.owner);
    const repo = maybeString(context.pr.repo);

    subject.pr = {
      number: context.pr.number,
      url: context.pr.url,
      ...(branch ? { branch } : {}),
      ...(title ? { title } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      ...(owner ? { owner } : {}),
      ...(repo ? { repo } : {}),
      ...(typeof context.pr.isDraft === "boolean" ? { isDraft: context.pr.isDraft } : {}),
    };
  }

  const issueId = maybeString(context.issueId);
  if (issueId) {
    const issueTitle = maybeString(context.issueTitle);
    subject.issue = {
      id: issueId,
      ...(issueTitle ? { title: issueTitle } : {}),
    };
  }

  const summary = maybeString(context.summary);
  if (summary) subject.summary = summary;
  const contextBranch = maybeString(context.branch);
  if (contextBranch) subject.branch = contextBranch;

  return subject;
}

function createBaseNotificationData(input: NotificationDataBaseInput): NotificationDataV3 {
  return {
    schemaVersion: NOTIFICATION_DATA_SCHEMA_VERSION,
    ...(maybeString(input.semanticType) ? { semanticType: input.semanticType } : {}),
    subject: buildNotificationSubject(input),
  };
}

function addEnrichment(data: NotificationDataV3, enrichment: PREnrichmentData | undefined): void {
  if (!enrichment) return;

  if (enrichment.ciStatus !== "none") {
    data.ci = { ...(data.ci ?? {}), status: data.ci?.status ?? enrichment.ciStatus };
  }

  if (enrichment.reviewDecision !== "none") {
    data.review = {
      ...(data.review ?? {}),
      decision: data.review?.decision ?? enrichment.reviewDecision,
    };
  }

  if (
    enrichment.mergeable ||
    typeof enrichment.hasConflicts === "boolean" ||
    typeof enrichment.isBehind === "boolean" ||
    (enrichment.blockers?.length ?? 0) > 0
  ) {
    data.merge = {
      ...(data.merge ?? {}),
      ready: data.merge?.ready ?? enrichment.mergeable,
      ...(typeof enrichment.hasConflicts === "boolean"
        ? { conflicts: data.merge?.conflicts ?? enrichment.hasConflicts }
        : {}),
      ...(typeof enrichment.isBehind === "boolean" ? { isBehind: enrichment.isBehind } : {}),
      ...(enrichment.blockers && enrichment.blockers.length > 0
        ? { blockers: enrichment.blockers }
        : {}),
    };
  }
}

function addSemanticDomain(
  data: NotificationDataV3,
  semanticType: string,
  enrichment: PREnrichmentData | undefined,
): void {
  switch (semanticType) {
    case "ci.failing":
      data.ci = { ...(data.ci ?? {}), status: "failing" };
      break;
    case "review.pending":
      data.review = { ...(data.review ?? {}), decision: "pending" };
      break;
    case "review.approved":
      data.review = { ...(data.review ?? {}), decision: "approved" };
      break;
    case "review.changes_requested":
      data.review = { ...(data.review ?? {}), decision: "changes_requested" };
      break;
    case "merge.ready":
      data.merge = {
        ...(data.merge ?? {}),
        ready: true,
        conflicts: enrichment?.hasConflicts ?? false,
        ...(data.subject.pr?.baseBranch ? { baseBranch: data.subject.pr.baseBranch } : {}),
      };
      break;
    case "merge.conflicts":
      data.merge = {
        ...(data.merge ?? {}),
        ready: false,
        conflicts: true,
        ...(data.subject.pr?.baseBranch ? { baseBranch: data.subject.pr.baseBranch } : {}),
      };
      break;
    default:
      break;
  }
}

export function buildSessionTransitionNotificationData(
  input: SessionTransitionNotificationInput,
): NotificationDataV3 {
  const data = createBaseNotificationData({ ...input, semanticType: input.eventType });
  data.transition = {
    kind: "session_status",
    from: input.oldStatus,
    to: input.newStatus,
  };
  addEnrichment(data, input.enrichment);
  addSemanticDomain(data, input.eventType, input.enrichment);
  return data;
}

export function buildPRStateNotificationData(input: PRStateNotificationInput): NotificationDataV3 {
  const data = createBaseNotificationData({ ...input, semanticType: input.eventType });
  data.transition = {
    kind: "pr_state",
    from: input.oldPRState,
    to: input.newPRState,
  };
  addEnrichment(data, input.enrichment);
  addSemanticDomain(data, input.eventType, input.enrichment);
  return data;
}

export function buildCIFailureNotificationData(
  input: CIFailureNotificationInput,
): NotificationDataV3 {
  const data = createBaseNotificationData({ ...input, semanticType: "ci.failing" });
  data.ci = {
    status: "failing",
    failedChecks: input.failedChecks.map(serializeCheck),
  };
  return data;
}

export function buildReactionNotificationData(
  input: ReactionNotificationInput,
): NotificationDataV3 {
  const semanticType = semanticTypeForReactionKey(input.reactionKey, input.eventType);
  const data = createBaseNotificationData({ ...input, semanticType });
  data.reaction = {
    key: input.reactionKey,
    action: input.action,
  };
  addEnrichment(data, input.enrichment);
  addSemanticDomain(data, semanticType, input.enrichment);
  return data;
}

export function buildReactionEscalationNotificationData(
  input: ReactionEscalationNotificationInput,
): NotificationDataV3 {
  const data = buildReactionNotificationData(input);
  data.escalation = {
    attempts: input.attempts,
    cause: input.cause,
    ...(typeof input.durationMs === "number" ? { durationMs: input.durationMs } : {}),
  };
  return data;
}

export function getNotificationDataV3(data: unknown): NotificationDataV3 | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const candidate = data as Partial<NotificationDataV3>;
  if (candidate.schemaVersion !== NOTIFICATION_DATA_SCHEMA_VERSION) return null;
  if (
    !candidate.subject ||
    typeof candidate.subject !== "object" ||
    Array.isArray(candidate.subject)
  ) {
    return null;
  }
  return candidate as NotificationDataV3;
}
