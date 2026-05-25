import type { EventPriority, OrchestratorEvent } from "./types.js";
import { getNotificationDataV3, type NotificationDataV3 } from "./notification-data.js";

export type NotificationPresentationCategory =
  | "agent_needs_input"
  | "agent_stuck"
  | "agent_exited"
  | "ci_failing"
  | "review_changes_requested"
  | "merge_ready"
  | "merge_conflicts"
  | "pr_closed"
  | "reaction_escalated"
  | "all_complete"
  | "generic";

export interface NotificationPresentation {
  version: 1;
  category: NotificationPresentationCategory;
  priority: EventPriority;
  title: string;
  body: string;
  details?: string[];
}

const REPORT_LABEL_PATTERN = /\b(Context|Status|Branch|Transition):/gi;
const MAX_TITLE_LENGTH = 80;
const MAX_BODY_LENGTH = 180;
const MAX_DETAIL_LENGTH = 160;

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function cleanText(value: string | undefined, maxLength: number): string | undefined {
  const cleaned = value
    ?.split(/\r?\n/)
    .map((line) => line.replace(REPORT_LABEL_PATTERN, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? truncate(cleaned, maxLength) : undefined;
}

function titleCaseEventType(value: string): string {
  return value
    .split(/[._\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function prLabel(data: NotificationDataV3 | null): string | undefined {
  const number = data?.subject.pr?.number;
  return typeof number === "number" ? `PR #${number}` : undefined;
}

function checkList(checks: Array<{ name: string }> | undefined): string {
  if (!checks || checks.length === 0) return "";
  const names = checks.map((check) => check.name).filter(Boolean);
  const shown = names.slice(0, 3).join(", ");
  const remaining = names.length - 3;
  return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

function semanticType(event: OrchestratorEvent, data: NotificationDataV3 | null): string {
  return data?.semanticType ?? event.type;
}

function categoryFor(event: OrchestratorEvent, data: NotificationDataV3 | null): NotificationPresentationCategory {
  if (event.type === "reaction.escalated") return "reaction_escalated";

  switch (semanticType(event, data)) {
    case "session.needs_input":
      return "agent_needs_input";
    case "session.stuck":
      return "agent_stuck";
    case "session.killed":
    case "session.exited":
    case "session.errored":
      return "agent_exited";
    case "ci.failing":
      return "ci_failing";
    case "review.changes_requested":
      return "review_changes_requested";
    case "merge.ready":
      return "merge_ready";
    case "merge.conflicts":
      return "merge_conflicts";
    case "pr.closed":
      return "pr_closed";
    case "summary.all_complete":
      return "all_complete";
    default:
      return "generic";
  }
}

function presentationCopy(
  category: NotificationPresentationCategory,
  event: OrchestratorEvent,
  data: NotificationDataV3 | null,
): { title: string; body: string } {
  const pr = prLabel(data);

  switch (category) {
    case "agent_needs_input":
      return {
        title: "Agent needs input",
        body: `${event.sessionId} is waiting for input.`,
      };
    case "agent_stuck":
      return {
        title: "Agent may be stuck",
        body: `${event.sessionId} has been inactive and needs attention.`,
      };
    case "agent_exited":
      return {
        title: "Agent exited",
        body: `${event.sessionId} exited before completing its task.`,
      };
    case "ci_failing": {
      const failedChecks = data?.ci?.failedChecks ?? [];
      const count = failedChecks.length;
      const names = checkList(failedChecks);
      return {
        title: pr ? `CI failing on ${pr}` : "CI failing",
        body:
          count > 0
            ? `${count} ${pluralize(count, "check", "checks")} failed${names ? `: ${names}` : ""}.`
            : "CI is failing and needs attention.",
      };
    }
    case "review_changes_requested": {
      const threads = data?.review?.unresolvedThreads;
      return {
        title: pr ? `Changes requested on ${pr}` : "Changes requested",
        body:
          typeof threads === "number" && threads > 0
            ? `${threads} review ${pluralize(threads, "thread", "threads")} need attention.`
            : "Review feedback needs attention.",
      };
    }
    case "merge_ready":
      return {
        title: pr ? `${pr} is ready to merge` : "Pull request is ready to merge",
        body: "Approved and CI is green.",
      };
    case "merge_conflicts":
      return {
        title: pr ? `Merge conflicts on ${pr}` : "Merge conflicts detected",
        body: "Resolve conflicts before merge.",
      };
    case "pr_closed":
      return {
        title: pr ? `${pr} was closed` : "Pull request was closed",
        body: "The pull request was closed before merge.",
      };
    case "reaction_escalated": {
      const reactionKey = data?.reaction?.key;
      const attempts = data?.escalation?.attempts;
      return {
        title: "Reaction escalated",
        body:
          reactionKey && typeof attempts === "number"
            ? `${reactionKey} escalated after ${attempts} ${pluralize(attempts, "attempt", "attempts")}.`
            : "A reaction needs human attention.",
      };
    }
    case "all_complete":
      return {
        title: "All sessions complete",
        body: `${event.projectId} has no active work requiring attention.`,
      };
    case "generic":
      return {
        title: titleCaseEventType(event.type),
        body: cleanText(event.message, MAX_BODY_LENGTH) ?? `${event.sessionId} needs attention.`,
      };
  }
}

function presentationDetails(event: OrchestratorEvent, data: NotificationDataV3 | null): string[] | undefined {
  const details = [
    data?.subject.pr?.title,
    data?.subject.issue?.id,
    data?.subject.branch,
    event.message,
  ]
    .map((value) => cleanText(value, MAX_DETAIL_LENGTH))
    .filter((value): value is string => Boolean(value));

  return details.length > 0 ? [...new Set(details)] : undefined;
}

export function buildNotificationPresentation(event: OrchestratorEvent): NotificationPresentation {
  const data = getNotificationDataV3(event.data);
  const category = categoryFor(event, data);
  const copy = presentationCopy(category, event, data);
  const title = cleanText(copy.title, MAX_TITLE_LENGTH) ?? "AO notification";
  const body = cleanText(copy.body, MAX_BODY_LENGTH) ?? `${event.sessionId} needs attention.`;
  const details = presentationDetails(event, data);

  return {
    version: 1,
    category,
    priority: event.priority,
    title,
    body,
    ...(details ? { details } : {}),
  };
}

export function isNotificationPresentation(value: unknown): value is NotificationPresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<NotificationPresentation>;
  return (
    candidate.version === 1 &&
    typeof candidate.category === "string" &&
    typeof candidate.priority === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.body === "string" &&
    (candidate.details === undefined ||
      (Array.isArray(candidate.details) &&
        candidate.details.every((detail) => typeof detail === "string")))
  );
}
