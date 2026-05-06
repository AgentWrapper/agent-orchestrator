import {
  validateUrl,
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
  type EventPriority,
  CI_STATUS,
} from "@aoagents/ao-core";

export const manifest = {
  name: "slack",
  slot: "notifier" as const,
  description: "Notifier plugin: Slack webhook notifications",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: ":rotating_light:",
  action: ":point_right:",
  warning: ":warning:",
  info: ":information_source:",
};

function buildBlocks(event: OrchestratorEvent, actions?: NotifyAction[]): unknown[] {
  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${PRIORITY_EMOJI[event.priority]} ${event.type} — ${event.sessionId}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: event.message,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*Project:* ${event.projectId} | *Priority:* ${event.priority} | *Time:* <!date^${Math.floor(event.timestamp.getTime() / 1000)}^{date_short_pretty} {time}|${event.timestamp.toISOString()}>`,
        },
      ],
    },
  ];

  // Add PR link if available (type-guarded)
  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:github: <${prUrl}|View Pull Request>`,
      },
    });
  }

  // Add CI status if available (type-guarded)
  const ciStatus = typeof event.data.ciStatus === "string" ? event.data.ciStatus : undefined;
  if (ciStatus) {
    const ciEmoji = ciStatus === CI_STATUS.PASSING ? ":white_check_mark:" : ":x:";
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${ciEmoji} CI: ${ciStatus}`,
        },
      ],
    });
  }

  // Add action buttons
  if (actions && actions.length > 0) {
    const elements = actions
      .filter((a) => a.url || a.callbackEndpoint)
      .map((action) => {
        if (action.url) {
          return {
            type: "button",
            text: { type: "plain_text", text: action.label, emoji: true },
            url: action.url,
          };
        }
        const sanitized = action.label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "");
        const idx = actions.indexOf(action);
        const actionId = sanitized ? `${sanitized}_${idx}` : `action_${idx}`;
        return {
          type: "button",
          text: { type: "plain_text", text: action.label, emoji: true },
          action_id: `ao_${actionId}`,
          value: action.callbackEndpoint,
        };
      });

    if (elements.length > 0) {
      blocks.push({
        type: "actions",
        elements,
      });
    }
  }

  blocks.push({ type: "divider" });

  return blocks;
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

      const payload: Record<string, unknown> = {
        username,
        blocks: buildBlocks(event),
      };
      if (defaultChannel) payload.channel = defaultChannel;

      await postToWebhook(webhookUrl, payload);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!webhookUrl) return;

      const payload: Record<string, unknown> = {
        username,
        blocks: buildBlocks(event, actions),
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
