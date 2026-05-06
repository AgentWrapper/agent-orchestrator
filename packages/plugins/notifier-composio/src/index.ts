import type {
  PluginModule,
  Notifier,
  OrchestratorEvent,
  NotifyAction,
  NotifyContext,
  EventPriority,
} from "@aoagents/ao-core";

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

type ComposioApp = "slack" | "discord" | "gmail";

const APP_TOOL_SLUG: Record<ComposioApp, string> = {
  slack: "SLACK_SEND_MESSAGE",
  discord: "DISCORD_SEND_MESSAGE",
  gmail: "GMAIL_SEND_EMAIL",
};

const VALID_APPS = new Set<string>(["slack", "discord", "gmail"]);

const GMAIL_SUBJECT = "Agent Orchestrator Notification";

interface ComposioToolkit {
  executeAction(params: {
    action: string;
    params: Record<string, unknown>;
    entityId?: string;
  }): Promise<{ successful: boolean; data?: unknown; error?: string }>;
}

/**
 * Lazy-load composio-core SDK.
 * Returns null if the package is not installed.
 *
 * We use dynamic import + unknown casting because composio-core is an
 * optional peer dependency — it may or may not be installed, and its
 * TypeScript types may not match our internal interface exactly.
 */
async function loadComposioSDK(apiKey: string): Promise<ComposioToolkit | null> {
  try {
    // String literal import so vitest can intercept it for mocking.
    // The `as unknown as …` cast is safe because we validate the shape below.
    const mod = (await import("composio-core")) as unknown as Record<string, unknown>;
    const ComposioClass = (mod.Composio ??
      (mod.default as Record<string, unknown> | undefined)?.Composio ??
      mod.default) as (new (opts: { apiKey: string }) => unknown) | undefined;
    if (typeof ComposioClass !== "function") {
      throw new Error("Could not find Composio class in composio-core module");
    }
    const client = new ComposioClass({ apiKey });
    return client as ComposioToolkit;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (
      message.includes("Cannot find module") ||
      message.includes("Cannot find package") ||
      message.includes("MODULE_NOT_FOUND") ||
      code === "ERR_MODULE_NOT_FOUND"
    ) {
      return null;
    }
    throw err;
  }
}

function formatNotifyText(event: OrchestratorEvent): string {
  const emoji = PRIORITY_EMOJI[event.priority];
  const parts = [`${emoji} *${event.type}* — ${event.sessionId}`, event.message];

  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) {
    parts.push(`PR: ${prUrl}`);
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

function buildToolArgs(
  app: ComposioApp,
  text: string,
  channelId?: string,
  channelName?: string,
  emailTo?: string,
): Record<string, unknown> {
  if (app === "slack") {
    const args: Record<string, unknown> = { text };
    if (channelId) args.channel = channelId;
    else if (channelName) args.channel = channelName;
    return args;
  }

  if (app === "discord") {
    const args: Record<string, unknown> = { content: text };
    // Discord requires numeric channel IDs — channelName is not supported
    if (channelId) args.channel_id = channelId;
    else if (channelName) args.channel_id = channelName;
    return args;
  }

  // gmail — emailTo is required, validated at config time
  return {
    to: emailTo ?? "",
    subject: GMAIL_SUBJECT,
    body: text,
  };
}

export function create(config?: Record<string, unknown>): Notifier {
  const apiKey =
    (typeof config?.composioApiKey === "string" ? config.composioApiKey : undefined) ??
    process.env.COMPOSIO_API_KEY;
  const defaultApp: ComposioApp =
    typeof config?.defaultApp === "string" && VALID_APPS.has(config.defaultApp)
      ? (config.defaultApp as ComposioApp)
      : "slack";
  const channelName = typeof config?.channelName === "string" ? config.channelName : undefined;
  const channelId = typeof config?.channelId === "string" ? config.channelId : undefined;
  const emailTo = typeof config?.emailTo === "string" ? config.emailTo : undefined;

  // Internal: allows tests to inject a mock client without mocking composio-core
  const clientOverride =
    config?._clientOverride !== undefined &&
    config._clientOverride !== null &&
    typeof (config._clientOverride as ComposioToolkit).executeAction === "function"
      ? (config._clientOverride as ComposioToolkit)
      : undefined;

  if (typeof config?.defaultApp === "string" && !VALID_APPS.has(config.defaultApp)) {
    throw new Error(
      `[notifier-composio] Invalid defaultApp: "${config.defaultApp}". Must be one of: slack, discord, gmail`,
    );
  }

  if (defaultApp === "gmail" && !emailTo) {
    throw new Error('[notifier-composio] emailTo is required when defaultApp is "gmail"');
  }

  let client: ComposioToolkit | null | undefined = clientOverride;
  let warnedNoKey = false;
  let sdkMissing = false;

  async function getClient(): Promise<ComposioToolkit | null> {
    // If a client override was injected, always use it
    if (clientOverride) return clientOverride;

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
        // eslint-disable-next-line no-console
        console.warn(
          "[notifier-composio] composio-core package is not installed — notifications will be no-ops. Run: npm install composio-core",
        );
        return null;
      }
    }

    return client;
  }

  async function executeWithTimeout(
    composio: ComposioToolkit,
    action: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const timeoutMs = 30_000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);

    const actionPromise = composio.executeAction({ action, params });
    // Prevent unhandled rejection if the timeout fires and actionPromise later rejects
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
    ]);

    if (!result.successful) {
      throw new Error(
        `[notifier-composio] Composio action ${action} failed: ${result.error ?? "unknown error"}`,
      );
    }
  }

  return {
    name: "composio",

    async notify(event: OrchestratorEvent): Promise<void> {
      const composio = await getClient();
      if (!composio) return;

      const text = formatNotifyText(event);
      const toolSlug = APP_TOOL_SLUG[defaultApp];
      const args = buildToolArgs(defaultApp, text, channelId, channelName, emailTo);

      await executeWithTimeout(composio, toolSlug, args);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      const composio = await getClient();
      if (!composio) return;

      const text = formatActionsText(event, actions);
      const toolSlug = APP_TOOL_SLUG[defaultApp];
      const args = buildToolArgs(defaultApp, text, channelId, channelName, emailTo);

      await executeWithTimeout(composio, toolSlug, args);
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      const composio = await getClient();
      if (!composio) return null;

      const channel = context?.channel ?? channelId ?? channelName;
      const toolSlug = APP_TOOL_SLUG[defaultApp];

      const args: Record<string, unknown> =
        defaultApp === "gmail"
          ? { to: emailTo ?? "", subject: GMAIL_SUBJECT, body: message }
          : defaultApp === "discord"
            ? { content: message, ...(channel ? { channel_id: channel } : {}) }
            : { text: message, ...(channel ? { channel } : {}) };

      await executeWithTimeout(composio, toolSlug, args);
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
