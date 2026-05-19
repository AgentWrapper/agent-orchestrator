"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { DashboardNotificationRecord } from "@/lib/mux-protocol";
import { projectSessionPath } from "@/lib/routes";
import { useMuxOptional } from "@/providers/MuxProvider";

const READ_STORAGE_KEY = "ao.dashboard.notifications.read.v1";
const TRUSTED_EXTERNAL_ORIGINS: Record<string, string> = {
  "github.com": "https://github.com",
  "gitlab.com": "https://gitlab.com",
  "linear.app": "https://linear.app",
};

type NotificationView = "all" | "unread";

function formatRelativeTime(isoDate: string): string {
  const timestamp = new Date(isoDate).getTime();
  if (!Number.isFinite(timestamp)) return "now";

  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return "now";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  return `${Math.floor(hours / 24)}d`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function booleanField(data: Record<string, unknown>, key: string): boolean | null {
  const value = data[key];
  return typeof value === "boolean" ? value : null;
}

function recordField(data: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = data[key];
  return isRecord(value) ? value : null;
}

function notificationDataV3(
  notification: DashboardNotificationRecord,
): Record<string, unknown> | null {
  const data = notification.event.data;
  return isRecord(data) && data.schemaVersion === 3 ? data : null;
}

function getSubjectPR(notification: DashboardNotificationRecord): Record<string, unknown> | null {
  const data = notificationDataV3(notification);
  if (!data) return null;
  const subject = recordField(data, "subject");
  return subject ? recordField(subject, "pr") : null;
}

function getPRUrl(notification: DashboardNotificationRecord): string | null {
  const pr = getSubjectPR(notification);
  return pr ? stringField(pr, "url") : null;
}

function getReviewUrl(notification: DashboardNotificationRecord): string | null {
  const data = notificationDataV3(notification);
  if (!data) return null;
  const review = recordField(data, "review");
  return review ? stringField(review, "url") : null;
}

function normalizeActionText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function canonicalUrl(value: string | null | undefined): string | null {
  const safeHref = safeExternalHref(value);
  if (!safeHref) return null;

  try {
    const url = new URL(safeHref);
    url.hash = "";
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname}${url.search}`;
  } catch {
    return null;
  }
}

function safeExternalHref(value: string | null | undefined): string | null {
  if (!value || value.trim().length === 0) return null;

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return null;

    const origin = TRUSTED_EXTERNAL_ORIGINS[url.hostname.toLowerCase()];
    if (!origin) return null;

    const safePath = url.pathname.split("/").map(encodePathSegment).join("/");
    const safeSearch = new URLSearchParams(url.searchParams).toString();
    return `${origin}${safePath}${safeSearch ? `?${safeSearch}` : ""}`;
  } catch {
    return null;
  }
}

function encodePathSegment(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}

function shouldHideRedundantAction(
  action: { label: string; url: string },
  links: { prUrl: string | null; reviewUrl: string | null },
): boolean {
  const label = normalizeActionText(action.label);
  const actionUrl = canonicalUrl(action.url);
  const prUrl = canonicalUrl(links.prUrl);
  const reviewUrl = canonicalUrl(links.reviewUrl);

  if (label.includes("dashboard")) return true;
  if (prUrl && actionUrl === prUrl) return true;
  if (reviewUrl && actionUrl === reviewUrl) return true;

  return false;
}

function getEscalationCause(notification: DashboardNotificationRecord): string | null {
  const data = notificationDataV3(notification);
  if (!data) return null;
  const escalation = recordField(data, "escalation");
  return escalation ? stringField(escalation, "cause") : null;
}

function priorityClass(priority: string): string {
  if (priority === "urgent") return "dashboard-notification-item--urgent";
  if (priority === "action") return "dashboard-notification-item--action";
  if (priority === "warning") return "dashboard-notification-item--warning";
  return "dashboard-notification-item--info";
}

function normalizeEventText(value: string): string {
  return value.toLowerCase().replace(/[_\s]+/g, "-");
}

function successNotificationLabel(notification: DashboardNotificationRecord): string | null {
  const data = notificationDataV3(notification);
  if (!data) return null;

  const semanticType = stringField(data, "semanticType");
  if (semanticType && normalizeEventText(semanticType) === "summary.all-complete") {
    return "all complete";
  }

  const merge = recordField(data, "merge");
  const review = recordField(data, "review");
  const mergeReady = merge ? booleanField(merge, "ready") : null;
  const reviewDecision = review ? stringField(review, "decision") : null;

  if (
    semanticType === "merge.ready" ||
    semanticType === "review.approved" ||
    mergeReady === true ||
    reviewDecision === "approved"
  ) {
    return "approved";
  }

  return null;
}

function notificationToneClass(notification: DashboardNotificationRecord): string {
  return successNotificationLabel(notification)
    ? "dashboard-notification-item--success"
    : priorityClass(notification.event.priority);
}

function notificationKey(notification: DashboardNotificationRecord): string {
  return `${notification.id}:${notification.receivedAt}`;
}

function readStoredReadIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(READ_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function writeStoredReadIds(readIds: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...readIds]));
  } catch {
    // Read state is a UI convenience. Storage failures should not break the panel.
  }
}

function NotificationItem({
  isRead,
  notification,
  onMarkRead,
  onMarkUnread,
}: {
  isRead: boolean;
  notification: DashboardNotificationRecord;
  onMarkRead: () => void;
  onMarkUnread: () => void;
}) {
  const { event } = notification;
  const sessionHref = projectSessionPath(event.projectId, event.sessionId);
  const prUrl = safeExternalHref(getPRUrl(notification));
  const reviewUrl = safeExternalHref(getReviewUrl(notification));
  const escalationCause = getEscalationCause(notification);
  const successLabel = successNotificationLabel(notification);
  const label = successLabel ?? event.priority;
  const urlActions = (notification.actions ?? [])
    .map((action) => {
      const safeUrl = safeExternalHref(action.url);
      return safeUrl ? { label: action.label, url: safeUrl } : null;
    })
    .filter((action): action is { label: string; url: string } => action !== null)
    .filter((action) => !shouldHideRedundantAction(action, { prUrl, reviewUrl }));

  return (
    <li
      className={`dashboard-notification-item ${notificationToneClass(notification)}${isRead ? " dashboard-notification-item--read" : " dashboard-notification-item--unread"}`}
    >
      <span className="dashboard-notification-item__status-dot" aria-hidden="true" />
      <div className="dashboard-notification-item__content">
        <div className="dashboard-notification-item__topline">
          <span className="dashboard-notification-item__priority">{label}</span>
          <span className="dashboard-notification-item__time">
            {formatRelativeTime(notification.receivedAt)}
          </span>
        </div>
        <p className="dashboard-notification-item__message">{event.message}</p>
        <div className="dashboard-notification-item__meta">
          <span>{event.projectId}</span>
          <span>{event.sessionId}</span>
          {escalationCause ? <span>{escalationCause.replace(/_/g, " ")}</span> : null}
        </div>
        <div className="dashboard-notification-item__links">
          <Link href={sessionHref}>Session</Link>
          {prUrl ? (
            <a href={prUrl} target="_blank" rel="noopener noreferrer">
              PR
            </a>
          ) : null}
          {reviewUrl ? (
            <a href={reviewUrl} target="_blank" rel="noopener noreferrer">
              Review
            </a>
          ) : null}
          {urlActions.map((action) => (
            <a
              key={`${notification.id}:${action.label}:${action.url}`}
              href={action.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {action.label}
            </a>
          ))}
        </div>
      </div>
      <div className="dashboard-notification-item__side">
        <button
          type="button"
          className="dashboard-notification-item__read-btn"
          onClick={isRead ? onMarkUnread : onMarkRead}
        >
          {isRead ? "Mark unread" : "Mark read"}
        </button>
      </div>
    </li>
  );
}

function pruneReadIds(
  readIds: Set<string>,
  notifications: DashboardNotificationRecord[],
): Set<string> {
  const available = new Set(notifications.map(notificationKey));
  return new Set([...readIds].filter((id) => available.has(id)));
}

export function DashboardNotificationButton() {
  const mux = useMuxOptional();
  const notifications = mux?.notifications ?? [];
  const error = mux?.notificationError ?? null;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<NotificationView>("all");
  const [readIds, setReadIds] = useState<Set<string>>(() => readStoredReadIds());
  const rootRef = useRef<HTMLDivElement>(null);
  const unreadCount = useMemo(
    () =>
      notifications.filter((notification) => !readIds.has(notificationKey(notification))).length,
    [notifications, readIds],
  );
  const allRead = notifications.length > 0 && unreadCount === 0;
  const visibleNotifications = useMemo(() => {
    const filtered =
      view === "unread"
        ? notifications.filter((notification) => !readIds.has(notificationKey(notification)))
        : notifications;
    return [...filtered].reverse();
  }, [notifications, readIds, view]);

  useEffect(() => {
    if (notifications.length === 0) return;
    setReadIds((current) => {
      const pruned = pruneReadIds(current, notifications);
      if (pruned.size === current.size) return current;
      writeStoredReadIds(pruned);
      return pruned;
    });
  }, [notifications]);

  const markRead = (notification: DashboardNotificationRecord) => {
    setReadIds((current) => {
      const key = notificationKey(notification);
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      writeStoredReadIds(next);
      return next;
    });
  };

  const markUnread = (notification: DashboardNotificationRecord) => {
    setReadIds((current) => {
      const key = notificationKey(notification);
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      writeStoredReadIds(next);
      return next;
    });
  };

  const markAllRead = () => {
    setReadIds((current) => {
      const next = new Set(current);
      for (const notification of notifications) {
        next.add(notificationKey(notification));
      }
      writeStoredReadIds(next);
      return next;
    });
  };

  const markAllUnread = () => {
    setReadIds((current) => {
      const next = new Set(current);
      for (const notification of notifications) {
        next.delete(notificationKey(notification));
      }
      writeStoredReadIds(next);
      return next;
    });
  };

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="dashboard-notification-wrap">
      <button
        type="button"
        className={`dashboard-app-btn dashboard-notification-btn${open ? " dashboard-notification-btn--open" : ""}`}
        aria-label="Notifications"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unreadCount > 0 ? (
          <span className="dashboard-notification-btn__count">{unreadCount}</span>
        ) : null}
      </button>

      {open ? (
        <div className="dashboard-notification-panel" role="dialog" aria-label="Notifications">
          <div className="dashboard-notification-panel__header">
            <div className="dashboard-notification-panel__title">Notifications</div>
            <div className="dashboard-notification-panel__actions">
              <button
                type="button"
                className="dashboard-notification-panel__mark-all"
                disabled={notifications.length === 0}
                onClick={allRead ? markAllUnread : markAllRead}
              >
                {allRead ? "Mark all unread" : "Mark all read"}
              </button>
            </div>
          </div>
          <div
            className="dashboard-notification-tabs"
            role="tablist"
            aria-label="Notification view"
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === "all"}
              className="dashboard-notification-tab"
              onClick={() => setView("all")}
            >
              All
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "unread"}
              className="dashboard-notification-tab"
              onClick={() => setView("unread")}
            >
              Unread <span>{unreadCount}</span>
            </button>
          </div>
          {error ? <div className="dashboard-notification-panel__error">{error}</div> : null}
          {visibleNotifications.length > 0 ? (
            <ul className="dashboard-notification-list">
              {visibleNotifications.map((notification) => (
                <NotificationItem
                  key={notificationKey(notification)}
                  isRead={readIds.has(notificationKey(notification))}
                  notification={notification}
                  onMarkRead={() => markRead(notification)}
                  onMarkUnread={() => markUnread(notification)}
                />
              ))}
            </ul>
          ) : (
            <div className="dashboard-notification-panel__empty">
              {view === "unread" ? "No unread notifications" : "No notifications yet"}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
