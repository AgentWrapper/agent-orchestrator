import { recordActivityEvent, type ActivityEventKind } from "./activity-events.js";
import { createCorrelationId, type ProjectObserver } from "./observability.js";
import type { OrchestratorEvent } from "./types.js";

export type NotificationDeliveryMethod = "notify" | "notifyWithActions";
export type NotificationDeliveryFailureKind = "delivery_failed" | "target_missing";

export interface NotificationDeliveryTarget {
  reference: string;
  pluginName: string;
}

export interface RecordNotificationDeliveryInput {
  observer: ProjectObserver;
  event: OrchestratorEvent;
  target: NotificationDeliveryTarget;
  outcome: "success" | "failure";
  method?: NotificationDeliveryMethod;
  reason?: string;
  failureKind?: NotificationDeliveryFailureKind;
  recordActivityEvent?: boolean;
}

const TOKEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]"],
  [/\bsk-(?:ant-)?(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g, "[redacted]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]"],
  [
    /\b([A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|AUTHORIZATION|COOKIE|API_KEY|APIKEY)[A-Z0-9_]*)=([^\s"'`]{6,})/g,
    "$1=[redacted]",
  ],
];

function redactCredentialUrls(input: string): string {
  let result = input;
  let offset = 0;
  while (offset < result.length) {
    const proto = result.indexOf("://", offset);
    if (proto === -1) break;
    if (proto < 4) {
      offset = proto + 3;
      continue;
    }

    const schemeEnd = result.slice(Math.max(0, proto - 5), proto).toLowerCase();
    if (!schemeEnd.endsWith("http") && !schemeEnd.endsWith("https")) {
      offset = proto + 3;
      continue;
    }

    let cursor = proto + 3;
    let redacted = false;
    while (cursor < result.length) {
      const ch = result.charCodeAt(cursor);
      if (ch <= 0x20 || ch === 0x2f) break;
      if (ch === 0x40) {
        result = result.slice(0, proto + 3).toLowerCase() + "[redacted]" + result.slice(cursor);
        offset = proto + 3 + "[redacted]".length + 1;
        redacted = true;
        break;
      }
      cursor++;
    }
    if (!redacted) offset = proto + 3;
  }
  return result;
}

export function sanitizeNotificationDeliveryReason(reason: string): string {
  let cleaned = redactCredentialUrls(reason.replace(/\s+/g, " ").trim());
  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  return cleaned.length > 300 ? `${cleaned.slice(0, 297)}...` : cleaned;
}

function notificationSurface(reference: string): string {
  let suffix = "";
  let lastNonHyphenLength = 0;
  let previousWasGeneratedHyphen = false;

  for (const ch of reference) {
    const code = ch.charCodeAt(0);
    const isAlphaNumeric =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a);
    const isAllowed = isAlphaNumeric || ch === "_" || ch === "-";

    if (!isAllowed) {
      if (suffix.length > 0 && !previousWasGeneratedHyphen) {
        suffix += "-";
        previousWasGeneratedHyphen = true;
      }
      continue;
    }

    if (ch === "-" && suffix.length === 0) {
      continue;
    }

    suffix += ch;
    previousWasGeneratedHyphen = false;
    if (ch !== "-") {
      lastNonHyphenLength = suffix.length;
    }
  }

  suffix = suffix.slice(0, lastNonHyphenLength);
  return `notification.delivery.${suffix || "target"}`;
}

function activityKind(kind: NotificationDeliveryFailureKind): ActivityEventKind {
  return kind === "target_missing" ? "notification.target_missing" : "notification.delivery_failed";
}

function safeRecordActivityFailure(input: RecordNotificationDeliveryInput, reason: string): void {
  if (!input.failureKind) return;
  try {
    recordActivityEvent({
      projectId: input.event.projectId,
      sessionId: input.event.sessionId,
      source: "notifier",
      kind: activityKind(input.failureKind),
      level: "warn",
      summary:
        input.failureKind === "target_missing"
          ? `notification target missing: ${input.target.reference}`
          : `notification delivery failed: ${input.target.reference}`,
      data: {
        eventId: input.event.id,
        eventType: input.event.type,
        priority: input.event.priority,
        targetReference: input.target.reference,
        targetPlugin: input.target.pluginName,
        deliveryMethod: input.method ?? "notify",
        errorMessage: reason,
      },
    });
  } catch {
    // Activity events are diagnostic-only; notification delivery must not depend on them.
  }
}

export function recordNotificationDelivery(input: RecordNotificationDeliveryInput): void {
  const reason = input.reason ? sanitizeNotificationDeliveryReason(input.reason) : undefined;
  const data = {
    eventId: input.event.id,
    eventType: input.event.type,
    priority: input.event.priority,
    targetReference: input.target.reference,
    targetPlugin: input.target.pluginName,
    deliveryMethod: input.method ?? "notify",
  };

  input.observer.recordOperation({
    metric: "notification_delivery",
    operation: "notification.deliver",
    outcome: input.outcome,
    correlationId: createCorrelationId("notification"),
    projectId: input.event.projectId,
    sessionId: input.event.sessionId,
    reason,
    data,
    level: input.outcome === "failure" ? "warn" : "info",
  });

  input.observer.setHealth({
    surface: notificationSurface(input.target.reference),
    status: input.outcome === "failure" ? "warn" : "ok",
    projectId: input.event.projectId,
    correlationId: createCorrelationId("notification-health"),
    reason,
    details: data,
  });

  if (input.outcome === "failure" && input.recordActivityEvent) {
    safeRecordActivityFailure(input, reason ?? "notification delivery failed");
  }
}
