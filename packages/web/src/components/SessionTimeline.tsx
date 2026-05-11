"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DashboardActivityEvent,
  DashboardAgentReportAuditEntry,
  DashboardSession,
  DashboardTimelineCategory,
  DashboardTimelineEvent,
} from "@/lib/types";

const TIMELINE_LIMIT = 80;
/** Matches dashboard SSE refresh cadence so the timeline stays in sync with session state. */
const TIMELINE_REFRESH_MS = 5000;

const FILTERS: Array<{ value: "all" | DashboardTimelineCategory; label: string }> = [
  { value: "all", label: "All" },
  { value: "lifecycle", label: "Lifecycle" },
  { value: "agent_report", label: "Reports" },
  { value: "pr", label: "PR/CI" },
  { value: "reaction", label: "Reactions" },
  { value: "runtime", label: "Runtime" },
  { value: "user_action", label: "Actions" },
  { value: "error", label: "Errors" },
  { value: "other", label: "Other" },
];

function categoryForActivityEvent(event: DashboardActivityEvent): DashboardTimelineCategory {
  if (event.level === "error" || event.kind.includes("failed")) {
    return "error";
  }
  if (event.source === "runtime" || event.kind.startsWith("runtime.")) return "runtime";
  if (event.source === "reaction" || event.kind.startsWith("reaction.")) return "reaction";
  if (
    event.source === "api" ||
    event.source === "ui" ||
    event.kind === "session.killed" ||
    event.kind === "session.spawn_started" ||
    event.kind === "session.spawned"
  ) {
    return "user_action";
  }
  if (
    event.source === "scm" ||
    event.kind.startsWith("ci.") ||
    event.kind.startsWith("review.") ||
    event.kind.startsWith("scm.") ||
    event.kind.includes("pr")
  ) {
    return "pr";
  }
  if (
    event.source === "lifecycle" ||
    event.kind.startsWith("lifecycle.") ||
    event.kind.startsWith("detecting.")
  ) {
    return "lifecycle";
  }
  return "other";
}

function humanizeToken(value: string): string {
  return value.replace(/[._-]/g, " ");
}

function formatRelativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return iso;
  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function eventDetail(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const statusTransition =
    typeof record["fromStatus"] === "string" && typeof record["toStatus"] === "string"
      ? `${record["fromStatus"]} -> ${record["toStatus"]}`
      : null;
  const candidates = [
    record["errorMessage"],
    record["reason"],
    statusTransition,
    record["reactionKey"],
    record["prNumber"] ? `PR #${String(record["prNumber"])}` : null,
  ];
  const detail = candidates.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return detail ?? null;
}

function activityEventToTimeline(event: DashboardActivityEvent): DashboardTimelineEvent {
  return {
    id: `activity-${event.id}`,
    timestamp: event.ts,
    category: categoryForActivityEvent(event),
    level: event.level,
    source: event.source,
    title: event.summary || humanizeToken(event.kind),
    detail: eventDetail(event.data),
  };
}

function reportEventToTimeline(
  entry: DashboardAgentReportAuditEntry,
  index: number,
): DashboardTimelineEvent {
  const transition =
    entry.before.sessionState === entry.after.sessionState
      ? humanizeToken(entry.after.sessionState)
      : `${humanizeToken(entry.before.sessionState)} -> ${humanizeToken(entry.after.sessionState)}`;
  return {
    id: `agent-report-${entry.timestamp}-${index}`,
    timestamp: entry.timestamp,
    category: "agent_report",
    level: entry.accepted ? "info" : "warn",
    source: entry.source,
    title: entry.accepted
      ? `Agent reported ${humanizeToken(entry.reportState)}`
      : `Rejected agent report ${humanizeToken(entry.reportState)}`,
    detail: entry.rejectionReason ?? entry.note ?? transition,
  };
}

function mergeTimelineEvents(
  activityEvents: DashboardActivityEvent[],
  auditTrail: DashboardAgentReportAuditEntry[],
): DashboardTimelineEvent[] {
  return [
    ...activityEvents.map(activityEventToTimeline),
    ...auditTrail.map(reportEventToTimeline),
  ].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

export function SessionTimeline({ session }: { session: DashboardSession }) {
  const [activityEvents, setActivityEvents] = useState<DashboardActivityEvent[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [filter, setFilter] = useState<"all" | DashboardTimelineCategory>("all");
  /** Bumped on each fetch start so slower overlapping polls cannot overwrite newer results. */
  const fetchGenerationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const url = `/api/sessions/${encodeURIComponent(session.id)}/events?limit=${TIMELINE_LIMIT}`;

    const load = (isInitial: boolean) => {
      const generation = ++fetchGenerationRef.current;
      if (isInitial) setLoadState("loading");
      void fetch(url, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return (await response.json()) as { events?: DashboardActivityEvent[] };
        })
        .then((payload) => {
          if (cancelled || generation !== fetchGenerationRef.current) return;
          setActivityEvents(Array.isArray(payload.events) ? payload.events : []);
          setLoadState("ready");
        })
        .catch(() => {
          if (cancelled || generation !== fetchGenerationRef.current) return;
          if (isInitial) {
            setActivityEvents([]);
            setLoadState("error");
          }
        });
    };

    load(true);
    const intervalId = window.setInterval(() => load(false), TIMELINE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [session.id]);

  const timelineEvents = useMemo(
    () => mergeTimelineEvents(activityEvents, session.agentReportAudit ?? []),
    [activityEvents, session.agentReportAudit],
  );
  const visibleEvents = useMemo(
    () =>
      filter === "all"
        ? timelineEvents
        : timelineEvents.filter((event) => event.category === filter),
    [filter, timelineEvents],
  );

  const statusText =
    loadState === "loading"
      ? "Loading timeline"
      : loadState === "error"
        ? "Activity events unavailable"
        : `${timelineEvents.length} timeline event${timelineEvents.length === 1 ? "" : "s"}`;

  return (
    <section className="session-timeline" aria-label="Session timeline">
      <div className="session-timeline__header">
        <div>
          <h2 className="session-timeline__title">Timeline</h2>
          <p className="session-timeline__status">{statusText}</p>
        </div>
        <div className="session-timeline__filters" aria-label="Timeline filters">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={
                item.value === filter
                  ? "session-timeline__filter session-timeline__filter--active"
                  : "session-timeline__filter"
              }
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="session-timeline__body">
        {visibleEvents.length === 0 ? (
          <p className="session-timeline__empty">
            {loadState === "loading" ? "Loading recent session activity..." : "No timeline events."}
          </p>
        ) : (
          <ol className="session-timeline__list">
            {visibleEvents.map((event) => (
              <li
                key={event.id}
                className={`session-timeline__item session-timeline__item--${event.category}`}
              >
                <div className="session-timeline__marker" aria-hidden="true" />
                <div className="session-timeline__content">
                  <div className="session-timeline__row">
                    <span className="session-timeline__event-title">{event.title}</span>
                    <time className="session-timeline__time" dateTime={event.timestamp}>
                      {formatRelativeTime(event.timestamp)}
                    </time>
                  </div>
                  <div className="session-timeline__meta">
                    <span>{humanizeToken(event.category)}</span>
                    <span>{event.source}</span>
                    <span>{event.level}</span>
                  </div>
                  {event.detail ? <p className="session-timeline__detail">{event.detail}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
