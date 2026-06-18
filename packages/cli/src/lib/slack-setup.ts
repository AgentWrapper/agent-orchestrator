import { readFileSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import { parseDocument } from "yaml";
import { CONFIG_SCHEMA_URL, findConfigFile, isCanonicalGlobalConfigPath } from "@aoagents/ao-core";
import {
  applyNotifierRoutingPreset,
  getNotifierRoutingState,
  promptNotifierRoutingPreset,
  resolveRoutingPresetOption,
  type ClackPrompts,
  type NotifierRoutingPreset,
} from "./notifier-routing.js";

const SLACK_APPS_URL = "https://api.slack.com/apps";
const DEFAULT_USERNAME = "Agent Orchestrator";
const SETUP_TIMEOUT_MS = 10_000;

export interface SlackSetupOptions {
  webhookUrl?: string;
  channel?: string;
  username?: string;
  refresh?: boolean;
  status?: boolean;
  test?: boolean;
  force?: boolean;
  nonInteractive?: boolean;
  routingPreset?: string;
}

interface ConfigContext {
  configPath: string;
  rawConfig: Record<string, unknown>;
}

interface ResolvedSlackSetup {
  webhookUrl: string;
  channel?: string;
  username: string;
  shouldSendTest: boolean;
  routingPreset?: NotifierRoutingPreset;
}

export class SlackSetupError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = "SlackSetupError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function validateSlackWebhookUrl(webhookUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new SlackSetupError("Slack webhook URL is invalid.");
  }

  const validHost =
    parsed.hostname === "hooks.slack.com" || parsed.hostname === "hooks.slack-gov.com";
  if (parsed.protocol !== "https:" || !validHost || !parsed.pathname.startsWith("/services/")) {
    throw new SlackSetupError(
      "Slack webhook URL must look like https://hooks.slack.com/services/...",
    );
  }
}

function readConfigContext(): ConfigContext {
  const configPath = findConfigFile() ?? undefined;
  if (!configPath) {
    throw new SlackSetupError(
      "No agent-orchestrator.yaml found. Run 'ao start' first to create one.",
    );
  }

  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};
  return { configPath, rawConfig };
}

function getExistingSlack(rawConfig: Record<string, unknown>): Record<string, unknown> {
  const notifiers = isRecord(rawConfig["notifiers"]) ? rawConfig["notifiers"] : {};
  const existing = notifiers["slack"];
  return isRecord(existing) ? existing : {};
}

function formatFetchError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function buildSetupPayload(resolved: ResolvedSlackSetup): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    username: resolved.username,
    text: "AO Slack notifications are ready.",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "AO Slack notifications are ready",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "This channel is now configured to receive AO notifications.",
        },
      },
    ],
  };

  if (resolved.channel) payload["channel"] = resolved.channel;
  return payload;
}

async function sendSetupProbe(resolved: ResolvedSlackSetup): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETUP_TIMEOUT_MS);

  try {
    const response = await fetch(resolved.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildSetupPayload(resolved)),
      signal: controller.signal,
    });

    if (response.ok) return;

    const body = await response.text().catch(() => "");
    throw new SlackSetupError(
      `Slack setup test failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})${body ? `: ${body}` : ""}`,
    );
  } catch (error) {
    if (error instanceof SlackSetupError) throw error;
    throw new SlackSetupError(`Slack setup test failed: ${formatFetchError(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function shouldReplaceConflictingSlack(
  existingPlugin: unknown,
  force: boolean,
  nonInteractive: boolean,
): Promise<boolean> {
  if (existingPlugin === undefined || existingPlugin === "slack" || force) return true;
  if (nonInteractive) {
    throw new SlackSetupError(
      `notifiers.slack already uses plugin "${String(existingPlugin)}". Re-run with --force to replace it.`,
    );
  }

  const clack = await import("@clack/prompts");
  const replace = await clack.confirm({
    message: `notifiers.slack already uses plugin "${String(existingPlugin)}". Replace it?`,
    initialValue: false,
  });

  if (clack.isCancel(replace) || !replace) {
    console.log(chalk.dim("Keeping existing Slack notifier config."));
    return false;
  }

  return true;
}

function printManualWebhookInstructions(): void {
  console.log("");
  console.log(chalk.bold("Create a Slack incoming webhook"));
  console.log(`  1. Open ${SLACK_APPS_URL}`);
  console.log("  2. Create a new app, or select an existing app.");
  console.log("  3. Open Incoming Webhooks and activate them.");
  console.log("  4. Click Add New Webhook to Workspace.");
  console.log("  5. Pick the channel AO should post to and authorize.");
  console.log("  6. Copy the generated webhook URL and paste it here.");
  console.log(
    chalk.dim("For private channels, the installing Slack user must already be in the channel."),
  );
  console.log("");
}

function explainChannelBinding(): void {
  console.log(
    chalk.dim(
      "Slack incoming webhook URLs are bound to the channel selected during Slack authorization. To change channels, create a webhook for that channel.",
    ),
  );
}

function cancelSetup(clack: ClackPrompts): never {
  clack.cancel("Setup cancelled.");
  throw new SlackSetupError("Setup cancelled.", 0);
}

async function promptSlackWebhookUrl(
  clack: ClackPrompts,
  initialValue: string | undefined,
): Promise<string> {
  const webhookUrlInput = await clack.text({
    message: "Slack incoming webhook URL:",
    placeholder: "https://hooks.slack.com/services/...",
    initialValue,
    validate: (value) => {
      if (!value) return "Slack webhook URL is required";
      try {
        validateSlackWebhookUrl(String(value));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });

  if (clack.isCancel(webhookUrlInput)) {
    cancelSetup(clack);
  }

  return String(webhookUrlInput);
}

async function promptAfterWebhookInstructions(
  clack: ClackPrompts,
  initialValue: string | undefined,
): Promise<string | "back"> {
  printManualWebhookInstructions();

  while (true) {
    const next = await clack.select({
      message: "After creating the Slack webhook, what do you want to do?",
      options: [
        {
          value: "enter-url",
          label: "Paste webhook URL",
          hint: "Continue setup",
        },
        {
          value: "show-steps",
          label: "Show steps again",
          hint: "Reprint the Slack app URL and steps",
        },
        {
          value: "back",
          label: "Back",
          hint: "Return to the previous options",
        },
        {
          value: "cancel",
          label: "Cancel setup",
          hint: "Do not change config",
        },
      ],
    });

    if (clack.isCancel(next) || next === "cancel") {
      cancelSetup(clack);
    }

    if (next === "back") return "back";
    if (next === "show-steps") {
      printManualWebhookInstructions();
      continue;
    }
    if (next === "enter-url") {
      return promptSlackWebhookUrl(clack, initialValue);
    }
  }
}

async function promptChangeWebhookUrl(
  clack: ClackPrompts,
  existingWebhookUrl: string | undefined,
): Promise<string | "back"> {
  while (true) {
    const next = await clack.select({
      message: "How do you want to change the Slack webhook URL?",
      options: [
        {
          value: "enter-url",
          label: "Paste new webhook URL",
          hint: "Use a different Slack incoming webhook URL",
        },
        {
          value: "need-url",
          label: "Show me how to create a new webhook",
          hint: "AO will print the Slack app URL and steps",
        },
        {
          value: "back",
          label: "Back",
          hint: "Return to the previous options",
        },
        {
          value: "cancel",
          label: "Cancel setup",
          hint: "Do not change config",
        },
      ],
    });

    if (clack.isCancel(next) || next === "cancel") {
      cancelSetup(clack);
    }

    if (next === "back") return "back";
    if (next === "enter-url") {
      return promptSlackWebhookUrl(clack, existingWebhookUrl);
    }
    if (next === "need-url") {
      const result = await promptAfterWebhookInstructions(clack, undefined);
      if (result === "back") continue;
      return result;
    }
  }
}

async function resolveInteractiveWebhookUrl(
  clack: ClackPrompts,
  opts: SlackSetupOptions,
  existingWebhookUrl: string | undefined,
): Promise<string> {
  const providedWebhookUrl = stringValue(opts.webhookUrl);
  if (providedWebhookUrl) return providedWebhookUrl;

  while (true) {
    const source = existingWebhookUrl
      ? await clack.select({
          message: "Slack notifier is already configured. What do you want to do?",
          options: [
            {
              value: "use-existing",
              label: "Use existing webhook URL",
              hint: "Keep sending to the currently configured Slack channel",
            },
            {
              value: "change-url",
              label: "Change webhook URL",
              hint: "Paste a different Slack incoming webhook URL",
            },
            {
              value: "need-url",
              label: "Show me how to create a new webhook",
              hint: "AO will print the Slack app URL and steps",
            },
            {
              value: "cancel",
              label: "Cancel setup",
              hint: "Do not change config",
            },
          ],
        })
      : await clack.select({
          message: "Do you already have a Slack incoming webhook URL?",
          options: [
            {
              value: "have-url",
              label: "Yes, I have the URL",
              hint: "Paste the existing Slack webhook URL",
            },
            {
              value: "need-url",
              label: "No, show me how to create one",
              hint: "AO will print the Slack app URL and steps",
            },
            {
              value: "cancel",
              label: "Cancel setup",
              hint: "Do not change config",
            },
          ],
        });

    if (clack.isCancel(source) || source === "cancel") {
      cancelSetup(clack);
    }

    if (source === "use-existing" && existingWebhookUrl) {
      return existingWebhookUrl;
    }

    if (source === "change-url") {
      const result = await promptChangeWebhookUrl(clack, existingWebhookUrl);
      if (result === "back") continue;
      return result;
    }

    if (source === "have-url") {
      return promptSlackWebhookUrl(clack, undefined);
    }

    if (source === "need-url") {
      const result = await promptAfterWebhookInstructions(clack, undefined);
      if (result === "back") continue;
      return result;
    }
  }
}

async function resolveInteractiveSetup(
  opts: SlackSetupOptions,
  existingSlack: Record<string, unknown>,
  rawConfig: Record<string, unknown>,
): Promise<ResolvedSlackSetup> {
  const clack = await import("@clack/prompts");
  const existingWebhookUrl = stringValue(existingSlack["webhookUrl"]);
  const optionRoutingPreset = resolveSlackRoutingPreset(opts.routingPreset);

  clack.intro(chalk.bgCyan(chalk.black(" ao setup slack ")));
  explainChannelBinding();

  while (true) {
    const resolvedWebhookUrl = await resolveInteractiveWebhookUrl(clack, opts, existingWebhookUrl);

    const channelInput = await clack.text({
      message:
        "Channel name (optional; must match the channel selected when creating the webhook):",
      placeholder: "#agents",
      initialValue: stringValue(opts.channel) ?? stringValue(existingSlack["channel"]),
    });

    if (clack.isCancel(channelInput)) {
      cancelSetup(clack);
    }

    const usernameInput = await clack.text({
      message: "Display name (optional):",
      placeholder: DEFAULT_USERNAME,
      initialValue:
        stringValue(opts.username) ?? stringValue(existingSlack["username"]) ?? DEFAULT_USERNAME,
    });

    if (clack.isCancel(usernameInput)) {
      cancelSetup(clack);
    }

    const routingSelection =
      optionRoutingPreset ??
      (await promptNotifierRoutingPreset(clack, rawConfig, "slack", "Slack", () =>
        cancelSetup(clack),
      ));
    if (routingSelection === "back") continue;

    return buildResolvedSetup(
      resolvedWebhookUrl,
      stringValue(channelInput),
      stringValue(usernameInput),
      routingSelection === "preserve" ? undefined : routingSelection,
      opts,
    );
  }
}

function resolveNonInteractiveSetup(
  opts: SlackSetupOptions,
  existingSlack: Record<string, unknown>,
): ResolvedSlackSetup {
  const webhookUrl =
    stringValue(opts.webhookUrl) ??
    (opts.refresh ? stringValue(existingSlack["webhookUrl"]) : undefined);
  if (!webhookUrl) {
    throw new SlackSetupError(
      "Slack webhook URL is required. Pass --webhook-url, or run `ao setup slack --refresh` with an existing Slack config.",
    );
  }

  const channel = stringValue(opts.channel) ?? stringValue(existingSlack["channel"]);
  const username =
    stringValue(opts.username) ?? stringValue(existingSlack["username"]) ?? DEFAULT_USERNAME;
  const routingPreset =
    resolveSlackRoutingPreset(opts.routingPreset) ?? (opts.refresh ? undefined : "all");
  return buildResolvedSetup(webhookUrl, channel, username, routingPreset, opts);
}

function buildResolvedSetup(
  webhookUrl: string,
  channel: string | undefined,
  username: string | undefined,
  routingPreset: NotifierRoutingPreset | undefined,
  opts: SlackSetupOptions,
): ResolvedSlackSetup {
  const normalizedWebhookUrl = webhookUrl.trim();
  validateSlackWebhookUrl(normalizedWebhookUrl);
  return {
    webhookUrl: normalizedWebhookUrl,
    channel,
    username: username ?? DEFAULT_USERNAME,
    shouldSendTest: opts.test !== false,
    routingPreset,
  };
}

function resolveSlackRoutingPreset(value: string | undefined): NotifierRoutingPreset | undefined {
  try {
    return resolveRoutingPresetOption(value, "Slack") as NotifierRoutingPreset | undefined;
  } catch (error) {
    throw new SlackSetupError(error instanceof Error ? error.message : String(error));
  }
}

function writeSlackConfig(configPath: string, resolved: ResolvedSlackSetup): void {
  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};

  const notifiers = isRecord(rawConfig["notifiers"]) ? rawConfig["notifiers"] : {};
  const existingSlack = isRecord(notifiers["slack"]) ? notifiers["slack"] : {};
  const slackConfig: Record<string, unknown> = {
    ...existingSlack,
    plugin: "slack",
    webhookUrl: resolved.webhookUrl,
    username: resolved.username,
  };
  if (resolved.channel) slackConfig["channel"] = resolved.channel;
  else delete slackConfig["channel"];
  notifiers["slack"] = slackConfig;
  rawConfig["notifiers"] = notifiers;

  const defaults = isRecord(rawConfig["defaults"]) ? rawConfig["defaults"] : {};
  rawConfig["defaults"] = defaults;

  applyNotifierRoutingPreset(rawConfig, "slack", resolved.routingPreset);

  if (!isCanonicalGlobalConfigPath(configPath)) {
    const currentSchema = doc.get("$schema");
    if (!(typeof currentSchema === "string" && currentSchema.trim().length > 0)) {
      doc.set("$schema", CONFIG_SCHEMA_URL);
    }
  }

  doc.setIn(["notifiers"], rawConfig["notifiers"]);
  doc.setIn(["defaults"], rawConfig["defaults"]);
  if (rawConfig["notificationRouting"] !== undefined) {
    doc.setIn(["notificationRouting"], rawConfig["notificationRouting"]);
  }
  writeFileSync(configPath, doc.toString({ indent: 2 }));
}

function webhookUrlStatus(webhookUrl: string | undefined): string {
  if (!webhookUrl) return "not configured";
  try {
    return `configured (${new URL(webhookUrl).hostname})`;
  } catch {
    return "configured";
  }
}

async function printStatus(): Promise<void> {
  const context = readConfigContext();
  const existingSlack = getExistingSlack(context.rawConfig);
  const plugin = stringValue(existingSlack["plugin"]);
  const webhookUrl = stringValue(existingSlack["webhookUrl"]);
  const channel = stringValue(existingSlack["channel"]);
  const username = stringValue(existingSlack["username"]) ?? DEFAULT_USERNAME;

  console.log(chalk.bold("Slack notifier status"));
  console.log(`  Config: ${context.configPath}`);
  console.log(`  Plugin: ${plugin ?? chalk.dim("not configured")}`);
  console.log(`  Webhook URL: ${webhookUrlStatus(webhookUrl)}`);
  console.log(`  Channel: ${channel ?? chalk.dim("webhook default")}`);
  console.log(`  Username: ${username}`);
  console.log(`  Routing: ${getNotifierRoutingState(context.rawConfig, "slack").label}`);

  if (plugin !== "slack" || !webhookUrl) return;

  try {
    await sendSetupProbe(
      buildResolvedSetup(webhookUrl, channel, username, undefined, { test: true }),
    );
    console.log(chalk.green("  Probe: PASS"));
  } catch (error) {
    console.log(
      chalk.red(`  Probe: FAIL ${error instanceof Error ? error.message : String(error)}`),
    );
  }
}

export async function runSlackSetupAction(opts: SlackSetupOptions): Promise<void> {
  const nonInteractive = opts.nonInteractive || !process.stdin.isTTY;
  const force = Boolean(opts.force);

  if (opts.status) {
    await printStatus();
    return;
  }

  const context = readConfigContext();
  const existingSlack = getExistingSlack(context.rawConfig);
  const shouldWire = await shouldReplaceConflictingSlack(
    existingSlack["plugin"],
    force,
    nonInteractive,
  );
  if (!shouldWire) return;

  const resolved = nonInteractive
    ? resolveNonInteractiveSetup(opts, existingSlack)
    : await resolveInteractiveSetup(opts, existingSlack, context.rawConfig);

  if (resolved.shouldSendTest) {
    await sendSetupProbe(resolved);
    console.log(chalk.green("✓ Slack setup test passed"));
  } else {
    console.log(chalk.dim("Skipped Slack setup test."));
  }

  writeSlackConfig(context.configPath, resolved);
  console.log(chalk.green(`✓ Config written to ${context.configPath}`));

  if (!nonInteractive) {
    const clack = await import("@clack/prompts");
    clack.outro(
      `${chalk.green("Slack setup complete!")} AO will send notifications through the configured Slack webhook.\n` +
        chalk.dim("  Test it with: ao notify test --to slack --template basic"),
    );
  } else {
    console.log(chalk.green("\n✓ Slack setup complete."));
    console.log(chalk.dim("Test it with: ao notify test --to slack --template basic"));
  }
}
