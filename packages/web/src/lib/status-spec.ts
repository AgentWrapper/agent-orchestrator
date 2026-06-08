/**
 * The single mission-control status system.
 *
 * One semantic spectrum maps the canonical lifecycle to a {tone, label}
 * pair used EVERYWHERE a status is shown — the kanban card badge, the
 * sidebar dot, and the session topbar pill. Keeping it in one place is the
 * point: color = meaning, rationed (see DESIGN.md).
 *
 *   working  → orange (breathing) — an agent is alive right now
 *   input    → amber  — needs your input
 *   changes  → amber  — changes requested
 *   fail     → red    — CI failed / stuck / crashed / conflicts
 *   review   → neutral — in review / waiting on a reviewer
 *   ready    → green  — mergeable
 *   merged   → green  — landed
 *   neutral  → gray   — idle / done / terminated
 *
 * Tone is refined from the (tested) attention-level bucket so a card's badge
 * never disagrees with the column it sits in.
 */
import { ACTIVITY_STATE, SESSION_STATUS, CI_STATUS } from "@aoagents/ao-core/types";
import {
  type DashboardSession,
  getAttentionLevel,
  isDashboardSessionTerminated,
} from "@/lib/types";

export type StatusTone =
  | "working"
  | "input"
  | "changes"
  | "fail"
  | "review"
  | "ready"
  | "merged"
  | "neutral";

export interface StatusSpec {
  tone: StatusTone;
  label: string;
  /** The working dot / terminal cursor breathes (CSS-only). */
  breathing: boolean;
}

function spec(tone: StatusTone, label: string, breathing = false): StatusSpec {
  return { tone, label, breathing };
}

export function getStatusSpec(session: DashboardSession): StatusSpec {
  const level = getAttentionLevel(session, "detailed");

  if (level === "done") {
    if (session.pr?.state === "merged" || session.status === "merged") {
      return spec("merged", "Merged");
    }
    if (isDashboardSessionTerminated(session)) return spec("neutral", "Terminated");
    return spec("neutral", "Done");
  }

  if (level === "merge") return spec("ready", "Mergeable");

  if (level === "respond") {
    if (
      session.lifecycle?.sessionState === "stuck" ||
      session.status === SESSION_STATUS.STUCK ||
      session.status === SESSION_STATUS.ERRORED
    ) {
      return spec("fail", "Stuck");
    }
    if (session.activity === ACTIVITY_STATE.EXITED) return spec("fail", "Crashed");
    return spec("input", "Needs input");
  }

  if (level === "review") {
    if (
      session.lifecycle?.prReason === "ci_failing" ||
      session.status === "ci_failed" ||
      session.pr?.ciStatus === CI_STATUS.FAILING
    ) {
      return spec("fail", "CI failed");
    }
    if (
      session.lifecycle?.prReason === "changes_requested" ||
      session.status === "changes_requested" ||
      session.pr?.reviewDecision === "changes_requested"
    ) {
      return spec("changes", "Changes req.");
    }
    if (session.pr && !session.pr.mergeability.noConflicts) return spec("fail", "Conflicts");
    return spec("review", "Needs review");
  }

  if (level === "pending") {
    const threads = session.pr?.unresolvedThreads ?? 0;
    if (threads > 0) return spec("review", `${threads} ${threads === 1 ? "thread" : "threads"}`);
    return spec("review", "Review pending");
  }

  // working
  if (session.activity === ACTIVITY_STATE.IDLE) return spec("neutral", "Idle");
  return spec("working", "Working", true);
}
