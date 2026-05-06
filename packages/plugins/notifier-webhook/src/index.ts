import {
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
} from "@aoagents/ao-core";
import {
  isRetryableHttpStatus,
  normalizeRetryConfig,
  validateUrl,
} from "@aoagents/ao-core/utils";

export const manifest = {
  name: "webhook",
  slot: "notifier" as const,
  description: "Notifier plugin: generic HTTP webhook",
  version: "0.1.0",
};

interface WebhookPayload {
  type: "notification" | "notification_with_actions" | "message";
  event?: {
    id: string;
    type: string;
    priority: string;
    sessionId: string;
    projectId: string;
    timestamp: string;
    message: string;
    data: Record<string, unknown>;
  };
  actions?: Array<{
    label: string;
    url?: string;
    callbackEndpoint?: string;
  }>;
  message?: string;
  context?: NotifyContext;
}

async function postWithRetry(
  url: string,
  payload: WebhookPayload,
  headers: Record<string, string>,
  retries: number,
  retryDelayMs: number,
): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) return;

      const body = await response.text();
      lastError = new Error(`Webhook POST failed (${response.status}): ${body}`);

      // Only retry on 429 or 5xx — 4xx client errors are permanent
      if (!isRetryableHttpStatus(response.status)) {
        throw lastError;
      }
    } catch (err) {
      if (err === lastError) throw err; // Re-throw non-retryable errors from above
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    if (attempt < retries) {
      // Exponential backoff: delay * 2^attempt
      const delay = retryDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function serializeEvent(event: OrchestratorEvent): WebhookPayload["event"] {
  return {
    id: event.id,
    type: event.type,
    priority: event.priority,
    sessionId: event.sessionId,
    projectId: event.projectId,
    timestamp: event.timestamp.toISOString(),
    message: event.message,
    data: event.data,
  };
}

export function create(config?: Record<string, unknown>): Notifier {
  const url = config?.url as string | undefined;
  const rawHeaders = config?.headers;
  const customHeaders: Record<string, string> = {};
  if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (typeof v === "string") customHeaders[k] = v;
    }
  }
  const { retries, retryDelayMs } = normalizeRetryConfig(config);

  if (!url) {
    console.warn("[notifier-webhook] No url configured — notifications will be no-ops");
  } else {
    validateUrl(url, "notifier-webhook");
  }

  return {
    name: "webhook",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!url) return;

      await postWithRetry(
        url,
        { type: "notification", event: serializeEvent(event) },
        customHeaders,
        retries,
        retryDelayMs,
      );
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!url) return;

      await postWithRetry(
        url,
        {
          type: "notification_with_actions",
          event: serializeEvent(event),
          actions: actions.map((a) => ({
            label: a.label,
            url: a.url,
            callbackEndpoint: a.callbackEndpoint,
          })),
        },
        customHeaders,
        retries,
        retryDelayMs,
      );
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      if (!url) return null;

      await postWithRetry(
        url,
        { type: "message", message, context },
        customHeaders,
        retries,
        retryDelayMs,
      );
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
