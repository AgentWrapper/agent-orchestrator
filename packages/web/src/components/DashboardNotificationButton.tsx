"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { DashboardNotificationRecord } from "@/lib/mux-protocol";
import { projectSessionPath } from "@/lib/routes";
import { useMuxOptional } from "@/providers/MuxProvider";

const READ_STORAGE_KEY = "ao.dashboard.notifications.read.v1";

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

function stringData(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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
  const { event } = notification;
  const type = normalizeEventText(event.type);
  const message = normalizeEventText(event.message);

  if (
    type === "summary.all-complete" ||
    type.includes("all-complete") ||
    message.includes("all-complete")
  ) {
    return "all complete";
  }

  if (
    type === "merge.ready" ||
    type === "review.approved" ||
    type.includes("approved") ||
    type.includes("merge-ready") ||
    message.includes("approved-and-green") ||
    message.includes("ready-to-merge")
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
  const prUrl = stringData(event.data, "prUrl");
  const reviewUrl = stringData(event.data, "reviewUrl");
  const successLabel = successNotificationLabel(notification);
  const label = successLabel ?? event.priority;
  const urlActions = (notification.actions ?? []).filter(
    (action): action is { label: string; url: string } =>
      typeof action.url === "string" && action.url.trim().length > 0,
  );

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
    <div ref={rootRef} className="dashboard-notification-wrap" onMouseEnter={() => setOpen(true)}>
      <button
        type="button"
        className={`dashboard-app-btn dashboard-notification-btn${open ? " dashboard-notification-btn--open" : ""}`}
        aria-label="Notifications"
        aria-expanded={open}
        onFocus={() => setOpen(true)}
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
