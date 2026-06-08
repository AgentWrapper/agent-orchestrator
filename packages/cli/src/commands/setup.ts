import type { Command } from "commander";
import { recordActivityEvent } from "@aoagents/ao-core";
import {
  DesktopSetupError,
  runDesktopSetupAction,
  type DesktopSetupOptions,
} from "../lib/desktop-setup.js";
import {
  DashboardSetupError,
  runDashboardSetupAction,
  type DashboardSetupOptions,
} from "../lib/dashboard-setup.js";
import {
  WebhookSetupError,
  runWebhookSetupAction,
  type WebhookSetupOptions,
} from "../lib/webhook-setup.js";
import {
  SlackSetupError,
  runSlackSetupAction,
  type SlackSetupOptions,
} from "../lib/slack-setup.js";
import {
  DiscordSetupError,
  runDiscordSetupAction,
  type DiscordSetupOptions,
} from "../lib/discord-setup.js";
import {
  ComposioSetupError,
  runComposioDiscordBotSetupAction,
  runComposioDiscordWebhookSetupAction,
  runComposioMailSetupAction,
  runComposioSlackSetupAction,
  runComposioSetupAction,
  type ComposioDiscordBotSetupOptions,
  type ComposioDiscordWebhookSetupOptions,
  type ComposioMailSetupOptions,
  type ComposioSetupOptions,
} from "../lib/composio-setup.js";
import {
  OpenClawSetupError,
  runOpenClawSetupAction,
  type OpenClawSetupOptions,
} from "../lib/openclaw-setup.js";

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerSetup(program: Command): void {
  const setup = program.command("setup").description("Set up integrations with external services");

  setup
    .command("dashboard")
    .description("Configure dashboard notification retention and routing")
    .option("--limit <count>", "Number of latest notifications to retain for the dashboard")
    .option("--routing-preset <preset>", "Routing preset: urgent-only | urgent-action | all")
    .option("--refresh", "Refresh/reconfigure dashboard notifier config")
    .option("--non-interactive", "Skip prompts")
    .option("--force", "Replace a conflicting notifiers.dashboard entry")
    .option("--status", "Show dashboard notifier setup status")
    .action(async (opts: DashboardSetupOptions) => {
      try {
        await runDashboardSetupAction(opts);
      } catch (err) {
        if (err instanceof DashboardSetupError) {
          console.error(err.message);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  setup
    .command("desktop")
    .description("Install and configure the native macOS desktop notifier")
    .option("--backend <backend>", "Desktop backend: auto | ao-app | terminal-notifier | osascript")
    .option("--refresh", "Refresh/reconfigure desktop notifier config")
    .option("--dashboard-url <url>", "Dashboard URL to open from notifications")
    .option("--app-path <path>", "Custom AO Notifier.app install path")
    .option("--routing-preset <preset>", "Routing preset: urgent-only | urgent-action | all")
    .option("--no-test", "Skip the setup test notification")
    .option("--non-interactive", "Skip prompts and fail on config conflicts unless --force is set")
    .option("--force", "Repair the app install and replace conflicting desktop notifier config")
    .option("--status", "Show the native desktop notifier install and permission status")
    .option("--uninstall", "Remove AO Notifier.app without changing AO config")
    .action(async (opts: DesktopSetupOptions) => {
      try {
        await runDesktopSetupAction(opts);
      } catch (err) {
        if (err instanceof DesktopSetupError) {
          console.error(err.message);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  setup
    .command("webhook")
    .description("Connect AO notifications to a generic HTTP webhook")
    .option("--url <url>", "Webhook URL")
    .option("--auth-token <token>", "Bearer token to store in webhook Authorization header")
    .option("--routing-preset <preset>", "Routing preset: urgent-only | urgent-action | all")
    .option("--refresh", "Refresh/reconfigure webhook notifier config")
    .option("--no-test", "Skip the setup test POST")
    .option("--non-interactive", "Skip prompts and require --url unless --refresh can reuse config")
    .option("--force", "Replace a conflicting notifiers.webhook entry")
    .option("--status", "Show webhook notifier setup status and probe the endpoint")
    .action(async (opts: WebhookSetupOptions) => {
      try {
        await runWebhookSetupAction(opts);
      } catch (err) {
        if (err instanceof WebhookSetupError) {
          console.error(err.message);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  setup
    .command("slack")
    .description("Connect AO notifications to a Slack incoming webhook")
    .option("--webhook-url <url>", "Slack incoming webhook URL")
    .option(
      "--channel <name>",
      "Optional channel name; must match the channel selected for the webhook URL",
    )
    .option("--username <name>", "Slack display name for AO messages")
    .option("--routing-preset <preset>", "Routing preset: urgent-only | urgent-action | all")
    .option("--refresh", "Refresh/reconfigure Slack notifier config")
    .option("--no-test", "Skip the setup test Slack message")
    .option(
      "--non-interactive",
      "Skip prompts and require --webhook-url unless --refresh can reuse config",
    )
    .option("--force", "Replace a conflicting notifiers.slack entry")
    .option("--status", "Show Slack notifier setup status and probe the endpoint")
    .action(async (opts: SlackSetupOptions) => {
      try {
        await runSlackSetupAction(opts);
      } catch (err) {
        if (err instanceof SlackSetupError) {
          console.error(err.message);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  setup
    .command("discord")
    .description("Connect AO notifications to a Discord incoming webhook")
    .option("--webhook-url <url>", "Discord incoming webhook URL")
    .option("--username <name>", "Discord display name for AO messages")
    .option("--avatar-url <url>", "Discord avatar image URL for AO messages")
    .option("--thread-id <id>", "Discord thread id to post into")
    .option("--retries <count>", "Retry count for rate limits, network errors, and 5xx")
    .option("--retry-delay-ms <ms>", "Base retry delay in milliseconds")
    .option("--routing-preset <preset>", "Routing preset: urgent-only | urgent-action | all")
    .option("--refresh", "Refresh/reconfigure Discord notifier config")
    .option("--no-test", "Skip the setup test Discord message")
    .option(
      "--non-interactive",
      "Skip prompts and require --webhook-url unless --refresh can reuse config",
    )
    .option("--force", "Replace a conflicting notifiers.discord entry")
    .option("--status", "Show Discord notifier setup status and probe the endpoint")
    .action(async (opts: DiscordSetupOptions) => {
      try {
        await runDiscordSetupAction(opts);
      } catch (err) {
        if (err instanceof DiscordSetupError) {
          console.error(err.message);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  setup
    .command("composio")
    .description("Open the interactive Composio notifier setup hub")
    .option("--api-key <key>", "Composio API key (otherwise uses COMPOSIO_API_KEY)")
    .option("--user-id <id>", "Composio user id")
    .option("--slack", "Open Slack setup directly")
    .option("--discord-webhook", "Open Discord webhook setup directly")
    .option("--discord-bot", "Open Discord bot setup directly")
    .option("--gmail", "Open Gmail setup directly")
    .option("--channel <name-or-id>", "Slack channel name or channel id for scriptable Slack setup")
    .option("--routing-preset <preset>", "Routing preset: urgent-only | urgent-action | all")
    .option(
      "--connected-account-id <id>",
      "Existing Composio Slack connected account id for scriptable Slack setup",
    )
    .option(
      "--wait-ms <ms>",
      "How long to wait for a new Slack connection in scriptable setup",
      "60000",
    )
    .option("--non-interactive", "Skip prompts and fail when multiple accounts need selection")
    .option("--status", "Show Composio notifier setup status without changing config")
    .option("--force", "Replace a conflicting notifiers.composio entry")
    .action(async (opts: ComposioSetupOptions) => {
      try {
        await runComposioSetupAction(opts);
      } catch (err) {
        if (err instanceof ComposioSetupError) {
          console.error(err.message);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  setup
    .command("composio-slack")
    .description("Connect AO notifications to Slack through Composio")
    .option("--api-key <key>", "Composio API key (otherwise uses COMPOSIO_API_KEY)")
    .option("--user-id <id>", "Composio user id for the Slack connected account")
    .option("--channel <name-or-id>", "Slack channel name or channel id")
    .option("--connected-account-id <id>", "Existing Composio Slack connected account id")
    .option("--routing-preset <preset>", "Routing preset: urgent-only | urgent-action | all")
    .option("--wait-ms <ms>", "How long to wait for a new Slack connection", "60000")
    .option("--non-interactive", "Skip prompts and fail when multiple accounts need selection")
    .option("--status", "Show Composio Slack setup status without changing config")
    .option("--force", "Replace a conflicting notifiers.composio-slack entry")
    .action(async (opts: ComposioSetupOptions) => {
      try {
        await runComposioSlackSetupAction(opts);
      } catch (err) {
        if (err instanceof ComposioSetupError) {
          console.error(err.message);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  setup
    .command("composio-discord")
    .description("Connect AO notifications to Discord webhooks through Composio")
    .option("--api-key <key>", "Composio API key (otherwise uses COMPOSIO_API_KEY)")
    .option("--user-id <id>", "Composio user id for tool execution")
    .option("--webhook-url <url>", "Discord webhook URL")
    .option("--connected-account-id <id>", "Existing Composio Discord webhook connected account id")
    .option("--routing-preset <preset>", "Routing preset: urgent-only | urgent-action | all")
    .option("--non-interactive", "Skip prompts")
    .option("--status", "Show Composio Discord webhook setup status without changing config")
    .option("--force", "Replace a conflicting notifiers.composio-discord entry")
    .action(async (opts: ComposioDiscordWebhookSetupOptions) => {
      try {
        await runComposioDiscordWebhookSetupAction(opts);
      } catch (err) {
        if (err instanceof ComposioSetupError) {
          console.error(err.message);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  setup
    .command("composio-discord-bot")
    .description("Connect AO notifications to a Discord bot through Composio")
    .option("--api-key <key>", "Composio API key (otherwise uses COMPOSIO_API_KEY)")
    .option("--user-id <id>", "Composio user id for the Discord connected account")
    .option("--channel-id <id>", "Discord channel id")
    .option("--bot-token <token>", "Discord bot token used once to create the Composio account")
    .option("--connected-account-id <id>", "Existing Composio Discord bot connected account id")
    .option("--routing-preset <preset>", "Routing preset: urgent-only | urgent-action | all")
    .option("--non-interactive", "Skip prompts")
    .option("--status", "Show Composio Discord bot setup status without changing config")
    .option("--force", "Replace a conflicting notifiers.composio-discord-bot entry")
    .action(async (opts: ComposioDiscordBotSetupOptions) => {
      try {
        await runComposioDiscordBotSetupAction(opts);
      } catch (err) {
        if (err instanceof ComposioSetupError) {
          console.error(err.message);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  setup
    .command("composio-mail")
    .description("Connect AO notifications to Gmail through Composio")
    .option("--api-key <key>", "Composio API key (otherwise uses COMPOSIO_API_KEY)")
    .option("--user-id <id>", "Composio user id for the Gmail connected account")
    .option("--email-to <email>", "Recipient email address for AO notifications")
    .option("--connect", "Print a Composio Gmail connect URL when no account exists")
    .option("--auth-config-id <id>", "Existing Composio Gmail auth config id for --connect")
    .option("--connected-account-id <id>", "Existing Composio Gmail connected account id")
    .option("--routing-preset <preset>", "Routing preset: urgent-only | urgent-action | all")
    .option("--wait-ms <ms>", "How long to wait for a new Gmail connection with --connect", "60000")
    .option("--non-interactive", "Skip prompts and fail when multiple accounts need selection")
    .option("--status", "Show Composio mail setup status without changing config")
    .option("--force", "Replace a conflicting notifiers.composio-mail entry")
    .action(async (opts: ComposioMailSetupOptions) => {
      try {
        await runComposioMailSetupAction(opts);
      } catch (err) {
        if (err instanceof ComposioSetupError) {
          console.error(err.message);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  setup
    .command("openclaw")
    .description("Connect AO notifications to an OpenClaw gateway")
    .option("--url <url>", "OpenClaw webhook URL (e.g. http://127.0.0.1:18789/hooks/agent)")
    .option(
      "--token <token>",
      "Remote/manual fallback token; local setup should read hooks.token from OpenClaw config",
    )
    .option("--openclaw-config-path <path>", "OpenClaw config path that contains hooks.token")
    .option("--routing-preset <preset>", "Routing preset: urgent-only | urgent-action | all")
    .option(
      "--non-interactive",
      "Skip prompts — auto-detects OpenClaw if --url not provided and reads token from OpenClaw config",
    )
    .option("--refresh", "Refresh/reconfigure OpenClaw notifier config")
    .option("--no-test", "Skip the setup token probe")
    .option("--force", "Replace a conflicting notifiers.openclaw entry")
    .option("--status", "Show OpenClaw notifier setup status and probe the gateway")
    .action(async (opts: OpenClawSetupOptions) => {
      try {
        await runSetupAction(opts);
      } catch (err) {
        recordActivityEvent({
          source: "cli",
          kind: "cli.setup_failed",
          level: "error",
          summary: "ao setup openclaw failed",
          data: {
            aborted: err instanceof OpenClawSetupError && err.exitCode === 0,
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
        if (err instanceof OpenClawSetupError) {
          console.error(err.message);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });
}

export async function runSetupAction(opts: OpenClawSetupOptions): Promise<void> {
  await runOpenClawSetupAction(opts);
}
