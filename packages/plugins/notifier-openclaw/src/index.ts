import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type EventPriority,
  type Notifier,
  type NotifyAction,
  type NotifyContext,
  type OrchestratorEvent,
  type PluginModule,
  getObservabilityBaseDir,
} from "@aoagents/ao-core";
import { isRetryableHttpStatus, normalizeRetryConfig, validateUrl } from "@aoagents/ao-core/utils";

/**
 * Read the hooks token from ~/.openclaw/openclaw.json as a fallback for
 * daemon contexts where the shell profile (and OPENCLAW_HOOKS_TOKEN) isn't
 * sourced. This file is written by `ao setup openclaw` and lives outside
 * the project directory so it's never committed to version control.
 */
function readTokenFromOpenClawConfig(): string | undefined {
  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    if (!existsSync(configPath)) return undefined;
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const token = (config.hooks as Record<string, unknown> | undefined)?.token;
    return typeof token === "string" && token ? token : undefined;
  } catch {
    return undefined;
  }
}

export const manifest = {
  name: "openclaw",
  slot: "notifier" as const,
  description: "Notifier plugin: OpenClaw webhook notifications",
  version: "0.1.0",
};

const DEFAULT_TIMEOUT_MS = 10_000;

type WakeMode = "now" | "next-heartbeat";

interface OpenClawWebhookPayload {
  message: string;
  name?: string;
  sessionKey?: string;
  wakeMode?: WakeMode;
  deliver?: boolean;
}

interface OpenClawHealthSummary {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureError: string | null;
  totalSent: number;
  totalFailed: number;
}

const DEFAULT_HEALTH_SUMMARY: OpenClawHealthSummary = {
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureError: null,
  totalSent: 0,
  totalFailed: 0,
};

function readHealthSummary(path: string): OpenClawHealthSummary {
  try {
    if (!existsSync(path)) return { ...DEFAULT_HEALTH_SUMMARY };
    const raw = readFileSync(path, "utf-8");
    return {
      ...DEFAULT_HEALTH_SUMMARY,
      ...(JSON.parse(raw) as Partial<OpenClawHealthSummary>),
    };
  } catch {
    return { ...DEFAULT_HEALTH_SUMMARY };
  }
}

function writeHealthSummary(path: string, summary: OpenClawHealthSummary): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp.${process.pid}`;
    writeFileSync(tempPath, JSON.stringify(summary, null, 2) + "\n");
    renameSync(tempPath, path);
  } catch {
    // Health telemetry is best-effort and must never block notifications.
  }
}

function getHealthSummaryPath(config?: Record<string, unknown>): string | null {
  const explicitPath =
    typeof config?.healthSummaryPath === "string" ? config.healthSummaryPath : undefined;
  if (explicitPath) return explicitPath;

  const configPath = typeof config?.configPath === "string" ? config.configPath : undefined;
  if (!configPath) return null;
  return join(getObservabilityBaseDir(configPath), "openclaw-health.json");
}

function recordHealthSuccess(path: string | null): void {
  if (!path) return;
  const summary = readHealthSummary(path);
  summary.lastSuccessAt = new Date().toISOString();
  summary.totalSent += 1;
  writeHealthSummary(path, summary);
}

function recordHealthFailure(path: string | null, error: unknown): void {
  if (!path) return;
  const summary = readHealthSummary(path);
  summary.lastFailureAt = new Date().toISOString();
  summary.lastFailureError = error instanceof Error ? error.message : String(error);
  summary.totalFailed += 1;
  writeHealthSummary(path, summary);
}

async function postWithRetry(
  url: string,
  payload: OpenClawWebhookPayload,
  headers: Record<string, string>,
  retries: number,
  retryDelayMs: number,
  context: { sessionId: string },
): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok) return;

      const body = await response.text();

      if (response.status === 401 || response.status === 403) {
        lastError = new Error(
          `OpenClaw rejected the auth token (HTTP ${response.status}).\n` +
            `  Check that hooks.token in your OpenClaw config matches the token configured for AO.\n` +
            `  Reconfigure: ao setup openclaw`,
        );
        throw lastError;
      }

      lastError = new Error(`OpenClaw webhook failed (${response.status}): ${body}`);

      if (!isRetryableHttpStatus(response.status)) {
        throw lastError;
      }

      if (attempt < retries) {
        console.warn(
          `[notifier-openclaw] Retry ${attempt + 1}/${retries} for session=${context.sessionId} after HTTP ${response.status}`,
        );
      }
    } catch (err) {
      if (err === lastError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));

      if (lastError.message.includes("ECONNREFUSED")) {
        throw new Error(
          `Can't reach OpenClaw gateway at ${url}.\n` +
            `  Is OpenClaw running? Check: openclaw status\n` +
            `  Wrong URL? Run: ao setup openclaw`,
          { cause: err },
        );
      }

      if (attempt < retries) {
        console.warn(
          `[notifier-openclaw] Retry ${attempt + 1}/${retries} for session=${context.sessionId} after network error: ${lastError.message}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }

    if (attempt < retries) {
      const delay = retryDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function sanitizeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9:_-]/g, "-");
}

function eventHeadline(event: OrchestratorEvent): string {
  const priorityTag: Record<EventPriority, string> = {
    urgent: "URGENT",
    action: "ACTION",
    warning: "WARNING",
    info: "INFO",
  };
  return `[AO ${priorityTag[event.priority]}] ${event.sessionId} ${event.type}`;
}

function stringifyData(data: Record<string, unknown>): string {
  const entries = Object.entries(data);
  if (entries.length === 0) return "";
  return `Context: ${JSON.stringify(data)}`;
}

function formatEscalationMessage(event: OrchestratorEvent): string {
  const parts = [eventHeadline(event), event.message, stringifyData(event.data)].filter(Boolean);
  return parts.join("\n");
}

function formatActionsLine(actions: NotifyAction[]): string {
  if (actions.length === 0) return "";
  const labels = actions.map((a) => a.label).join(", ");
  return `Actions available: ${labels}`;
}

/**
 * Resolve a token value that may be a `${ENV_VAR}` placeholder (as written
 * into agent-orchestrator.yaml by `ao setup openclaw`) or a literal string.
 * Returns undefined for empty/unresolvable values so callers can chain `??`.
 */
function resolveEnvVarToken(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const match = raw.match(/^\$\{([^}]+)\}$/);
  if (match) return process.env[match[1]] || undefined;
  return raw;
}

export function create(config?: Record<string, unknown>): Notifier {
  const url =
    (typeof config?.url === "string" ? config.url : undefined) ??
    "http://127.0.0.1:18789/hooks/agent";
  const token =
    resolveEnvVarToken(config?.token) ??
    process.env.OPENCLAW_HOOKS_TOKEN ??
    readTokenFromOpenClawConfig();
  const senderName = typeof config?.name === "string" ? config.name : "AO";
  const sessionKeyPrefix =
    typeof config?.sessionKeyPrefix === "string" ? config.sessionKeyPrefix : "hook:ao:";
  const wakeMode: WakeMode = config?.wakeMode === "next-heartbeat" ? "next-heartbeat" : "now";
  const deliver = typeof config?.deliver === "boolean" ? config.deliver : true;
  const healthSummaryPath = getHealthSummaryPath(config);

  const { retries, retryDelayMs } = normalizeRetryConfig(config);

  validateUrl(url, "notifier-openclaw");

  if (!token) {
    console.warn(
      "[notifier-openclaw] No token configured.\n" +
        "  Set OPENCLAW_HOOKS_TOKEN env var, or add token to your notifier config.\n" +
        "  Run: ao setup openclaw",
    );
  }

  async function sendPayload(payload: OpenClawWebhookPayload): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const sessionId = payload.sessionKey?.slice(sessionKeyPrefix.length) ?? "default";
    try {
      await postWithRetry(url, payload, headers, retries, retryDelayMs, { sessionId });
      recordHealthSuccess(healthSummaryPath);
    } catch (err) {
      recordHealthFailure(healthSummaryPath, err);
      throw err;
    }
  }

  return {
    name: "openclaw",

    async notify(event: OrchestratorEvent): Promise<void> {
      const sessionKey = `${sessionKeyPrefix}${sanitizeSessionId(event.sessionId)}`;
      await sendPayload({
        message: formatEscalationMessage(event),
        name: senderName,
        sessionKey,
        wakeMode,
        deliver,
      });
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      const sessionKey = `${sessionKeyPrefix}${sanitizeSessionId(event.sessionId)}`;
      const actionsLine = formatActionsLine(actions);
      const message = [formatEscalationMessage(event), actionsLine].filter(Boolean).join("\n");

      await sendPayload({
        message,
        name: senderName,
        sessionKey,
        wakeMode,
        deliver,
      });
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      const sessionId = context?.sessionId ? sanitizeSessionId(context.sessionId) : "default";
      const sessionKey = `${sessionKeyPrefix}${sessionId}`;

      await sendPayload({
        message,
        name: senderName,
        sessionKey,
        wakeMode,
        deliver,
      });

      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
