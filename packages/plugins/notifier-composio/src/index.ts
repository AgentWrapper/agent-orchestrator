import {
  getNotificationDataV3,
  recordActivityEvent,
  type EventPriority,
  type Notifier,
  type NotifyAction,
  type NotifyContext,
  type NotificationCICheck,
  type NotificationDataV3,
  type OrchestratorEvent,
  type PluginModule,
} from "@aoagents/ao-core";

// Module-level guard so we only emit notifier.dep_missing once per process.
let depMissingEmitted = false;

/** Test-only: reset the once-per-process dep_missing guard. */
export function _resetDepMissingEmittedForTesting(): void {
  depMissingEmitted = false;
}

export const manifest = {
  name: "composio",
  slot: "notifier" as const,
  description: "Notifier plugin: Composio unified notifications (Slack, Discord, email)",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}",
  action: "\u{1F449}",
  warning: "\u{26A0}\u{FE0F}",
  info: "\u{2139}\u{FE0F}",
};

function getSubjectPRUrl(event: OrchestratorEvent): string | undefined {
  return getNotificationDataV3(event.data)?.subject.pr?.url;
}

function getCIStatus(event: OrchestratorEvent): string | undefined {
  return getNotificationDataV3(event.data)?.ci?.status;
}

function getFailedCheckNames(event: OrchestratorEvent): string[] {
  return getNotificationDataV3(event.data)?.ci?.failedChecks?.map((check) => check.name) ?? [];
}

type ComposioApp = "slack" | "discord" | "gmail";
type DiscordMode = "webhook" | "bot";

const APP_TOOL_SLUG: Record<ComposioApp, string> = {
  slack: "SLACK_SEND_MESSAGE",
  discord: "DISCORDBOT_CREATE_MESSAGE",
  gmail: "GMAIL_SEND_EMAIL",
};

const DEFAULT_TOOL_VERSION: Partial<Record<ComposioApp, string>> = {
  slack: "20260508_00",
  discord: "20260429_01",
  gmail: "20260506_01",
};

const VALID_APPS = new Set<string>(["slack", "discord", "gmail"]);
const VALID_DISCORD_MODES = new Set<string>(["webhook", "bot"]);
const DEFAULT_COMPOSIO_USER_ID = "aoagent";

const GMAIL_SUBJECT = "Agent Orchestrator Notification";
const GMAIL_POST_SUBJECT = "Agent Orchestrator Message";
const DISCORD_WEBHOOK_TOOL_SLUG = "DISCORDBOT_EXECUTE_WEBHOOK";
const DISCORD_EMBED_TITLE_MAX = 256;
const DISCORD_EMBED_DESCRIPTION_MAX = 4096;
const DISCORD_FIELD_NAME_MAX = 256;
const DISCORD_FIELD_VALUE_MAX = 1024;
const DISCORD_MAX_FIELDS = 25;

interface ComposioExecuteParams {
  userId: string;
  connectedAccountId?: string;
  version?: string;
  dangerouslySkipVersionCheck?: boolean;
  arguments: Record<string, unknown>;
}

interface ComposioExecuteResult {
  successful?: boolean;
  data?: unknown;
  error?: unknown;
}

interface ComposioToolsClient {
  tools: {
    execute(action: string, params: ComposioExecuteParams): Promise<ComposioExecuteResult>;
  };
}

interface DiscordTone {
  emoji: string;
  label: string;
  color: number;
}

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  url?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
  footer?: { text: string };
}

interface DiscordComponentButton {
  type: 2;
  style: 5;
  label: string;
  url: string;
}

interface DiscordActionRow {
  type: 1;
  components: DiscordComponentButton[];
}

interface DiscordMessagePayload {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: DiscordActionRow[];
  allowed_mentions?: { parse: string[] };
}

interface SlackTone {
  emoji: string;
  label: string;
  color: string;
}

interface SlackButton {
  type: "button";
  text: {
    type: "plain_text";
    text: string;
    emoji: true;
  };
  url?: string;
  action_id?: string;
  value?: string;
  style?: "primary" | "danger";
}

interface SlackAttachment {
  color: string;
  fallback: string;
  blocks: unknown[];
}

interface SlackMessagePayload {
  markdown_text: string;
  text: string;
  attachments: string;
  unfurl_links: boolean;
  unfurl_media: boolean;
}

function isComposioToolsClient(value: unknown): value is ComposioToolsClient {
  return (
    value !== null &&
    typeof value === "object" &&
    "tools" in value &&
    typeof (value as { tools?: { execute?: unknown } }).tools?.execute === "function"
  );
}

/**
 * Lazy-load the bundled @composio/core SDK.
 *
 * Dynamic import keeps the plugin lightweight at module-load time and lets
 * tests inject a mock client at the I/O boundary.
 */
async function loadComposioSDK(apiKey: string): Promise<ComposioToolsClient | null> {
  try {
    const mod = (await import("@composio/core")) as unknown as Record<string, unknown>;
    const ComposioClass = (mod.Composio ??
      (mod.default as Record<string, unknown> | undefined)?.Composio ??
      mod.default) as (new (opts: { apiKey: string }) => unknown) | undefined;

    if (typeof ComposioClass !== "function") {
      throw new Error("Could not find Composio class in @composio/core module");
    }

    const client = new ComposioClass({ apiKey });
    if (!isComposioToolsClient(client)) {
      throw new Error("Composio SDK client does not expose tools.execute()");
    }

    return client;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (
      message.includes("Cannot find module") ||
      message.includes("Cannot find package") ||
      message.includes("MODULE_NOT_FOUND") ||
      code === "ERR_MODULE_NOT_FOUND"
    ) {
      // User-actionable. Emit once per process so RCA can answer
      // "why is the composio notifier silent?" without spamming on every notify call.
      if (!depMissingEmitted) {
        depMissingEmitted = true;
        recordActivityEvent({
          source: "notifier",
          kind: "notifier.dep_missing",
          level: "error",
          summary: "Composio SDK (@composio/core) is not installed",
          data: {
            plugin: "notifier-composio",
            package: "@composio/core",
            installHint: "pnpm add @composio/core",
          },
        });
      }
      return null;
    }
    throw err;
  }
}

function stringConfig(
  config: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function resolveEnvReference(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/);
  if (!match) return value;
  return process.env[match[1] ?? match[2] ?? ""];
}

function boolConfig(config: Record<string, unknown> | undefined, key: string): boolean {
  return config?.[key] === true;
}

function parseDiscordWebhookUrl(webhookUrl: string): { webhookId: string; webhookToken: string } {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new Error("[notifier-composio] Invalid Discord webhookUrl.");
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const webhookIndex = segments.findIndex((segment) => segment === "webhooks");
  const webhookId = webhookIndex >= 0 ? segments[webhookIndex + 1] : undefined;
  const webhookToken = webhookIndex >= 0 ? segments[webhookIndex + 2] : undefined;

  if (!webhookId || !webhookToken) {
    throw new Error(
      "[notifier-composio] Invalid Discord webhookUrl. Expected https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN",
    );
  }

  return {
    webhookId: decodeURIComponent(webhookId),
    webhookToken: decodeURIComponent(webhookToken),
  };
}

function resolveDiscordMode(
  config: Record<string, unknown> | undefined,
  defaultApp: ComposioApp,
  webhookUrl: string | undefined,
): DiscordMode | undefined {
  if (defaultApp !== "discord") return undefined;

  const mode = stringConfig(config, "mode");
  if (mode) {
    if (!VALID_DISCORD_MODES.has(mode)) {
      throw new Error(
        `[notifier-composio] Invalid Discord mode: "${mode}". Must be one of: webhook, bot`,
      );
    }
    return mode as DiscordMode;
  }

  return webhookUrl ? "webhook" : "bot";
}

function formatNotifyText(event: OrchestratorEvent): string {
  const emoji = PRIORITY_EMOJI[event.priority];
  const parts = [`${emoji} *${event.type}* — ${event.sessionId}`, event.message];

  const prUrl = getSubjectPRUrl(event);
  if (prUrl) {
    parts.push(`PR: ${prUrl}`);
  }

  const ciStatus = getCIStatus(event);
  if (ciStatus) {
    const failedChecks = getFailedCheckNames(event);
    const failedCheckText = failedChecks.length > 0 ? ` (failed: ${failedChecks.join(", ")})` : "";
    parts.push(`CI: ${ciStatus}${failedCheckText}`);
  }

  return parts.join("\n");
}

function formatActionsText(event: OrchestratorEvent, actions: NotifyAction[]): string {
  const base = formatNotifyText(event);
  const actionLines = actions.map((a) => {
    if (a.url) return `- ${a.label}: ${a.url}`;
    return `- ${a.label}`;
  });

  return `${base}\n\nActions:\n${actionLines.join("\n")}`;
}

const DISCORD_SUCCESS_TONE: DiscordTone = {
  emoji: "\u{2705}",
  label: "Complete",
  color: 0x57f287,
};

const DISCORD_PRIORITY_TONE: Record<EventPriority, DiscordTone> = {
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

function titleCaseStatus(value: string): string {
  return value
    .split(/[_\s.-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function priorityLabel(priority: EventPriority): string {
  switch (priority) {
    case "urgent":
      return "Urgent";
    case "action":
      return "Action required";
    case "warning":
      return "Warning";
    case "info":
      return "Information";
  }
}

function truncate(value: string, maxLength = 90): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function truncateUnicode(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}\u2026` : value;
}

function discordToneForEvent(event: OrchestratorEvent): DiscordTone {
  if (event.type === "merge.ready") return { ...DISCORD_SUCCESS_TONE, label: "Ready to merge" };
  if (event.type === "summary.all_complete") {
    return { ...DISCORD_SUCCESS_TONE, label: "All complete" };
  }
  if (event.type === "ci.failing" || event.type === "session.stuck") {
    return DISCORD_PRIORITY_TONE.urgent;
  }
  if (event.type === "review.changes_requested") return DISCORD_PRIORITY_TONE.warning;
  return DISCORD_PRIORITY_TONE[event.priority] ?? DISCORD_PRIORITY_TONE.info;
}

function formatDiscordTitle(event: OrchestratorEvent, data: NotificationDataV3 | null): string {
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

function formatDiscordValue(value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null || value === "") return "Not available";
  return truncateUnicode(String(value), DISCORD_FIELD_VALUE_MAX);
}

function appendDiscordField(
  fields: NonNullable<DiscordEmbed["fields"]>,
  name: string,
  value: string | number | boolean | undefined | null,
  inline = true,
): void {
  if (value === undefined || value === null || value === "") return;
  if (fields.length >= DISCORD_MAX_FIELDS) return;
  fields.push({
    name: truncateUnicode(name, DISCORD_FIELD_NAME_MAX),
    value: formatDiscordValue(value),
    inline,
  });
}

function formatDiscordMarkdownLink(label: string, url: string): string {
  const safeLabel = label.replaceAll("[", "").replaceAll("]", "").replace(/[()]/g, "");
  const safeUrl = url.replace(/\)/g, "%29");
  return `[${safeLabel}](${safeUrl})`;
}

function formatDiscordBranch(data: NotificationDataV3 | null): string | undefined {
  const pr = data?.subject.pr;
  if (pr?.branch && pr.baseBranch) return `${pr.branch} -> ${pr.baseBranch}`;
  return pr?.branch ?? pr?.baseBranch ?? data?.subject.branch;
}

function formatDiscordCheck(check: NotificationCICheck): string {
  const status = check.conclusion ? `${check.status}/${check.conclusion}` : check.status;
  const label = `${check.name}: ${status}`;
  return check.url ? formatDiscordMarkdownLink(label, check.url) : label;
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

function formatDiscordCiStatus(data: NotificationDataV3): string {
  if (!data.ci?.status) return "";
  const ciEmoji = data.ci.status === "passing" ? "\u{2705}" : "\u{274C}";
  const failedChecks = data.ci.failedChecks?.map((check) => check.name) ?? [];
  const failedCheckText = failedChecks.length > 0 ? `\nFailed: ${failedChecks.join(", ")}` : "";
  return `${ciEmoji} ${titleCaseStatus(data.ci.status)}${failedCheckText}`;
}

function appendDiscordDataFields(
  fields: NonNullable<DiscordEmbed["fields"]>,
  data: NotificationDataV3 | null,
): void {
  if (!data) return;

  const pr = data.subject.pr;
  const issue = data.subject.issue;
  const branch = formatDiscordBranch(data);

  appendDiscordField(
    fields,
    "Pull Request",
    pr
      ? `${formatDiscordMarkdownLink(`#${pr.number}`, pr.url)}${pr.title ? ` - ${pr.title}` : ""}`
      : undefined,
    false,
  );
  appendDiscordField(fields, "Branch", branch);
  appendDiscordField(
    fields,
    "Issue",
    issue ? `${issue.id}${issue.title ? ` - ${issue.title}` : ""}` : undefined,
  );
  appendDiscordField(fields, "CI", data.ci?.status ? formatDiscordCiStatus(data) : undefined);
  appendDiscordField(
    fields,
    "Review",
    data.review?.decision ? titleCaseStatus(data.review.decision) : undefined,
  );
  appendDiscordField(fields, "Review Threads", data.review?.unresolvedThreads);
  appendDiscordField(
    fields,
    "Merge",
    typeof data.merge?.ready === "boolean" ? (data.merge.ready ? "Ready" : "Not ready") : undefined,
  );
  appendDiscordField(
    fields,
    "Conflicts",
    typeof data.merge?.conflicts === "boolean"
      ? data.merge.conflicts
        ? "Found"
        : "None"
      : undefined,
  );
  appendDiscordField(
    fields,
    "Sync",
    typeof data.merge?.isBehind === "boolean"
      ? data.merge.isBehind
        ? "Behind base"
        : "Up to date"
      : undefined,
  );
  appendDiscordField(
    fields,
    "Transition",
    data.transition ? `${data.transition.from} -> ${data.transition.to}` : undefined,
  );
  appendDiscordField(
    fields,
    "Reaction",
    data.reaction ? `${data.reaction.key} -> ${data.reaction.action}` : undefined,
  );
  appendDiscordField(
    fields,
    "Escalation",
    data.escalation ? `${data.escalation.attempts} attempts (${data.escalation.cause})` : undefined,
  );

  const checks = (data.ci?.failedChecks ?? []).slice(0, 8).map(formatDiscordCheck);
  appendDiscordField(fields, "Checks", checks.length > 0 ? checks.join("\n") : undefined, false);
  appendDiscordField(
    fields,
    "Blockers",
    data.merge?.blockers?.length ? data.merge.blockers.slice(0, 8).join("\n") : undefined,
    false,
  );

  const links = [
    ...(pr?.url ? [formatDiscordMarkdownLink("Pull request", pr.url)] : []),
    ...(data.review?.url ? [formatDiscordMarkdownLink("Review", data.review.url)] : []),
  ];
  appendDiscordField(fields, "Links", links.length > 0 ? links.join(" | ") : undefined, false);
}

function appendDiscordActionField(
  fields: NonNullable<DiscordEmbed["fields"]>,
  data: NotificationDataV3 | null,
  actions?: NotifyAction[],
): void {
  const seen = new Set<string>();
  const links: string[] = [];

  const prUrl = data?.subject.pr?.url;
  if (prUrl) {
    links.push(formatDiscordMarkdownLink("View PR", prUrl));
    seen.add(prUrl);
  }

  const reviewUrl = data?.review?.url;
  if (reviewUrl && !seen.has(reviewUrl)) {
    links.push(formatDiscordMarkdownLink("View Review", reviewUrl));
    seen.add(reviewUrl);
  }

  for (const action of actions ?? []) {
    if (action.url) {
      if (seen.has(action.url)) continue;
      links.push(formatDiscordMarkdownLink(action.label, action.url));
      seen.add(action.url);
      continue;
    }
    if (isAbsoluteHttpUrl(action.callbackEndpoint)) {
      links.push(formatDiscordMarkdownLink(action.label, action.callbackEndpoint));
      continue;
    }
    links.push(`\`${action.label}\``);
  }

  appendDiscordField(fields, "Actions", links.slice(0, 8).join(" | "), false);
}

function buildDiscordComponents(
  data: NotificationDataV3 | null,
  actions?: NotifyAction[],
): DiscordActionRow[] {
  const seen = new Set<string>();
  const buttons: DiscordComponentButton[] = [];
  const addButton = (label: string, url: string): void => {
    if (seen.has(url) || buttons.length >= 5) return;
    buttons.push({ type: 2, style: 5, label: truncateUnicode(label, 80), url });
    seen.add(url);
  };

  const prUrl = data?.subject.pr?.url;
  if (prUrl) addButton("View PR", prUrl);

  const reviewUrl = data?.review?.url;
  if (reviewUrl) addButton("View Review", reviewUrl);

  for (const action of actions ?? []) {
    if (action.url) addButton(action.label, action.url);
    else if (isAbsoluteHttpUrl(action.callbackEndpoint))
      addButton(action.label, action.callbackEndpoint);
  }

  return buttons.length > 0 ? [{ type: 1, components: buttons }] : [];
}

function formatDiscordDescription(
  event: OrchestratorEvent,
  data: NotificationDataV3 | null,
): string {
  const subtitle = data?.subject.pr?.title ?? data?.subject.summary;
  const description = subtitle ? `**${subtitle}**\n${event.message}` : event.message;
  return truncateUnicode(description, DISCORD_EMBED_DESCRIPTION_MAX);
}

function formatDiscordFallback(event: OrchestratorEvent, data: NotificationDataV3 | null): string {
  const tone = discordToneForEvent(event);
  return truncateUnicode(
    `${tone.label}: ${formatDiscordTitle(event, data)} — ${event.message}`,
    2000,
  );
}

function formatDiscordMessagePayload(
  event: OrchestratorEvent,
  actions?: NotifyAction[],
): DiscordMessagePayload {
  const data = getNotificationDataV3(event.data);
  const tone = discordToneForEvent(event);
  const fields: NonNullable<DiscordEmbed["fields"]> = [];

  appendDiscordField(fields, "Project", event.projectId);
  appendDiscordField(fields, "Session", event.sessionId);
  appendDiscordField(fields, "Priority", tone.label);
  appendDiscordDataFields(fields, data);
  appendDiscordActionField(fields, data, actions);

  const components = buildDiscordComponents(data, actions);
  return {
    content: formatDiscordFallback(event, data),
    embeds: [
      {
        title: truncateUnicode(
          `${tone.emoji} ${formatDiscordTitle(event, data)}`,
          DISCORD_EMBED_TITLE_MAX,
        ),
        description: formatDiscordDescription(event, data),
        color: tone.color,
        ...(data?.subject.pr?.url ? { url: data.subject.pr.url } : {}),
        fields,
        timestamp: event.timestamp.toISOString(),
        footer: { text: "Agent Orchestrator" },
      },
    ],
    ...(components.length > 0 ? { components } : {}),
    allowed_mentions: { parse: [] },
  };
}

const SLACK_SUCCESS_TONE: SlackTone = {
  emoji: ":white_check_mark:",
  label: "Complete",
  color: "#2EB67D",
};

const SLACK_PRIORITY_TONE: Record<EventPriority, SlackTone> = {
  urgent: {
    emoji: ":rotating_light:",
    label: "Urgent",
    color: "#E01E5A",
  },
  action: {
    emoji: ":point_right:",
    label: "Action required",
    color: "#6157D8",
  },
  warning: {
    emoji: ":warning:",
    label: "Warning",
    color: "#ECB22E",
  },
  info: {
    emoji: ":information_source:",
    label: "Information",
    color: "#36C5F0",
  },
};

function escapeSlackText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*/g, "&#42;")
    .replace(/_/g, "&#95;")
    .replace(/~/g, "&#126;")
    .replace(/`/g, "&#96;");
}

function formatSlackDate(date: Date): string {
  const timestamp = Math.floor(date.getTime() / 1000);
  return `<!date^${timestamp}^{date_short_pretty} {time}|${date.toISOString()}>`;
}

function slackToneForEvent(event: OrchestratorEvent): SlackTone {
  if (event.type === "merge.ready") return { ...SLACK_SUCCESS_TONE, label: "Ready to merge" };
  if (event.type === "summary.all_complete")
    return { ...SLACK_SUCCESS_TONE, label: "All complete" };
  if (event.type === "ci.failing" || event.type === "session.stuck")
    return SLACK_PRIORITY_TONE.urgent;
  if (event.type === "review.changes_requested") return SLACK_PRIORITY_TONE.warning;
  return SLACK_PRIORITY_TONE[event.priority] ?? SLACK_PRIORITY_TONE.info;
}

function formatSlackTitle(event: OrchestratorEvent, data: NotificationDataV3 | null): string {
  return formatDiscordTitle(event, data);
}

function formatSlackField(
  label: string,
  value: string | number | boolean | undefined | null,
): unknown {
  return {
    type: "mrkdwn",
    text: `*${escapeSlackText(label)}*\n${escapeSlackText(
      value === undefined || value === null || value === "" ? "Not available" : String(value),
    )}`,
  };
}

function buildSlackFieldBlocks(
  event: OrchestratorEvent,
  data: NotificationDataV3 | null,
): unknown[] {
  const pr = data?.subject.pr;
  const issue = data?.subject.issue;
  const branch = formatDiscordBranch(data);
  const fields = [
    formatSlackField("Project", event.projectId),
    formatSlackField("Session", event.sessionId),
    formatSlackField("Priority", slackToneForEvent(event).label),
    ...(pr
      ? [formatSlackField("Pull Request", `#${pr.number}${pr.title ? ` - ${pr.title}` : ""}`)]
      : []),
    ...(branch ? [formatSlackField("Branch", branch)] : []),
    ...(issue
      ? [formatSlackField("Issue", `${issue.id}${issue.title ? ` - ${issue.title}` : ""}`)]
      : []),
    ...(data?.ci?.status ? [formatSlackField("CI", titleCaseStatus(data.ci.status))] : []),
    ...(data?.review?.decision
      ? [formatSlackField("Review", titleCaseStatus(data.review.decision))]
      : []),
    ...(typeof data?.merge?.ready === "boolean"
      ? [formatSlackField("Merge", data.merge.ready ? "Ready" : "Not ready")]
      : []),
    ...(typeof data?.merge?.isBehind === "boolean"
      ? [formatSlackField("Sync", data.merge.isBehind ? "Behind base" : "Up to date")]
      : []),
  ].slice(0, 10);

  return fields.length > 0 ? [{ type: "section", fields }] : [];
}

function buildSlackStatusContext(data: NotificationDataV3 | null): unknown[] {
  if (!data) return [];
  const context: string[] = [];

  if (data.ci?.status) {
    const ciEmoji = data.ci.status === "passing" ? ":white_check_mark:" : ":x:";
    const failedChecks = data.ci.failedChecks?.map((check) => escapeSlackText(check.name)) ?? [];
    const failedText = failedChecks.length > 0 ? ` | Failed: ${failedChecks.join(", ")}` : "";
    context.push(`${ciEmoji} CI: ${escapeSlackText(data.ci.status)}${failedText}`);
  }

  if (typeof data.merge?.conflicts === "boolean") {
    context.push(
      data.merge.conflicts
        ? ":x: Merge conflicts detected"
        : ":white_check_mark: No merge conflicts",
    );
  }

  if (typeof data.review?.unresolvedThreads === "number") {
    context.push(`:speech_balloon: Review threads: ${data.review.unresolvedThreads}`);
  }

  if (data.merge?.blockers?.length) {
    context.push(
      `:no_entry: Blockers: ${data.merge.blockers.slice(0, 5).map(escapeSlackText).join(", ")}`,
    );
  }

  if (context.length === 0) return [];
  return [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: context.join("  •  ") }],
    },
  ];
}

function sanitizeSlackActionId(label: string, index: number): string {
  const sanitized = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `ao_${sanitized ? `${sanitized}_${index}` : `action_${index}`}`;
}

function buildSlackButton(label: string, url: string, style?: "primary" | "danger"): SlackButton {
  return {
    type: "button",
    text: { type: "plain_text", text: truncateUnicode(label, 75), emoji: true },
    url,
    ...(style ? { style } : {}),
  };
}

function buildSlackActionElements(
  data: NotificationDataV3 | null,
  actions?: NotifyAction[],
): SlackButton[] {
  const elements: SlackButton[] = [];
  const seenUrls = new Set<string>();
  const prUrl = data?.subject.pr?.url;
  const reviewUrl = data?.review?.url;

  if (prUrl) {
    elements.push(buildSlackButton("View PR", prUrl, "primary"));
    seenUrls.add(prUrl);
  }

  if (reviewUrl && !seenUrls.has(reviewUrl)) {
    elements.push(buildSlackButton("View Review", reviewUrl));
    seenUrls.add(reviewUrl);
  }

  for (const [index, action] of (actions ?? []).entries()) {
    if (action.url) {
      if (seenUrls.has(action.url)) continue;
      elements.push(
        buildSlackButton(action.label, action.url, elements.length === 0 ? "primary" : undefined),
      );
      seenUrls.add(action.url);
      continue;
    }
    if (!action.callbackEndpoint) continue;

    const label = truncateUnicode(action.label, 75);
    const lower = label.toLowerCase();
    elements.push({
      type: "button",
      text: { type: "plain_text", text: label, emoji: true },
      action_id: sanitizeSlackActionId(label, index),
      value: action.callbackEndpoint,
      ...(lower.includes("kill") || lower.includes("cancel") ? { style: "danger" } : {}),
    });
  }

  return elements.slice(0, 5);
}

function buildSlackAttachment(event: OrchestratorEvent, actions?: NotifyAction[]): SlackAttachment {
  const data = getNotificationDataV3(event.data);
  const tone = slackToneForEvent(event);
  const title = formatSlackTitle(event, data);
  const subtitle = data?.subject.pr?.title ?? data?.subject.summary;
  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: truncateUnicode(`${tone.emoji} ${title}`, 150),
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${subtitle ? `*${escapeSlackText(subtitle)}*\n` : ""}${escapeSlackText(event.message)}`,
      },
    },
    ...buildSlackFieldBlocks(event, data),
    ...buildSlackStatusContext(data),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Sent by Agent Orchestrator  •  ${formatSlackDate(event.timestamp)}`,
        },
      ],
    },
  ];

  const actionElements = buildSlackActionElements(data, actions);
  if (actionElements.length > 0) {
    blocks.push({
      type: "actions",
      elements: actionElements,
    });
  }

  blocks.push({ type: "divider" });

  return {
    color: tone.color,
    fallback: `${tone.label}: ${title} — ${event.message}`,
    blocks,
  };
}

function formatSlackMessagePayload(
  event: OrchestratorEvent,
  actions?: NotifyAction[],
): SlackMessagePayload {
  const attachment = buildSlackAttachment(event, actions);
  return {
    markdown_text: attachment.fallback,
    text: attachment.fallback,
    attachments: JSON.stringify([attachment]),
    unfurl_links: false,
    unfurl_media: false,
  };
}

function formatEmailSubject(event: OrchestratorEvent): string {
  const data = getNotificationDataV3(event.data);
  const pr = data?.subject.pr;

  switch (event.type) {
    case "ci.failing":
      return pr ? `[AO] CI failing on PR #${pr.number}` : "[AO] CI failing";
    case "merge.ready":
      return pr ? `[AO] PR #${pr.number} ready to merge` : "[AO] Merge ready";
    case "review.changes_requested":
      return pr ? `[AO] Changes requested on PR #${pr.number}` : "[AO] Review changes requested";
    case "session.needs_input":
      return `[AO] Agent needs input: ${event.sessionId}`;
    case "session.stuck":
      return `[AO] Agent stuck: ${event.sessionId}`;
    case "session.killed":
    case "session.exited":
      return `[AO] Agent exited: ${event.sessionId}`;
    case "pr.closed":
      return pr ? `[AO] PR #${pr.number} closed` : "[AO] PR closed";
    case "summary.all_complete":
      return "[AO] All sessions complete";
    default:
      return `[AO] ${titleCaseStatus(event.type)}: ${event.sessionId}`;
  }
}

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPE[char] ?? char);
}

function formatHtmlValue(value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null || value === "") return "Not available";
  return escapeHtml(String(value));
}

interface EmailTone {
  label: string;
  headerBackground: string;
  accent: string;
  badgeBackground: string;
  badgeText: string;
}

interface HtmlStatusCard {
  label: string;
  value: string;
  color?: string;
  background?: string;
}

const EMAIL_TONES: Record<"info" | "action" | "warning" | "urgent" | "success", EmailTone> = {
  info: {
    label: "Information",
    headerBackground: "#0f172a",
    accent: "#2563eb",
    badgeBackground: "#dbeafe",
    badgeText: "#1e40af",
  },
  action: {
    label: "Action required",
    headerBackground: "#1e3a8a",
    accent: "#4f46e5",
    badgeBackground: "#e0e7ff",
    badgeText: "#3730a3",
  },
  warning: {
    label: "Warning",
    headerBackground: "#78350f",
    accent: "#d97706",
    badgeBackground: "#fef3c7",
    badgeText: "#92400e",
  },
  urgent: {
    label: "Urgent",
    headerBackground: "#7f1d1d",
    accent: "#dc2626",
    badgeBackground: "#fee2e2",
    badgeText: "#991b1b",
  },
  success: {
    label: "Complete",
    headerBackground: "#064e3b",
    accent: "#16a34a",
    badgeBackground: "#dcfce7",
    badgeText: "#166534",
  },
};

function emailToneForEvent(event: OrchestratorEvent): EmailTone {
  if (event.type === "merge.ready" || event.type === "summary.all_complete") {
    return {
      ...EMAIL_TONES.success,
      label: event.type === "merge.ready" ? "Ready to merge" : "All complete",
    };
  }
  if (event.type === "ci.failing" || event.type === "session.stuck") return EMAIL_TONES.urgent;
  if (event.type === "review.changes_requested" || event.priority === "warning") {
    return EMAIL_TONES.warning;
  }
  if (event.priority === "action") return EMAIL_TONES.action;
  if (event.priority === "urgent") return EMAIL_TONES.urgent;
  return EMAIL_TONES.info;
}

function formatEmailTitle(event: OrchestratorEvent, data: NotificationDataV3 | null): string {
  const pr = data?.subject.pr;

  switch (event.type) {
    case "ci.failing":
      return pr ? `CI is failing on PR #${pr.number}` : "CI is failing";
    case "merge.ready":
      return pr ? `PR #${pr.number} is ready to merge` : "Pull request is ready to merge";
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

function formatEmailSubtitle(event: OrchestratorEvent, data: NotificationDataV3 | null): string {
  return data?.subject.pr?.title ?? data?.subject.summary ?? event.message;
}

function formatHtmlStatusCard(card: HtmlStatusCard, fallback: EmailTone): string {
  return `<td style="padding:6px;width:50%;vertical-align:top;">
    <div style="border:1px solid #e5e7eb;border-radius:10px;background:#ffffff;padding:14px 16px;">
      <div style="font-size:12px;line-height:16px;color:#6b7280;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(card.label)}</div>
      <div style="margin-top:8px;display:inline-block;border-radius:999px;background:${card.background ?? fallback.badgeBackground};color:${card.color ?? fallback.badgeText};font-size:13px;line-height:18px;font-weight:800;padding:5px 10px;">${escapeHtml(card.value)}</div>
    </div>
  </td>`;
}

function formatHtmlStatusCards(cards: HtmlStatusCard[], tone: EmailTone): string {
  if (cards.length === 0) return "";

  const rows: string[] = [];
  for (let index = 0; index < cards.length; index += 2) {
    const first = cards[index];
    const second = cards[index + 1];
    rows.push(`<tr>
      ${formatHtmlStatusCard(first, tone)}
      ${second ? formatHtmlStatusCard(second, tone) : '<td style="padding:6px;width:50%;"></td>'}
    </tr>`);
  }

  return `<tr>
    <td style="padding:6px 22px 4px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
        ${rows.join("")}
      </table>
    </td>
  </tr>`;
}

function formatHtmlDetailRow(
  label: string,
  value: string | number | boolean | undefined | null,
): string {
  return `<tr>
    <td style="padding:9px 0;color:#6b7280;font-size:13px;line-height:18px;width:150px;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:9px 0;color:#111827;font-size:13px;line-height:18px;font-weight:600;vertical-align:top;">${formatHtmlValue(value)}</td>
  </tr>`;
}

function formatHtmlDetails(
  rows: Array<[string, string | number | boolean | undefined | null]>,
): string {
  const renderedRows = rows
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => formatHtmlDetailRow(label, value));

  if (renderedRows.length === 0) return "";

  return `<div style="border-top:1px solid #e5e7eb;padding-top:18px;">
    <div style="font-size:12px;line-height:16px;color:#6b7280;font-weight:800;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">Details</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      ${renderedRows.join("")}
    </table>
  </div>`;
}

function formatHtmlList(title: string, items: string[]): string {
  const filtered = items.filter(Boolean);
  if (filtered.length === 0) return "";

  return `<div style="margin-top:18px;">
    <div style="font-size:12px;line-height:16px;color:#6b7280;font-weight:800;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">${escapeHtml(title)}</div>
    <ul style="margin:0;padding:0 0 0 18px;color:#374151;font-size:13px;line-height:21px;">
      ${filtered.map((item) => `<li style="margin:0 0 6px;">${item}</li>`).join("")}
    </ul>
  </div>`;
}

function formatHtmlCheck(check: NotificationCICheck): string {
  const status = check.conclusion ? `${check.status}/${check.conclusion}` : check.status;
  const label = `${check.name}: ${status}`;
  if (!check.url) return escapeHtml(label);
  return `<a href="${escapeHtml(check.url)}" style="color:#2563eb;text-decoration:none;font-weight:700;">${escapeHtml(label)}</a>`;
}

function formatHtmlContextList(data: Record<string, unknown>): string {
  const items = Object.entries(data)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 8)
    .map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(truncate(String(value)))}`);

  return formatHtmlList("Context", items);
}

function formatHtmlActionButtons(actions: NotifyAction[] | undefined): string {
  if (!actions || actions.length === 0) return "";

  const buttons = actions
    .map((action) => {
      const target = action.url ?? action.callbackEndpoint;
      if (!target) {
        return `<span style="display:inline-block;margin:0 8px 8px 0;border:1px solid #d1d5db;border-radius:8px;padding:10px 14px;color:#374151;font-size:13px;font-weight:700;">${escapeHtml(action.label)}</span>`;
      }

      return `<a href="${escapeHtml(target)}" style="display:inline-block;margin:0 8px 8px 0;border-radius:8px;background:#111827;color:#ffffff;text-decoration:none;padding:10px 14px;font-size:13px;font-weight:800;">${escapeHtml(action.label)}</a>`;
    })
    .join("");

  return `<div style="margin-top:18px;">
    <div style="font-size:12px;line-height:16px;color:#6b7280;font-weight:800;text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;">Actions</div>
    ${buttons}
  </div>`;
}

function buildEmailStatusCards(
  event: OrchestratorEvent,
  data: NotificationDataV3 | null,
): HtmlStatusCard[] {
  const cards: HtmlStatusCard[] = [
    { label: "Status", value: priorityLabel(event.priority) },
    { label: "Event", value: titleCaseStatus(event.type) },
  ];

  if (!data) return cards;

  if (data.ci?.status) {
    const failing = data.ci.status === "failing";
    cards.push({
      label: "CI",
      value: titleCaseStatus(data.ci.status),
      color: failing ? "#991b1b" : "#166534",
      background: failing ? "#fee2e2" : "#dcfce7",
    });
  }

  if (data.review?.decision) {
    const approved = data.review.decision === "approved";
    cards.push({
      label: "Review",
      value: titleCaseStatus(data.review.decision),
      color: approved ? "#166534" : "#92400e",
      background: approved ? "#dcfce7" : "#fef3c7",
    });
  }

  if (typeof data.merge?.ready === "boolean") {
    cards.push({
      label: "Merge",
      value: data.merge.ready ? "Ready" : "Not ready",
      color: data.merge.ready ? "#166534" : "#92400e",
      background: data.merge.ready ? "#dcfce7" : "#fef3c7",
    });
  }

  if (typeof data.merge?.conflicts === "boolean") {
    cards.push({
      label: "Conflicts",
      value: data.merge.conflicts ? "Found" : "None",
      color: data.merge.conflicts ? "#991b1b" : "#166534",
      background: data.merge.conflicts ? "#fee2e2" : "#dcfce7",
    });
  }

  if (typeof data.merge?.isBehind === "boolean") {
    cards.push({
      label: "Sync",
      value: data.merge.isBehind ? "Behind base" : "Up to date",
      color: data.merge.isBehind ? "#92400e" : "#166534",
      background: data.merge.isBehind ? "#fef3c7" : "#dcfce7",
    });
  }

  if (typeof data.review?.unresolvedThreads === "number") {
    cards.push({
      label: "Threads",
      value: String(data.review.unresolvedThreads),
      color: data.review.unresolvedThreads > 0 ? "#92400e" : "#166534",
      background: data.review.unresolvedThreads > 0 ? "#fef3c7" : "#dcfce7",
    });
  }

  return cards.slice(0, 8);
}

function formatEmailHtml(event: OrchestratorEvent, actions?: NotifyAction[]): string {
  const data = getNotificationDataV3(event.data);
  const tone = emailToneForEvent(event);
  const pr = data?.subject.pr;
  const issue = data?.subject.issue;
  const title = formatEmailTitle(event, data);
  const subtitle = formatEmailSubtitle(event, data);
  const branchLine =
    pr?.branch && pr.baseBranch
      ? `${pr.branch} -> ${pr.baseBranch}`
      : (pr?.branch ?? pr?.baseBranch);
  const primaryUrl = pr?.url ?? data?.review?.url;
  const primaryLabel = pr?.url ? "View pull request" : data?.review?.url ? "View review" : "";
  const primaryCta = primaryUrl
    ? `<a href="${escapeHtml(primaryUrl)}" style="display:inline-block;background:${tone.accent};color:#ffffff;text-decoration:none;border-radius:8px;padding:13px 18px;font-size:14px;line-height:18px;font-weight:800;">${escapeHtml(primaryLabel)}</a>`
    : "";
  const detailRows: Array<[string, string | number | boolean | undefined | null]> = [
    ["Project", event.projectId],
    ["Session", event.sessionId],
    ["Pull Request", pr ? `#${pr.number}${pr.title ? ` - ${pr.title}` : ""}` : undefined],
    ["Branch", branchLine],
    ["Issue", issue ? `${issue.id}${issue.title ? ` - ${issue.title}` : ""}` : undefined],
    [
      "Transition",
      data?.transition ? `${data.transition.from} -> ${data.transition.to}` : undefined,
    ],
    ["Reaction", data?.reaction ? `${data.reaction.key} -> ${data.reaction.action}` : undefined],
    [
      "Escalation",
      data?.escalation
        ? `${data.escalation.attempts} attempts (${data.escalation.cause})`
        : undefined,
    ],
    ["Time", event.timestamp.toISOString()],
  ];
  const checks = (data?.ci?.failedChecks ?? []).slice(0, 10).map(formatHtmlCheck);
  const blockers = (data?.merge?.blockers ?? []).slice(0, 10).map(escapeHtml);
  const links = [
    ...(pr?.url
      ? [
          `<a href="${escapeHtml(pr.url)}" style="color:#2563eb;text-decoration:none;font-weight:700;">Pull request</a>`,
        ]
      : []),
    ...(data?.review?.url
      ? [
          `<a href="${escapeHtml(data.review.url)}" style="color:#2563eb;text-decoration:none;font-weight:700;">Review</a>`,
        ]
      : []),
  ];

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(formatEmailSubject(event))}</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:28px 0;">
      <tr>
        <td align="center" style="padding:0 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="background:${tone.headerBackground};padding:24px 28px;">
                <div style="font-size:12px;line-height:16px;color:${tone.badgeBackground};font-weight:800;text-transform:uppercase;letter-spacing:.08em;">${escapeHtml(tone.label)}</div>
                <h1 style="margin:10px 0 0;color:#ffffff;font-size:24px;line-height:31px;font-weight:800;">${escapeHtml(title)}</h1>
                <p style="margin:10px 0 0;color:#cbd5e1;font-size:14px;line-height:22px;">${escapeHtml(subtitle)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px 10px;">
                <p style="margin:0;color:#374151;font-size:15px;line-height:24px;">${escapeHtml(event.message)}</p>
                <div style="margin-top:18px;">${primaryCta}</div>
              </td>
            </tr>
            ${formatHtmlStatusCards(buildEmailStatusCards(event, data), tone)}
            <tr>
              <td style="padding:12px 28px 6px;">
                ${formatHtmlDetails(detailRows)}
                ${formatHtmlList("Checks", checks)}
                ${formatHtmlList("Blockers", blockers)}
                ${formatHtmlList("Links", links)}
                ${data ? "" : formatHtmlContextList(event.data)}
                ${formatHtmlActionButtons(actions)}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px 24px;">
                <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:13px 14px;color:#6b7280;font-size:12px;line-height:18px;">
                  Sent by Agent Orchestrator.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function formatEmailBody(event: OrchestratorEvent, actions?: NotifyAction[]): string {
  return formatEmailHtml(event, actions);
}

function formatPostEmailBody(message: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(GMAIL_POST_SUBJECT)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:28px 0;">
      <tr>
        <td align="center" style="padding:0 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="background:#0f172a;padding:22px 26px;">
                <div style="font-size:12px;line-height:16px;color:#dbeafe;font-weight:800;text-transform:uppercase;letter-spacing:.08em;">Agent Orchestrator</div>
                <h1 style="margin:10px 0 0;color:#ffffff;font-size:22px;line-height:29px;font-weight:800;">Message</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 26px;color:#374151;font-size:15px;line-height:24px;white-space:pre-wrap;">${escapeHtml(message)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function isHtmlEmailBody(body: string): boolean {
  return /^\s*(?:<!doctype html|<html[\s>])/i.test(body);
}

function normalizeSlackChannel(channel: string | undefined): string | undefined {
  return channel?.replace(/^#/, "");
}

function formatUnknownError(value: unknown): string {
  if (value instanceof Error) {
    const cause = (value as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      const causeMessage = formatUnknownError(cause);
      if (causeMessage && !value.message.includes(causeMessage)) {
        return `${value.message}: ${causeMessage}`;
      }
    }
    return value.message;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatComposioError(err: unknown, app: ComposioApp, discordMode?: DiscordMode): Error {
  const message = formatUnknownError(err);
  const lower = message.toLowerCase();
  if (lower.includes("connected account") || lower.includes("could not find a connection")) {
    const setupCommand = setupCommandForApp(app, discordMode);
    if (app === "discord" && discordMode === "webhook") {
      return new Error(
        `[notifier-composio] ${message}. Run \`${setupCommand}\` to create or refresh the Discord webhook connected account for this userId.`,
      );
    }
    return new Error(
      `[notifier-composio] ${message}. Run \`${setupCommand}\`, connect ${app} in Composio, or set connectedAccountId / userId. entityId is still supported as an alias for userId.`,
    );
  }

  return err instanceof Error ? err : new Error(message);
}

function setupCommandForApp(app: ComposioApp, discordMode?: DiscordMode): string {
  if (app === "discord") {
    return discordMode === "webhook"
      ? "ao setup composio-discord"
      : "ao setup composio-discord-bot";
  }
  if (app === "gmail") return "ao setup composio-mail";
  return "ao setup composio";
}

function buildToolArgs(
  app: ComposioApp,
  discordMode: DiscordMode | undefined,
  text: string,
  channelId?: string,
  channelName?: string,
  emailTo?: string,
  webhookUrl?: string,
  emailSubject: string = GMAIL_SUBJECT,
  discordPayload?: DiscordMessagePayload,
  slackPayload?: SlackMessagePayload,
): Record<string, unknown> {
  if (app === "slack") {
    const args: Record<string, unknown> = slackPayload
      ? { ...slackPayload }
      : { markdown_text: text };
    const channel = channelId ?? normalizeSlackChannel(channelName);
    if (channel) args.channel = channel;
    return args;
  }

  if (app === "discord") {
    const messagePayload: Record<string, unknown> = discordPayload
      ? { ...discordPayload }
      : {
          content: text,
          allowed_mentions: { parse: [] },
        };

    if (discordMode === "webhook") {
      if (!webhookUrl) {
        throw new Error(
          '[notifier-composio] webhookUrl is required when defaultApp is "discord" and mode is "webhook"',
        );
      }
      const parsed = parseDiscordWebhookUrl(webhookUrl);
      return {
        webhook_id: parsed.webhookId,
        webhook_token: parsed.webhookToken,
        ...messagePayload,
      };
    }

    const args: Record<string, unknown> = { ...messagePayload };
    // Discord requires numeric channel IDs — channelName is accepted as a manual fallback.
    if (channelId) args.channel_id = channelId;
    else if (channelName) args.channel_id = channelName;
    else {
      throw new Error(
        '[notifier-composio] channelId is required when defaultApp is "discord" and mode is "bot"',
      );
    }
    return args;
  }

  return {
    recipient_email: emailTo ?? "",
    subject: emailSubject,
    body: text,
    ...(isHtmlEmailBody(text) ? { is_html: true } : {}),
  };
}

function resolveToolVersion(
  config: Record<string, unknown> | undefined,
  app: ComposioApp,
): string | undefined {
  const toolVersions = config?.["toolVersions"];
  if (toolVersions && typeof toolVersions === "object") {
    const appVersion = (toolVersions as Record<string, unknown>)[app];
    if (typeof appVersion === "string" && appVersion.trim().length > 0) {
      return appVersion;
    }
  }

  return stringConfig(config, "toolVersion") ?? DEFAULT_TOOL_VERSION[app];
}

function resolveToolSlug(app: ComposioApp, discordMode: DiscordMode | undefined): string {
  if (app === "discord" && discordMode === "webhook") return DISCORD_WEBHOOK_TOOL_SLUG;
  return APP_TOOL_SLUG[app];
}

export function create(config?: Record<string, unknown>): Notifier {
  const apiKey =
    resolveEnvReference(stringConfig(config, "composioApiKey")) ?? process.env.COMPOSIO_API_KEY;
  const defaultApp: ComposioApp =
    typeof config?.defaultApp === "string" && VALID_APPS.has(config.defaultApp)
      ? (config.defaultApp as ComposioApp)
      : "slack";
  const channelName = stringConfig(config, "channelName");
  const channelId = stringConfig(config, "channelId");
  const webhookUrl = resolveEnvReference(stringConfig(config, "webhookUrl"));
  const discordMode = resolveDiscordMode(config, defaultApp, webhookUrl);
  const userId =
    stringConfig(config, "userId") ??
    stringConfig(config, "entityId") ??
    process.env.COMPOSIO_USER_ID ??
    process.env.COMPOSIO_ENTITY_ID ??
    DEFAULT_COMPOSIO_USER_ID;
  const emailTo = stringConfig(config, "emailTo");
  const toolVersion = resolveToolVersion(config, defaultApp);
  const forceSkipVersionCheck = boolConfig(config, "dangerouslySkipVersionCheck");
  const connectedAccountId = stringConfig(config, "connectedAccountId");

  const clientOverride =
    config?._clientOverride !== undefined && config._clientOverride !== null
      ? config._clientOverride
      : undefined;

  if (clientOverride !== undefined && !isComposioToolsClient(clientOverride)) {
    throw new Error("[notifier-composio] _clientOverride must expose tools.execute()");
  }

  if (typeof config?.defaultApp === "string" && !VALID_APPS.has(config.defaultApp)) {
    throw new Error(
      `[notifier-composio] Invalid defaultApp: "${config.defaultApp}". Must be one of: slack, discord, gmail`,
    );
  }

  if (defaultApp === "gmail" && !emailTo) {
    throw new Error('[notifier-composio] emailTo is required when defaultApp is "gmail"');
  }

  if (defaultApp === "discord" && discordMode === "webhook" && !webhookUrl) {
    throw new Error(
      '[notifier-composio] webhookUrl is required when defaultApp is "discord" and mode is "webhook"',
    );
  }

  let client: ComposioToolsClient | null | undefined = clientOverride as
    | ComposioToolsClient
    | undefined;
  let warnedNoKey = false;
  let warnedSkipVersion = false;
  let sdkMissing = false;

  async function getClient(): Promise<ComposioToolsClient | null> {
    if (clientOverride) return clientOverride as ComposioToolsClient;

    if (!apiKey) {
      if (!warnedNoKey) {
        console.warn(
          "[notifier-composio] No composioApiKey or COMPOSIO_API_KEY configured — notifications will be no-ops",
        );
        warnedNoKey = true;
      }
      return null;
    }

    if (sdkMissing) return null;

    if (client === undefined) {
      client = await loadComposioSDK(apiKey);
      if (client === null) {
        sdkMissing = true;
        console.warn(
          "[notifier-composio] @composio/core package is not installed — notifications will be no-ops.",
        );
        return null;
      }
    }

    return client;
  }

  async function executeWithTimeout(
    composio: ComposioToolsClient,
    action: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    const timeoutMs = 30_000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const executeParams: ComposioExecuteParams = {
      userId,
      arguments: args,
      ...(connectedAccountId ? { connectedAccountId } : {}),
      ...(toolVersion ? { version: toolVersion } : { dangerouslySkipVersionCheck: true }),
      ...(forceSkipVersionCheck ? { dangerouslySkipVersionCheck: true } : {}),
    };

    if (!toolVersion && !warnedSkipVersion) {
      console.warn(
        `[notifier-composio] No toolVersion configured for ${defaultApp}; using Composio latest-version execution.`,
      );
      warnedSkipVersion = true;
    }

    const actionPromise = composio.tools.execute(action, executeParams);
    // Prevent unhandled rejection if the timeout fires and actionPromise later rejects.
    actionPromise.catch(() => {});

    const result = await Promise.race([
      actionPromise,
      new Promise<never>((_, reject) => {
        timeoutSignal.addEventListener(
          "abort",
          () => {
            reject(
              new Error(
                `[notifier-composio] Composio API call timed out after ${timeoutMs / 1000}s`,
              ),
            );
          },
          { once: true },
        );
      }),
    ]).catch((err: unknown) => {
      throw formatComposioError(err, defaultApp, discordMode);
    });

    if (result.successful === false) {
      throw new Error(
        `[notifier-composio] Composio action ${action} failed: ${formatUnknownError(result.error ?? "unknown error")}`,
      );
    }
  }

  function assertGmailConnectedAccount(): void {
    if (defaultApp === "gmail" && !connectedAccountId) {
      throw new Error(
        '[notifier-composio] connectedAccountId is required when defaultApp is "gmail". Connect Gmail in Composio, then run `ao setup composio-mail`, or set notifiers.<name>.connectedAccountId.',
      );
    }
  }

  return {
    name: "composio",

    async notify(event: OrchestratorEvent): Promise<void> {
      const composio = await getClient();
      if (!composio) return;
      assertGmailConnectedAccount();

      const text = defaultApp === "gmail" ? formatEmailBody(event) : formatNotifyText(event);
      const emailSubject = defaultApp === "gmail" ? formatEmailSubject(event) : undefined;
      const discordPayload =
        defaultApp === "discord" ? formatDiscordMessagePayload(event) : undefined;
      const slackPayload = defaultApp === "slack" ? formatSlackMessagePayload(event) : undefined;
      const toolSlug = resolveToolSlug(defaultApp, discordMode);
      const args = buildToolArgs(
        defaultApp,
        discordMode,
        text,
        channelId,
        channelName,
        emailTo,
        webhookUrl,
        emailSubject,
        discordPayload,
        slackPayload,
      );

      await executeWithTimeout(composio, toolSlug, args);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      const composio = await getClient();
      if (!composio) return;
      assertGmailConnectedAccount();

      const text =
        defaultApp === "gmail"
          ? formatEmailBody(event, actions)
          : formatActionsText(event, actions);
      const emailSubject = defaultApp === "gmail" ? formatEmailSubject(event) : undefined;
      const discordPayload =
        defaultApp === "discord" ? formatDiscordMessagePayload(event, actions) : undefined;
      const slackPayload =
        defaultApp === "slack" ? formatSlackMessagePayload(event, actions) : undefined;
      const toolSlug = resolveToolSlug(defaultApp, discordMode);
      const args = buildToolArgs(
        defaultApp,
        discordMode,
        text,
        channelId,
        channelName,
        emailTo,
        webhookUrl,
        emailSubject,
        discordPayload,
        slackPayload,
      );

      await executeWithTimeout(composio, toolSlug, args);
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      const composio = await getClient();
      if (!composio) return null;
      assertGmailConnectedAccount();

      const channel = context?.channel ?? channelId ?? channelName;
      const slackChannel = normalizeSlackChannel(channel);
      const toolSlug = resolveToolSlug(defaultApp, discordMode);

      const args: Record<string, unknown> =
        defaultApp === "gmail"
          ? {
              recipient_email: emailTo ?? "",
              subject: GMAIL_POST_SUBJECT,
              body: formatPostEmailBody(message),
              is_html: true,
            }
          : defaultApp === "discord"
            ? buildToolArgs(
                defaultApp,
                discordMode,
                message,
                discordMode === "bot" ? channel : channelId,
                channelName,
                emailTo,
                webhookUrl,
              )
            : { markdown_text: message, ...(slackChannel ? { channel: slackChannel } : {}) };

      await executeWithTimeout(composio, toolSlug, args);
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
