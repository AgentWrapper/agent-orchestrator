import {
  getNotificationDataV3,
  recordActivityEvent,
  validateUrl,
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
  type EventPriority,
  type NotificationDataV3,
  type NotificationCICheck,
  CI_STATUS,
} from "@aoagents/ao-core";
import { isRetryableHttpStatus, normalizeRetryConfig } from "@aoagents/ao-core/utils";

export const manifest = {
  name: "discord",
  slot: "notifier" as const,
  description: "Notifier plugin: Discord webhook notifications with rich embeds",
  version: "0.1.0",
};

const DISCORD_WEBHOOK_URL_RE = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\//;

const DISCORD_EMBED_TITLE_MAX = 256;
const EMBED_DESCRIPTION_MAX = 4096;
const DISCORD_FIELD_NAME_MAX = 256;
const DISCORD_FIELD_VALUE_MAX = 1024;
const DISCORD_MAX_FIELDS = 25;

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  url?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
  footer?: { text: string };
}

interface DiscordTone {
  emoji: string;
  label: string;
  color: number;
}

const SUCCESS_TONE: DiscordTone = {
  emoji: "\u{2705}",
  label: "Complete",
  color: 0x57f287,
};

const PRIORITY_TONE: Record<EventPriority, DiscordTone> = {
  urgent: {
    emoji: "\u{1F6A8}",
    label: "Urgent",
    color: 0xed4245,
  },
  action: {
    emoji: "\u{1F449}",
    label: "Action required",
    color: 0x5865f2,
  },
  warning: {
    emoji: "\u{26A0}\u{FE0F}",
    label: "Warning",
    color: 0xfee75c,
  },
  info: {
    emoji: "\u{2139}\u{FE0F}",
    label: "Information",
    color: 0x3498db,
  },
};

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}\u2026` : value;
}

function titleCaseStatus(value: string): string {
  return value
    .split(/[_\s.-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function toneForEvent(event: OrchestratorEvent): DiscordTone {
  if (event.type === "merge.ready") return { ...SUCCESS_TONE, label: "Ready to merge" };
  if (event.type === "summary.all_complete") return { ...SUCCESS_TONE, label: "All complete" };
  if (event.type === "ci.failing" || event.type === "session.stuck") return PRIORITY_TONE.urgent;
  if (event.type === "review.changes_requested") return PRIORITY_TONE.warning;
  return PRIORITY_TONE[event.priority] ?? PRIORITY_TONE.info;
}

function eventTitle(event: OrchestratorEvent, data: NotificationDataV3 | null): string {
  const pr = data?.subject.pr;

  switch (event.type) {
    case "ci.failing":
      return pr ? `CI failing on PR #${pr.number}` : "CI failing";
    case "merge.ready":
      return pr ? `PR #${pr.number} ready to merge` : "Pull request ready to merge";
    case "review.changes_requested":
      return pr ? `Changes requested on PR #${pr.number}` : "Review changes requested";
    case "session.needs_input":
      return "Agent needs input";
    case "session.stuck":
      return "Agent may be stuck";
    case "session.killed":
    case "session.exited":
      return "Agent exited";
    case "pr.closed":
      return pr ? `PR #${pr.number} closed` : "Pull request closed";
    case "summary.all_complete":
      return "All sessions complete";
    default:
      return titleCaseStatus(event.type);
  }
}

function fieldValue(value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null || value === "") return "Not available";
  return truncate(String(value), DISCORD_FIELD_VALUE_MAX);
}

function appendField(
  fields: NonNullable<DiscordEmbed["fields"]>,
  name: string,
  value: string | number | boolean | undefined | null,
  inline = true,
): void {
  if (value === undefined || value === null || value === "") return;
  if (fields.length >= DISCORD_MAX_FIELDS) return;
  fields.push({
    name: truncate(name, DISCORD_FIELD_NAME_MAX),
    value: fieldValue(value),
    inline,
  });
}

function formatMarkdownLink(label: string, url: string): string {
  return `[${label.replace(/[\][()]/g, "")}](${url.replace(/\)/g, "%29")})`;
}

function formatBranch(data: NotificationDataV3 | null): string | undefined {
  const pr = data?.subject.pr;
  if (pr?.branch && pr.baseBranch) return `${pr.branch} -> ${pr.baseBranch}`;
  return pr?.branch ?? pr?.baseBranch ?? data?.subject.branch;
}

function formatCheck(check: NotificationCICheck): string {
  const status = check.conclusion ? `${check.status}/${check.conclusion}` : check.status;
  const label = `${check.name}: ${status}`;
  return check.url ? formatMarkdownLink(label, check.url) : label;
}

function isAbsoluteHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function appendDataFields(
  fields: NonNullable<DiscordEmbed["fields"]>,
  data: NotificationDataV3 | null,
): void {
  if (!data) return;

  const pr = data.subject.pr;
  const issue = data.subject.issue;
  const branch = formatBranch(data);

  appendField(
    fields,
    "Pull Request",
    pr
      ? `${formatMarkdownLink(`#${pr.number}`, pr.url)}${pr.title ? ` - ${pr.title}` : ""}`
      : undefined,
    false,
  );
  appendField(fields, "Branch", branch);
  appendField(
    fields,
    "Issue",
    issue ? `${issue.id}${issue.title ? ` - ${issue.title}` : ""}` : undefined,
  );
  appendField(fields, "CI", data.ci?.status ? formatCiStatus(data) : undefined);
  appendField(
    fields,
    "Review",
    data.review?.decision ? titleCaseStatus(data.review.decision) : undefined,
  );
  appendField(fields, "Review Threads", data.review?.unresolvedThreads);
  appendField(
    fields,
    "Merge",
    typeof data.merge?.ready === "boolean" ? (data.merge.ready ? "Ready" : "Not ready") : undefined,
  );
  appendField(
    fields,
    "Conflicts",
    typeof data.merge?.conflicts === "boolean"
      ? data.merge.conflicts
        ? "Found"
        : "None"
      : undefined,
  );
  appendField(
    fields,
    "Sync",
    typeof data.merge?.isBehind === "boolean"
      ? data.merge.isBehind
        ? "Behind base"
        : "Up to date"
      : undefined,
  );
  appendField(
    fields,
    "Transition",
    data.transition ? `${data.transition.from} -> ${data.transition.to}` : undefined,
  );
  appendField(
    fields,
    "Reaction",
    data.reaction ? `${data.reaction.key} -> ${data.reaction.action}` : undefined,
  );
  appendField(
    fields,
    "Escalation",
    data.escalation ? `${data.escalation.attempts} attempts (${data.escalation.cause})` : undefined,
  );

  const checks = (data.ci?.failedChecks ?? []).slice(0, 8).map(formatCheck);
  appendField(fields, "Checks", checks.length > 0 ? checks.join("\n") : undefined, false);
  appendField(
    fields,
    "Blockers",
    data.merge?.blockers?.length ? data.merge.blockers.slice(0, 8).join("\n") : undefined,
    false,
  );

  const links = [
    ...(pr?.url ? [formatMarkdownLink("Pull request", pr.url)] : []),
    ...(data.review?.url ? [formatMarkdownLink("Review", data.review.url)] : []),
  ];
  appendField(fields, "Links", links.length > 0 ? links.join(" | ") : undefined, false);
}

function formatCiStatus(data: NotificationDataV3): string {
  if (!data.ci?.status) return "";
  const ciEmoji = data.ci.status === CI_STATUS.PASSING ? "\u{2705}" : "\u{274C}";
  const failedChecks = data.ci.failedChecks?.map((check) => check.name) ?? [];
  const failedCheckText = failedChecks.length > 0 ? `\nFailed: ${failedChecks.join(", ")}` : "";
  return `${ciEmoji} ${titleCaseStatus(data.ci.status)}${failedCheckText}`;
}

function appendActionField(
  fields: NonNullable<DiscordEmbed["fields"]>,
  data: NotificationDataV3 | null,
  actions?: NotifyAction[],
): void {
  const seen = new Set<string>();
  const links: string[] = [];

  const prUrl = data?.subject.pr?.url;
  if (prUrl) {
    links.push(formatMarkdownLink("View PR", prUrl));
    seen.add(prUrl);
  }

  const reviewUrl = data?.review?.url;
  if (reviewUrl && !seen.has(reviewUrl)) {
    links.push(formatMarkdownLink("View Review", reviewUrl));
    seen.add(reviewUrl);
  }

  for (const action of actions ?? []) {
    if (action.url) {
      if (seen.has(action.url)) continue;
      links.push(formatMarkdownLink(action.label, action.url));
      seen.add(action.url);
      continue;
    }
    if (isAbsoluteHttpUrl(action.callbackEndpoint)) {
      links.push(formatMarkdownLink(action.label, action.callbackEndpoint));
      continue;
    }
    links.push(`\`${action.label}\``);
  }

  appendField(fields, "Actions", links.slice(0, 8).join(" | "), false);
}

function formatDescription(event: OrchestratorEvent, data: NotificationDataV3 | null): string {
  const subtitle = data?.subject.pr?.title ?? data?.subject.summary;
  const description = subtitle ? `**${subtitle}**\n${event.message}` : event.message;
  return truncate(description, EMBED_DESCRIPTION_MAX);
}

function buildEmbed(event: OrchestratorEvent, actions?: NotifyAction[]): DiscordEmbed {
  const data = getNotificationDataV3(event.data);
  const tone = toneForEvent(event);
  const fields: NonNullable<DiscordEmbed["fields"]> = [];

  appendField(fields, "Project", event.projectId);
  appendField(fields, "Session", event.sessionId);
  appendField(fields, "Priority", tone.label);
  appendDataFields(fields, data);
  appendActionField(fields, data, actions);

  const embed: DiscordEmbed = {
    title: truncate(`${tone.emoji} ${eventTitle(event, data)}`, DISCORD_EMBED_TITLE_MAX),
    description: formatDescription(event, data),
    color: tone.color,
    ...(data?.subject.pr?.url ? { url: data.subject.pr.url } : {}),
    fields,
    timestamp: event.timestamp.toISOString(),
    footer: { text: "Agent Orchestrator" },
  };

  return embed;
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function postWithRetry(
  webhookUrl: string,
  payload: Record<string, unknown>,
  retries: number,
  retryDelayMs: number,
): Promise<void> {
  let lastError: Error | undefined;
  // Separate counter for 429 Retry-After waits so they don't consume the error
  // retry budget — a server-mandated wait shouldn't cost a retry slot.
  let rateLimitRetries = 0;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok || response.status === 204) return;

      // Handle rate limiting: wait then retry without burning an error retry slot.
      // Use Retry-After if present, otherwise fall back to retryDelayMs.
      if (response.status === 429) {
        if (rateLimitRetries < retries) {
          const retryAfter = response.headers.get("Retry-After");
          const waitMs = retryAfter ? (parseFloat(retryAfter) || 1) * 1000 : retryDelayMs;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          rateLimitRetries++;
          attempt--; // undo the for-loop increment so error budget is preserved
          continue;
        }
        // Rate-limit budget exhausted — fail immediately rather than falling through
        // to the error retry path (which would compound the two counters).
        const body = await response.text().catch(() => "");
        recordActivityEvent({
          source: "notifier",
          kind: "notifier.rate_limited",
          level: "warn",
          summary: `Discord webhook rate-limit retry budget exhausted`,
          data: {
            plugin: "notifier-discord",
            status: 429,
            rateLimitRetries,
          },
        });
        lastError = new Error(
          `Discord webhook rate-limited (HTTP 429)${body ? `: ${body.trim()}` : ""}`,
        );
        throw lastError;
      }

      const body = await response.text();
      lastError = new Error(`Discord webhook failed (${response.status}): ${body}`);

      if (!isRetryableHttpStatus(response.status)) {
        throw lastError;
      }
    } catch (err) {
      if (err === lastError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
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

export function create(config?: Record<string, unknown>): Notifier {
  const webhookUrl = config?.webhookUrl as string | undefined;
  const username = (config?.username as string) ?? "Agent Orchestrator";
  const avatarUrl = config?.avatarUrl as string | undefined;
  const threadId = config?.threadId as string | undefined;

  const { retries, retryDelayMs } = normalizeRetryConfig(config);

  if (!webhookUrl) {
    console.warn(
      "[notifier-discord] No webhookUrl configured.\n" +
        "  Set it in agent-orchestrator.yaml under notifiers.discord.webhookUrl\n" +
        "  Create a webhook: Discord Server Settings > Integrations > Webhooks > New Webhook",
    );
  } else {
    validateUrl(webhookUrl, "notifier-discord");
    if (!DISCORD_WEBHOOK_URL_RE.test(webhookUrl)) {
      console.warn(
        "[notifier-discord] webhookUrl does not match expected Discord webhook format.\n" +
          "  Expected: https://discord.com/api/webhooks/... or https://discordapp.com/api/webhooks/...",
      );
    }
  }

  // Discord requires thread_id as a URL query param, not in the JSON body
  const effectiveUrl =
    webhookUrl && threadId
      ? `${webhookUrl}${webhookUrl.includes("?") ? "&" : "?"}thread_id=${encodeURIComponent(threadId)}`
      : webhookUrl;

  function buildPayload(embeds: DiscordEmbed[]): Record<string, unknown> {
    const payload: Record<string, unknown> = { username, embeds, allowed_mentions: { parse: [] } };
    if (avatarUrl) payload.avatar_url = avatarUrl;
    return payload;
  }

  return {
    name: "discord",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!effectiveUrl) return;
      const payload = buildPayload([buildEmbed(event)]);
      await postWithRetry(effectiveUrl, payload, retries, retryDelayMs);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!effectiveUrl) return;
      const payload = buildPayload([buildEmbed(event, actions)]);
      await postWithRetry(effectiveUrl, payload, retries, retryDelayMs);
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!effectiveUrl) return null;
      const payload: Record<string, unknown> = {
        username,
        content: message,
        allowed_mentions: { parse: [] },
      };
      if (avatarUrl) payload.avatar_url = avatarUrl;
      // thread_id is already passed as a URL query param via effectiveUrl
      await postWithRetry(effectiveUrl, payload, retries, retryDelayMs);
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
