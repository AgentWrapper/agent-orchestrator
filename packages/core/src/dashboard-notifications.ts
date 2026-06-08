import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NotifyAction, OrchestratorEvent } from "./types.js";
import type { NotificationDataV3 } from "./notification-data.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { getObservabilityBaseDir } from "./paths.js";

export const DEFAULT_DASHBOARD_NOTIFICATION_LIMIT = 50;
export const MAX_DASHBOARD_NOTIFICATION_LIMIT = 500;

export interface LegacyDashboardNotificationData {
  [key: string]: unknown;
}

export type DashboardNotificationEventData = NotificationDataV3 | LegacyDashboardNotificationData;

export interface SerializedDashboardEvent {
  id: string;
  type: string;
  priority: string;
  sessionId: string;
  projectId: string;
  timestamp: string;
  message: string;
  data: DashboardNotificationEventData;
}

export interface SerializedDashboardAction {
  label: string;
  url?: string;
  callbackEndpoint?: string;
}

export interface DashboardNotificationRecord {
  id: string;
  receivedAt: string;
  event: SerializedDashboardEvent;
  actions?: SerializedDashboardAction[];
}

export interface AppendDashboardNotificationOptions {
  limit?: unknown;
  receivedAt?: Date;
}

export function normalizeDashboardNotificationLimit(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number.parseInt(value, 10)
        : DEFAULT_DASHBOARD_NOTIFICATION_LIMIT;

  if (!Number.isFinite(parsed)) return DEFAULT_DASHBOARD_NOTIFICATION_LIMIT;
  return Math.min(MAX_DASHBOARD_NOTIFICATION_LIMIT, Math.max(1, Math.floor(parsed)));
}

export function getDashboardNotificationStorePath(configPath: string): string {
  return join(getObservabilityBaseDir(configPath), "dashboard-notifications.jsonl");
}

function toJsonRecord(value: unknown): DashboardNotificationEventData {
  try {
    const serialized = JSON.parse(JSON.stringify(value ?? {})) as unknown;
    if (serialized && typeof serialized === "object" && !Array.isArray(serialized)) {
      return serialized as DashboardNotificationEventData;
    }
  } catch {
    // Fall through to a small marker below. Notifications should not fail
    // because one event payload contained a non-serializable value.
  }

  return { serializationError: "event data could not be serialized" };
}

function serializeAction(action: NotifyAction): SerializedDashboardAction {
  return {
    label: action.label,
    ...(typeof action.url === "string" ? { url: action.url } : {}),
    ...(typeof action.callbackEndpoint === "string"
      ? { callbackEndpoint: action.callbackEndpoint }
      : {}),
  };
}

export function createDashboardNotificationRecord(
  event: OrchestratorEvent,
  actions?: NotifyAction[],
  receivedAt = new Date(),
): DashboardNotificationRecord {
  const receivedAtIso = receivedAt.toISOString();
  return {
    id: `${event.id}:${receivedAtIso}`,
    receivedAt: receivedAtIso,
    event: {
      id: event.id,
      type: event.type,
      priority: event.priority,
      sessionId: event.sessionId,
      projectId: event.projectId,
      timestamp: event.timestamp.toISOString(),
      message: event.message,
      data: toJsonRecord(event.data),
    },
    ...(actions && actions.length > 0 ? { actions: actions.map(serializeAction) } : {}),
  };
}

function isDashboardNotificationRecord(value: unknown): value is DashboardNotificationRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DashboardNotificationRecord>;
  const event = candidate.event as Partial<SerializedDashboardEvent> | undefined;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.receivedAt === "string" &&
    event !== undefined &&
    typeof event.id === "string" &&
    typeof event.type === "string" &&
    typeof event.priority === "string" &&
    typeof event.sessionId === "string" &&
    typeof event.projectId === "string" &&
    typeof event.timestamp === "string" &&
    typeof event.message === "string" &&
    event.data !== undefined &&
    typeof event.data === "object" &&
    !Array.isArray(event.data)
  );
}

export function readDashboardNotificationsFromFile(
  filePath: string,
  limit: unknown = DEFAULT_DASHBOARD_NOTIFICATION_LIMIT,
): DashboardNotificationRecord[] {
  if (!existsSync(filePath)) return [];

  const normalizedLimit = normalizeDashboardNotificationLimit(limit);
  const content = readFileSync(filePath, "utf-8");
  const records: DashboardNotificationRecord[] = [];

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isDashboardNotificationRecord(parsed)) {
        records.push(parsed);
      }
    } catch {
      // Ignore malformed lines. A partial write should not break the dashboard.
    }
  }

  return records.slice(-normalizedLimit);
}

export function readDashboardNotifications(
  configPath: string,
  limit: unknown = DEFAULT_DASHBOARD_NOTIFICATION_LIMIT,
): DashboardNotificationRecord[] {
  return readDashboardNotificationsFromFile(getDashboardNotificationStorePath(configPath), limit);
}

export function writeDashboardNotificationsToFile(
  filePath: string,
  records: DashboardNotificationRecord[],
  limit: unknown = DEFAULT_DASHBOARD_NOTIFICATION_LIMIT,
): void {
  const normalizedLimit = normalizeDashboardNotificationLimit(limit);
  const retained = records.slice(-normalizedLimit);
  mkdirSync(dirname(filePath), { recursive: true });
  const content =
    retained.length > 0 ? `${retained.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
  atomicWriteFileSync(filePath, content);
}

export function appendDashboardNotificationRecord(
  filePath: string,
  record: DashboardNotificationRecord,
  limit: unknown = DEFAULT_DASHBOARD_NOTIFICATION_LIMIT,
): DashboardNotificationRecord {
  const existing = readDashboardNotificationsFromFile(filePath, limit);
  writeDashboardNotificationsToFile(filePath, [...existing, record], limit);
  return record;
}

export function appendDashboardNotification(
  configPath: string,
  event: OrchestratorEvent,
  actions?: NotifyAction[],
  options: AppendDashboardNotificationOptions = {},
): DashboardNotificationRecord {
  const record = createDashboardNotificationRecord(event, actions, options.receivedAt);
  return appendDashboardNotificationRecord(
    getDashboardNotificationStorePath(configPath),
    record,
    options.limit,
  );
}
