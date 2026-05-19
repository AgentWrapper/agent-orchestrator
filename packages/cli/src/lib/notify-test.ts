import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildCIFailureNotificationData,
  buildPRStateNotificationData,
  buildReactionNotificationData,
  buildSessionTransitionNotificationData,
  createProjectObserver,
  recordNotificationDelivery,
  resolveNotifierTarget,
  type CICheck,
  type EventPriority,
  type EventType,
  type NotificationDataV3,
  type NotificationEventContext,
  type Notifier,
  type NotifyAction,
  type OrchestratorConfig,
  type OrchestratorEvent,
  type PluginRegistry,
} from "@aoagents/ao-core";

export const NOTIFY_TEST_TEMPLATE_NAMES = [
  "basic",
  "agent-stuck",
  "agent-needs-input",
  "agent-exited",
  "ci-failing",
  "review-changes-requested",
  "approved-and-green",
  "merge-ready",
  "all-complete",
  "pr-closed",
] as const;

export type NotifyTestTemplateName = (typeof NOTIFY_TEST_TEMPLATE_NAMES)[number];

const VALID_PRIORITIES = ["urgent", "action", "warning", "info"] as const;

const VALID_EVENT_TYPES = [
  "session.spawn_started",
  "session.spawned",
  "session.working",
  "session.exited",
  "session.killed",
  "session.idle",
  "session.stuck",
  "session.needs_input",
  "session.errored",
  "pr.created",
  "pr.updated",
  "pr.merged",
  "pr.closed",
  "ci.passing",
  "ci.failing",
  "ci.fix_sent",
  "ci.fix_failed",
  "review.pending",
  "review.approved",
  "review.changes_requested",
  "review.comments_sent",
  "review.comments_unresolved",
  "automated_review.found",
  "automated_review.fix_sent",
  "merge.ready",
  "merge.conflicts",
  "merge.completed",
  "reaction.triggered",
  "reaction.escalated",
  "summary.all_complete",
] as const satisfies EventType[];

interface NotifyTemplate {
  type: EventType;
  priority: EventPriority;
  sessionId: string;
  projectId: string;
  message: string;
  data: NotificationDataV3;
}

const DEMO_PR_URL = "https://github.com/ComposioHQ/agent-orchestrator/pull/1579";

const DEMO_PR_CONTEXT: NotificationEventContext = {
  pr: {
    number: 1579,
    url: DEMO_PR_URL,
    title: "Normalize AO notifier payloads",
    branch: "ao/demo-notifier-harness",
    baseBranch: "main",
    owner: "ComposioHQ",
    repo: "agent-orchestrator",
    isDraft: false,
  },
  issueId: "AO-1579",
  issueTitle: "Make AO notification payloads API-grade",
  summary: "Normalize AO notifier payloads",
  branch: "ao/demo-notifier-harness",
};

const DEMO_SYSTEM_CONTEXT: NotificationEventContext = {
  pr: null,
  issueId: null,
  issueTitle: null,
  summary: "AO notification delivery smoke test",
  branch: null,
};

const DEMO_FAILED_CHECKS: CICheck[] = [
  {
    name: "typecheck",
    status: "failed",
    conclusion: "FAILURE",
    url: `${DEMO_PR_URL}/checks?check_run_id=101`,
  },
  {
    name: "unit-tests",
    status: "failed",
    conclusion: "FAILURE",
    url: `${DEMO_PR_URL}/checks?check_run_id=102`,
  },
];

const DEMO_TEMPLATES: Record<NotifyTestTemplateName, NotifyTemplate> = {
  basic: {
    type: "summary.all_complete",
    priority: "info",
    sessionId: "notify-demo",
    projectId: "demo",
    message: "Test notification from ao notify test",
    data: buildReactionNotificationData({
      eventType: "reaction.triggered",
      sessionId: "notify-demo",
      projectId: "demo",
      context: DEMO_SYSTEM_CONTEXT,
      reactionKey: "all-complete",
      action: "notify",
    }),
  },
  "agent-stuck": {
    type: "session.stuck",
    priority: "urgent",
    sessionId: "demo-agent-7",
    projectId: "demo",
    message: "Agent demo-agent-7 appears stuck after repeated inactivity probes",
    data: buildSessionTransitionNotificationData({
      eventType: "session.stuck",
      sessionId: "demo-agent-7",
      projectId: "demo",
      context: DEMO_PR_CONTEXT,
      oldStatus: "working",
      newStatus: "stuck",
    }),
  },
  "agent-needs-input": {
    type: "session.needs_input",
    priority: "action",
    sessionId: "demo-agent-12",
    projectId: "demo",
    message: "Agent demo-agent-12 needs input before it can continue",
    data: buildSessionTransitionNotificationData({
      eventType: "session.needs_input",
      sessionId: "demo-agent-12",
      projectId: "demo",
      context: DEMO_PR_CONTEXT,
      oldStatus: "working",
      newStatus: "needs_input",
    }),
  },
  "agent-exited": {
    type: "session.killed",
    priority: "urgent",
    sessionId: "demo-agent-4",
    projectId: "demo",
    message: "Agent demo-agent-4 exited before completing its task",
    data: buildSessionTransitionNotificationData({
      eventType: "session.killed",
      sessionId: "demo-agent-4",
      projectId: "demo",
      context: DEMO_PR_CONTEXT,
      oldStatus: "working",
      newStatus: "killed",
    }),
  },
  "ci-failing": {
    type: "ci.failing",
    priority: "action",
    sessionId: "demo-agent-19",
    projectId: "demo",
    message: "CI is failing on PR #1579",
    data: buildCIFailureNotificationData({
      sessionId: "demo-agent-19",
      projectId: "demo",
      context: DEMO_PR_CONTEXT,
      failedChecks: DEMO_FAILED_CHECKS,
    }),
  },
  "review-changes-requested": {
    type: "review.changes_requested",
    priority: "action",
    sessionId: "demo-agent-21",
    projectId: "demo",
    message: "Review changes were requested on PR #1579",
    data: (() => {
      const data = buildSessionTransitionNotificationData({
        eventType: "review.changes_requested",
        sessionId: "demo-agent-21",
        projectId: "demo",
        context: DEMO_PR_CONTEXT,
        oldStatus: "review_pending",
        newStatus: "changes_requested",
      });
      data.review = {
        ...(data.review ?? {}),
        decision: "changes_requested",
        unresolvedThreads: 3,
        url: `${DEMO_PR_URL}#pullrequestreview-1`,
      };
      return data;
    })(),
  },
  "approved-and-green": {
    type: "reaction.triggered",
    priority: "info",
    sessionId: "demo-agent-23",
    projectId: "demo",
    message: "PR #1579 is approved and CI is green",
    data: buildReactionNotificationData({
      eventType: "reaction.triggered",
      sessionId: "demo-agent-23",
      projectId: "demo",
      context: DEMO_PR_CONTEXT,
      reactionKey: "approved-and-green",
      action: "notify",
      enrichment: {
        state: "open",
        ciStatus: "passing",
        reviewDecision: "approved",
        mergeable: true,
        title: "Normalize AO notifier payloads",
        hasConflicts: false,
        isBehind: false,
      },
    }),
  },
  "merge-ready": {
    type: "merge.ready",
    priority: "action",
    sessionId: "demo-agent-29",
    projectId: "demo",
    message: "PR #1579 is ready to merge",
    data: buildSessionTransitionNotificationData({
      eventType: "merge.ready",
      sessionId: "demo-agent-29",
      projectId: "demo",
      context: DEMO_PR_CONTEXT,
      oldStatus: "approved",
      newStatus: "mergeable",
      enrichment: {
        state: "open",
        ciStatus: "passing",
        reviewDecision: "approved",
        mergeable: true,
        title: "Normalize AO notifier payloads",
        hasConflicts: false,
        isBehind: false,
      },
    }),
  },
  "all-complete": {
    type: "summary.all_complete",
    priority: "info",
    sessionId: "demo-orchestrator",
    projectId: "demo",
    message: "All demo sessions completed successfully",
    data: buildReactionNotificationData({
      eventType: "reaction.triggered",
      sessionId: "demo-orchestrator",
      projectId: "demo",
      context: DEMO_SYSTEM_CONTEXT,
      reactionKey: "all-complete",
      action: "notify",
    }),
  },
  "pr-closed": {
    type: "pr.closed",
    priority: "warning",
    sessionId: "demo-agent-31",
    projectId: "demo",
    message: "PR #1579 was closed without merge",
    data: buildPRStateNotificationData({
      eventType: "pr.closed",
      sessionId: "demo-agent-31",
      projectId: "demo",
      context: DEMO_PR_CONTEXT,
      oldPRState: "open",
      newPRState: "closed",
    }),
  },
};

export const NOTIFY_TEST_ACTIONS: NotifyAction[] = [
  {
    label: "Open dashboard",
    url: "http://localhost:3000",
  },
  {
    label: "View PR",
    url: "https://github.com/ComposioHQ/agent-orchestrator/pull/1579",
  },
  {
    label: "Acknowledge",
    callbackEndpoint: "http://localhost:3000/api/notifications/demo/ack",
  },
];

export interface NotifyTestRequest {
  templateName?: string;
  to?: string[];
  all?: boolean;
  route?: string;
  actions?: boolean;
  message?: string;
  sessionId?: string;
  projectId?: string;
  priority?: string;
  type?: string;
  data?: Record<string, unknown>;
  dryRun?: boolean;
}

export interface NotifyTestTarget {
  reference: string;
  pluginName: string;
}

export type NotifyDeliveryStatus = "sent" | "dry_run" | "failed" | "unresolved";

export interface NotifyDeliveryResult {
  reference: string;
  pluginName: string;
  status: NotifyDeliveryStatus;
  method: "notify" | "notifyWithActions" | null;
  warning?: string;
  error?: string;
}

export interface NotifyTestResult {
  ok: boolean;
  dryRun: boolean;
  templateName: NotifyTestTemplateName;
  event: OrchestratorEvent;
  actions: NotifyAction[];
  targets: NotifyTestTarget[];
  deliveries: NotifyDeliveryResult[];
  warnings: string[];
  errors: string[];
}

export interface NotifySinkRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: unknown;
}

export interface NotifySinkServer {
  port: number;
  url: string;
  requests: NotifySinkRequest[];
  waitForRequest(timeoutMs?: number): Promise<NotifySinkRequest | null>;
  close(): Promise<void>;
}

export class NotifyTestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NotifyTestError";
    this.code = code;
  }
}

function assertTemplateName(name: string | undefined): NotifyTestTemplateName {
  const candidate = name ?? "basic";
  if (isTemplateName(candidate)) return candidate;
  throw new NotifyTestError(
    "invalid_template",
    `Unknown template "${candidate}". Expected one of: ${NOTIFY_TEST_TEMPLATE_NAMES.join(", ")}`,
  );
}

function isTemplateName(value: string): value is NotifyTestTemplateName {
  return NOTIFY_TEST_TEMPLATE_NAMES.includes(value as NotifyTestTemplateName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function syncNotificationSubject(
  data: Record<string, unknown>,
  sessionId: string,
  projectId: string,
): Record<string, unknown> {
  if (data.schemaVersion !== 3 || !isRecord(data.subject)) return data;

  return {
    ...data,
    subject: {
      ...data.subject,
      session: { id: sessionId, projectId },
    },
  };
}

function assertPriority(priority: string, source: string): EventPriority {
  if ((VALID_PRIORITIES as readonly string[]).includes(priority)) {
    return priority as EventPriority;
  }
  throw new NotifyTestError(
    "invalid_priority",
    `Invalid ${source} "${priority}". Expected one of: ${VALID_PRIORITIES.join(", ")}`,
  );
}

function assertEventType(type: string): EventType {
  if ((VALID_EVENT_TYPES as readonly string[]).includes(type)) {
    return type as EventType;
  }
  throw new NotifyTestError(
    "invalid_event_type",
    `Invalid event type "${type}". Expected one of: ${VALID_EVENT_TYPES.join(", ")}`,
  );
}

function uniqueRefs(refs: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const ref of refs) {
    const normalized = ref.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function refsFromConfiguredAndDefaults(config: OrchestratorConfig): string[] {
  return uniqueRefs([
    ...Object.keys(config.notifiers ?? {}),
    ...(config.defaults?.notifiers ?? []),
  ]);
}

function refsFromAllKnownSources(config: OrchestratorConfig): string[] {
  return uniqueRefs([
    ...Object.keys(config.notifiers ?? {}),
    ...(config.defaults?.notifiers ?? []),
    ...Object.values(config.notificationRouting ?? {}).flat(),
  ]);
}

function refsFromRoute(config: OrchestratorConfig, priority: EventPriority): string[] {
  return uniqueRefs(config.notificationRouting?.[priority] ?? config.defaults?.notifiers ?? []);
}

export function createNotifyTestEvent(request: NotifyTestRequest = {}): {
  templateName: NotifyTestTemplateName;
  event: OrchestratorEvent;
} {
  const templateName = assertTemplateName(request.templateName);
  const template = DEMO_TEMPLATES[templateName];
  const priority = request.priority
    ? assertPriority(request.priority, "priority")
    : template.priority;
  const type = request.type ? assertEventType(request.type) : template.type;
  const sessionId = request.sessionId ?? template.sessionId;
  const projectId = request.projectId ?? template.projectId;
  const data = syncNotificationSubject(
    {
      ...template.data,
      ...(request.data ?? {}),
    },
    sessionId,
    projectId,
  );

  return {
    templateName,
    event: {
      id: `notify-test-${Date.now()}`,
      type,
      priority,
      sessionId,
      projectId,
      timestamp: new Date(),
      message: request.message ?? template.message,
      data,
    },
  };
}

export function resolveNotifyTestTargets(
  config: OrchestratorConfig,
  eventPriority: EventPriority,
  request: NotifyTestRequest = {},
): NotifyTestTarget[] {
  const refs = (() => {
    if (request.to && request.to.length > 0) {
      return uniqueRefs(request.to);
    }
    if (request.all) {
      return refsFromAllKnownSources(config);
    }
    if (request.route) {
      return refsFromRoute(config, assertPriority(request.route, "route"));
    }

    const routedRefs = refsFromRoute(config, eventPriority);
    return routedRefs.length > 0 ? routedRefs : refsFromConfiguredAndDefaults(config);
  })();

  return refs.map((ref) => {
    const target = resolveNotifierTarget(config, ref);
    return {
      reference: target.reference,
      pluginName: target.pluginName,
    };
  });
}

export async function runNotifyTest(
  config: OrchestratorConfig,
  registry: PluginRegistry,
  request: NotifyTestRequest = {},
): Promise<NotifyTestResult> {
  const { templateName, event } = createNotifyTestEvent(request);
  const targets = resolveNotifyTestTargets(config, event.priority, request);
  const actions = request.actions ? [...NOTIFY_TEST_ACTIONS] : [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const deliveries: NotifyDeliveryResult[] = [];
  const observer = request.dryRun ? null : createProjectObserver(config, "notify-test");

  if (targets.length === 0) {
    errors.push(
      "No notifier targets resolved. Configure notifiers or pass --to, --all, or --sink.",
    );
    return {
      ok: false,
      dryRun: Boolean(request.dryRun),
      templateName,
      event,
      actions,
      targets,
      deliveries,
      warnings,
      errors,
    };
  }

  for (const target of targets) {
    const notifier =
      registry.get<Notifier>("notifier", target.reference) ??
      registry.get<Notifier>("notifier", target.pluginName);

    if (!notifier) {
      const error = `${target.reference}: notifier plugin "${target.pluginName}" is not loaded`;
      errors.push(error);
      if (observer) {
        recordNotificationDelivery({
          observer,
          event,
          target,
          outcome: "failure",
          method: "notify",
          reason: "notifier target not found",
          failureKind: "target_missing",
          recordActivityEvent: true,
        });
      }
      deliveries.push({
        reference: target.reference,
        pluginName: target.pluginName,
        status: "unresolved",
        method: null,
        error,
      });
      continue;
    }

    if (request.dryRun) {
      deliveries.push({
        reference: target.reference,
        pluginName: target.pluginName,
        status: "dry_run",
        method: actions.length > 0 && notifier.notifyWithActions ? "notifyWithActions" : "notify",
      });
      continue;
    }

    try {
      const method =
        actions.length > 0 && notifier.notifyWithActions ? "notifyWithActions" : "notify";
      if (actions.length > 0 && notifier.notifyWithActions) {
        await notifier.notifyWithActions(event, actions);
        deliveries.push({
          reference: target.reference,
          pluginName: target.pluginName,
          status: "sent",
          method: "notifyWithActions",
        });
      } else {
        const warning =
          actions.length > 0
            ? `${target.reference}: notifyWithActions() is unavailable; sent with notify()`
            : undefined;
        if (warning) warnings.push(warning);

        await notifier.notify(event);
        deliveries.push({
          reference: target.reference,
          pluginName: target.pluginName,
          status: "sent",
          method: "notify",
          warning,
        });
      }
      if (observer) {
        recordNotificationDelivery({
          observer,
          event,
          target,
          outcome: "success",
          method,
        });
      }
    } catch (err) {
      const error = `${target.reference}: ${err instanceof Error ? err.message : String(err)}`;
      const method =
        actions.length > 0 && notifier.notifyWithActions ? "notifyWithActions" : "notify";
      errors.push(error);
      if (observer) {
        recordNotificationDelivery({
          observer,
          event,
          target,
          outcome: "failure",
          method,
          reason: err instanceof Error ? err.message : String(err),
          failureKind: "delivery_failed",
          recordActivityEvent: true,
        });
      }
      deliveries.push({
        reference: target.reference,
        pluginName: target.pluginName,
        status: "failed",
        method,
        error,
      });
    }
  }

  return {
    ok: errors.length === 0,
    dryRun: Boolean(request.dryRun),
    templateName,
    event,
    actions,
    targets,
    deliveries,
    warnings,
    errors,
  };
}

export function parseNotifyDataJson(
  input: string | undefined,
): Record<string, unknown> | undefined {
  if (!input) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new NotifyTestError("invalid_json", `Invalid --data JSON: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NotifyTestError("invalid_json", "--data must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

export function parseNotifyRefs(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  return uniqueRefs(input.split(","));
}

export function parseSinkPort(input: true | string | undefined): number | undefined {
  if (input === undefined) return undefined;
  if (input === true) return 0;

  const port = Number(input);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new NotifyTestError("invalid_sink_port", `Invalid --sink port "${input}"`);
  }
  return port;
}

export function addSinkNotifierConfig(
  config: OrchestratorConfig,
  sinkUrl: string,
): OrchestratorConfig {
  return {
    ...config,
    defaults: {
      ...config.defaults,
      notifiers: uniqueRefs(["sink", ...(config.defaults?.notifiers ?? [])]),
    },
    notifiers: {
      ...(config.notifiers ?? {}),
      sink: {
        plugin: "webhook",
        url: sinkUrl,
        retries: 0,
      },
    },
  };
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function respond(res: ServerResponse, statusCode: number, body = ""): void {
  res.statusCode = statusCode;
  if (body) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
  }
  res.end(body);
}

export async function startNotifySink(port = 0): Promise<NotifySinkServer> {
  const requests: NotifySinkRequest[] = [];
  const waiters: Array<(request: NotifySinkRequest | null) => void> = [];

  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      respond(res, 405, "method not allowed");
      return;
    }

    const body = await readRequestBody(req);
    const json = (() => {
      try {
        return body ? (JSON.parse(body) as unknown) : null;
      } catch {
        return null;
      }
    })();

    const request: NotifySinkRequest = {
      method: req.method,
      url: req.url ?? "/",
      headers: req.headers,
      body,
      json,
    };

    requests.push(request);
    const pending = waiters.splice(0);
    for (const waiter of pending) waiter(request);
    respond(res, 204);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    requests,
    waitForRequest(timeoutMs = 1000): Promise<NotifySinkRequest | null> {
      if (requests[0]) return Promise.resolve(requests[0]);
      return new Promise((resolve) => {
        const waiter = (request: NotifySinkRequest | null) => {
          clearTimeout(timer);
          resolve(request);
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          resolve(null);
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        closeServer(server, (err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function closeServer(server: Server, callback: (err?: Error) => void): void {
  server.close((err) => callback(err ?? undefined));
}
