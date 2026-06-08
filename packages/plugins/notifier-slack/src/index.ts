import {
  getNotificationDataV3,
  validateUrl,
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
  type EventPriority,
  type NotificationDataV3,
  CI_STATUS,
} from "@aoagents/ao-core";

export const manifest = {
  name: "slack",
  slot: "notifier" as const,
  description: "Notifier plugin: Slack webhook notifications",
  version: "0.1.0",
};

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

const SUCCESS_TONE: SlackTone = {
  emoji: ":white_check_mark:",
  label: "Complete",
  color: "#2EB67D",
};

const PRIORITY_TONE: Record<EventPriority, SlackTone> = {
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

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function titleCaseStatus(value: string): string {
  return value
    .split(/[_\s.-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatSlackDate(date: Date): string {
  const timestamp = Math.floor(date.getTime() / 1000);
  return `<!date^${timestamp}^{date_short_pretty} {time}|${date.toISOString()}>`;
}

function toneForEvent(event: OrchestratorEvent): SlackTone {
  if (event.type === "merge.ready") {
    return { ...SUCCESS_TONE, label: "Ready to merge" };
  }
  if (event.type === "summary.all_complete") {
    return { ...SUCCESS_TONE, label: "All complete" };
  }
  if (event.type === "ci.failing" || event.type === "session.stuck") {
    return PRIORITY_TONE.urgent;
  }
  if (event.type === "review.changes_requested") {
    return PRIORITY_TONE.warning;
  }
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

function formatField(label: string, value: string | number | boolean | undefined | null): unknown {
  return {
    type: "mrkdwn",
    text: `*${escapeSlackText(label)}*\n${escapeSlackText(
      value === undefined || value === null || value === "" ? "Not available" : String(value),
    )}`,
  };
}

function buildFieldBlocks(event: OrchestratorEvent, data: NotificationDataV3 | null): unknown[] {
  const pr = data?.subject.pr;
  const issue = data?.subject.issue;
  const branch =
    pr?.branch && pr.baseBranch
      ? `${pr.branch} -> ${pr.baseBranch}`
      : (pr?.branch ?? pr?.baseBranch ?? data?.subject.branch);
  const fields = [
    formatField("Project", event.projectId),
    formatField("Session", event.sessionId),
    formatField("Priority", toneForEvent(event).label),
    ...(pr
      ? [formatField("Pull Request", `#${pr.number}${pr.title ? ` - ${pr.title}` : ""}`)]
      : []),
    ...(branch ? [formatField("Branch", branch)] : []),
    ...(issue
      ? [formatField("Issue", `${issue.id}${issue.title ? ` - ${issue.title}` : ""}`)]
      : []),
    ...(data?.ci?.status ? [formatField("CI", titleCaseStatus(data.ci.status))] : []),
    ...(data?.review?.decision
      ? [formatField("Review", titleCaseStatus(data.review.decision))]
      : []),
    ...(typeof data?.merge?.ready === "boolean"
      ? [formatField("Merge", data.merge.ready ? "Ready" : "Not ready")]
      : []),
    ...(typeof data?.merge?.isBehind === "boolean"
      ? [formatField("Sync", data.merge.isBehind ? "Behind base" : "Up to date")]
      : []),
  ].slice(0, 10);

  if (fields.length === 0) return [];
  return [{ type: "section", fields }];
}

function buildStatusContext(data: NotificationDataV3 | null): unknown[] {
  if (!data) return [];
  const context: string[] = [];

  if (data.ci?.status) {
    const ciEmoji = data.ci.status === CI_STATUS.PASSING ? ":white_check_mark:" : ":x:";
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

function sanitizeActionId(label: string, index: number): string {
  const sanitized = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `ao_${sanitized ? `${sanitized}_${index}` : `action_${index}`}`;
}

function buildButton(label: string, url: string, style?: "primary" | "danger"): SlackButton {
  return {
    type: "button",
    text: { type: "plain_text", text: truncate(label, 75), emoji: true },
    url,
    ...(style ? { style } : {}),
  };
}

function buildActionElements(
  data: NotificationDataV3 | null,
  actions?: NotifyAction[],
): SlackButton[] {
  const elements: SlackButton[] = [];
  const seenUrls = new Set<string>();
  const prUrl = data?.subject.pr?.url;
  const reviewUrl = data?.review?.url;

  if (prUrl) {
    elements.push(buildButton("View PR", prUrl, "primary"));
    seenUrls.add(prUrl);
  }
  if (reviewUrl && !seenUrls.has(reviewUrl)) {
    elements.push(buildButton("View Review", reviewUrl));
    seenUrls.add(reviewUrl);
  }

  for (const [index, action] of (actions ?? []).entries()) {
    if (action.url) {
      if (seenUrls.has(action.url)) continue;
      elements.push(
        buildButton(action.label, action.url, elements.length === 0 ? "primary" : undefined),
      );
      seenUrls.add(action.url);
      continue;
    }
    if (!action.callbackEndpoint) continue;

    const label = truncate(action.label, 75);
    const lower = label.toLowerCase();
    elements.push({
      type: "button",
      text: { type: "plain_text", text: label, emoji: true },
      action_id: sanitizeActionId(label, index),
      value: action.callbackEndpoint,
      ...(lower.includes("kill") || lower.includes("cancel") ? { style: "danger" } : {}),
    });
  }

  return elements.slice(0, 5);
}

function buildFallbackText(event: OrchestratorEvent, data: NotificationDataV3 | null): string {
  const tone = toneForEvent(event);
  return `${tone.label}: ${eventTitle(event, data)} — ${event.message}`;
}

function buildAttachment(event: OrchestratorEvent, actions?: NotifyAction[]): SlackAttachment {
  const data = getNotificationDataV3(event.data);
  const tone = toneForEvent(event);
  const title = eventTitle(event, data);
  const subtitle = data?.subject.pr?.title ?? data?.subject.summary;
  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: truncate(`${tone.emoji} ${title}`, 150),
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
    ...buildFieldBlocks(event, data),
    ...buildStatusContext(data),
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

  const actionElements = buildActionElements(data, actions);
  if (actionElements.length > 0) {
    blocks.push({
      type: "actions",
      elements: actionElements,
    });
  }

  blocks.push({ type: "divider" });

  return {
    color: tone.color,
    fallback: buildFallbackText(event, data),
    blocks,
  };
}

async function postToWebhook(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack webhook failed (${response.status}): ${body}`);
  }
}

export function create(config?: Record<string, unknown>): Notifier {
  const webhookUrl = config?.webhookUrl as string | undefined;
  const defaultChannel = config?.channel as string | undefined;
  const username = (config?.username as string) ?? "Agent Orchestrator";

  if (!webhookUrl) {
    console.warn("[notifier-slack] No webhookUrl configured — notifications will be no-ops");
  } else {
    validateUrl(webhookUrl, "notifier-slack");
  }

  return {
    name: "slack",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!webhookUrl) return;

      const attachment = buildAttachment(event);
      const payload: Record<string, unknown> = {
        username,
        text: attachment.fallback,
        attachments: [attachment],
      };
      if (defaultChannel) payload.channel = defaultChannel;

      await postToWebhook(webhookUrl, payload);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!webhookUrl) return;

      const attachment = buildAttachment(event, actions);
      const payload: Record<string, unknown> = {
        username,
        text: attachment.fallback,
        attachments: [attachment],
      };
      if (defaultChannel) payload.channel = defaultChannel;

      await postToWebhook(webhookUrl, payload);
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      if (!webhookUrl) return null;

      const channel = context?.channel ?? defaultChannel;
      const payload: Record<string, unknown> = {
        username,
        text: message,
      };
      if (channel) payload.channel = channel;

      await postToWebhook(webhookUrl, payload);
      // Incoming webhooks don't return a message ID
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
