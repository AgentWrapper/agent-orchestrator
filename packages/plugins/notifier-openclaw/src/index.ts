import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  getNotificationDataV3,
  type EventPriority,
  type NotificationCICheck,
  type NotificationDataV3,
  type Notifier,
  type NotifyAction,
  type NotifyContext,
  type OrchestratorEvent,
  type PluginModule,
  getObservabilityBaseDir,
  recordActivityEvent,
} from "@aoagents/ao-core";
import { isRetryableHttpStatus, normalizeRetryConfig, validateUrl } from "@aoagents/ao-core/utils";

/**
 * Read the hooks token from OpenClaw's config. AO treats OpenClaw as the
 * owner of hooks.token; setup only points the notifier at this file.
 */
function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function readTokenFromOpenClawConfig(configPath?: string): string | undefined {
  try {
    const resolvedPath = expandHomePath(
      configPath ?? join(homedir(), ".openclaw", "openclaw.json"),
    );
    if (!existsSync(resolvedPath)) return undefined;
    const raw = readFileSync(resolvedPath, "utf-8");
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
const UNREACHABLE_NETWORK_ERROR_CODES = [
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ENETUNREACH",
] as const;
type UnreachableNetworkErrorCode = (typeof UNREACHABLE_NETWORK_ERROR_CODES)[number];

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

function getUnreachableNetworkErrorCode(error: Error): UnreachableNetworkErrorCode | undefined {
  return UNREACHABLE_NETWORK_ERROR_CODES.find((code) => error.message.includes(code));
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
    let shouldRethrowResponseError = false;
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
        // User-actionable: distinct from generic 5xx — token expired or wrong.
        recordActivityEvent({
          sessionId: context.sessionId,
          source: "notifier",
          kind: "notifier.auth_failed",
          level: "error",
          summary: `OpenClaw rejected auth token (HTTP ${response.status})`,
          data: {
            plugin: "notifier-openclaw",
            status: response.status,
            url,
            fixHint: "ao setup openclaw",
          },
        });
        lastError = new Error(
          `OpenClaw rejected the auth token (HTTP ${response.status}).\n` +
            `  Check that hooks.token in your OpenClaw config matches the token configured for AO.\n` +
            `  Reconfigure: ao setup openclaw`,
        );
        shouldRethrowResponseError = true;
        throw lastError;
      }

      lastError = new Error(`OpenClaw webhook failed (${response.status}): ${body}`);

      if (!isRetryableHttpStatus(response.status)) {
        shouldRethrowResponseError = true;
        throw lastError;
      }

      if (attempt < retries) {
        console.warn(
          `[notifier-openclaw] Retry ${attempt + 1}/${retries} for session=${context.sessionId} after HTTP ${response.status}`,
        );
      }
    } catch (err) {
      if (shouldRethrowResponseError && err === lastError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));

      const unreachableCode = getUnreachableNetworkErrorCode(lastError);
      if (unreachableCode && (unreachableCode === "ECONNREFUSED" || attempt >= retries)) {
        recordActivityEvent({
          sessionId: context.sessionId,
          source: "notifier",
          kind: "notifier.unreachable",
          level: "warn",
          summary: `OpenClaw gateway unreachable at ${url}`,
          data: {
            plugin: "notifier-openclaw",
            url,
            errorMessage: lastError.message,
            fixHint: "openclaw status",
          },
        });
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
  return `**AO ${priorityTag[event.priority]}** \`${event.type}\``;
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function compactValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (isPrimitive(value)) return String(value);
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

function truncate(value: string, maxLength = 140): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function escapeMarkdownLinkLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/~/g, "\\~")
    .replace(/`/g, "\\`");
}

function escapeMarkdownLinkUrl(value: string): string {
  return value.replace(/[()\\\s<>]/g, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
  });
}

function formatLink(label: string, url: string): string {
  return `[${escapeMarkdownLinkLabel(label)}](${escapeMarkdownLinkUrl(url)})`;
}

function pushSection(lines: string[], title: string, items: string[]): void {
  const filtered = items.filter(Boolean);
  if (filtered.length === 0) return;
  lines.push("", `**${title}**`, ...filtered);
}

function formatSubjectLines(data: NotificationDataV3): string[] {
  const subject = data.subject;
  const lines = [
    `- Project: \`${subject.session.projectId}\``,
    `- Session: \`${subject.session.id}\``,
  ];

  if (subject.issue) {
    const label = subject.issue.title
      ? `${subject.issue.id} - ${subject.issue.title}`
      : subject.issue.id;
    lines.push(`- Issue: ${label}`);
  }

  return lines;
}

function formatPrLines(data: NotificationDataV3): string[] {
  const pr = data.subject.pr;
  if (!pr) return [];

  const title = pr.title ? ` - ${pr.title}` : "";
  const lines = [`- PR: ${formatLink(`#${pr.number}${title}`, pr.url)}`];
  if (pr.branch) lines.push(`- Branch: \`${pr.branch}\``);
  if (pr.baseBranch) lines.push(`- Base: \`${pr.baseBranch}\``);
  if (typeof pr.isDraft === "boolean") lines.push(`- Draft: ${pr.isDraft ? "yes" : "no"}`);
  return lines;
}

function formatStatusLines(data: NotificationDataV3): string[] {
  const lines: string[] = [];
  if (data.transition) {
    lines.push(`- Transition: \`${data.transition.from}\` -> \`${data.transition.to}\``);
  }
  if (data.ci?.status) lines.push(`- CI: \`${data.ci.status}\``);
  if (data.review?.decision) lines.push(`- Review: \`${data.review.decision}\``);
  if (typeof data.review?.unresolvedThreads === "number") {
    lines.push(`- Unresolved threads: ${data.review.unresolvedThreads}`);
  }
  if (typeof data.merge?.ready === "boolean") {
    lines.push(`- Merge ready: ${data.merge.ready ? "yes" : "no"}`);
  }
  if (typeof data.merge?.conflicts === "boolean") {
    lines.push(`- Conflicts: ${data.merge.conflicts ? "yes" : "no"}`);
  }
  if (typeof data.merge?.isBehind === "boolean") {
    lines.push(`- Behind base: ${data.merge.isBehind ? "yes" : "no"}`);
  }
  if (data.reaction) {
    lines.push(`- Reaction: \`${data.reaction.key}\` -> \`${data.reaction.action}\``);
  }
  if (data.escalation) {
    lines.push(`- Escalation: ${data.escalation.attempts} attempts (${data.escalation.cause})`);
  }
  return lines;
}

function formatCheckLine(check: NotificationCICheck): string {
  const status = check.conclusion ? `${check.status}/${check.conclusion}` : check.status;
  const name = check.url ? formatLink(check.name, check.url) : check.name;
  return `- ${name}: \`${status}\``;
}

function formatCheckLines(data: NotificationDataV3): string[] {
  const checks = data.ci?.failedChecks ?? [];
  return checks.slice(0, 8).map(formatCheckLine);
}

function formatBlockerLines(data: NotificationDataV3): string[] {
  const blockers = data.merge?.blockers ?? [];
  return blockers.slice(0, 8).map((blocker) => `- ${blocker}`);
}

function formatLinkLines(data: NotificationDataV3): string[] {
  const links: string[] = [];
  if (data.subject.pr?.url) links.push(`- ${formatLink("Pull request", data.subject.pr.url)}`);
  if (data.review?.url) links.push(`- ${formatLink("Review", data.review.url)}`);
  return links;
}

function formatLegacyContext(data: Record<string, unknown>): string[] {
  return Object.entries(data)
    .filter(([, value]) => compactValue(value) !== undefined)
    .slice(0, 8)
    .map(([key, value]) => `- ${key}: ${truncate(compactValue(value) ?? "")}`);
}

function formatEscalationMessage(event: OrchestratorEvent): string {
  const lines = [eventHeadline(event), "", event.message];
  const data = getNotificationDataV3(event.data);

  if (!data) {
    pushSection(lines, "Session", [
      `- Project: \`${event.projectId}\``,
      `- Session: \`${event.sessionId}\``,
    ]);
    pushSection(lines, "Context", formatLegacyContext(event.data));
    return lines.join("\n");
  }

  pushSection(lines, "Session", formatSubjectLines(data));
  pushSection(lines, "Pull Request", formatPrLines(data));
  pushSection(lines, "Status", formatStatusLines(data));
  pushSection(lines, "Checks", formatCheckLines(data));
  pushSection(lines, "Blockers", formatBlockerLines(data));
  pushSection(lines, "Links", formatLinkLines(data));
  return lines.join("\n");
}

function formatActionsLine(actions: NotifyAction[]): string {
  if (actions.length === 0) return "";
  const lines = actions.map((action) => {
    const target = action.url ?? action.callbackEndpoint;
    return target ? `- ${formatLink(action.label, target)}` : `- ${action.label}`;
  });
  return ["", "**Actions**", ...lines].join("\n");
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
  const openclawConfigPath =
    typeof config?.openclawConfigPath === "string" ? config.openclawConfigPath : undefined;
  const token =
    resolveEnvVarToken(config?.token) ??
    readTokenFromOpenClawConfig(openclawConfigPath) ??
    process.env.OPENCLAW_HOOKS_TOKEN;
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
        "  Add hooks.token to your OpenClaw config, or set notifiers.openclaw.openclawConfigPath.\n" +
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
