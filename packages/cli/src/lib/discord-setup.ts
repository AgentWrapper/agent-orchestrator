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

const DISCORD_APP_URL = "https://discord.com/app";
const DISCORD_SUPPORT_WEBHOOK_URL =
  "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks";
const DISCORD_WEBHOOK_DOCS_URL = "https://docs.discord.com/developers/resources/webhook";
const DEFAULT_USERNAME = "Agent Orchestrator";
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;
const SETUP_TIMEOUT_MS = 10_000;

export interface DiscordSetupOptions {
  webhookUrl?: string;
  username?: string;
  avatarUrl?: string;
  threadId?: string;
  retries?: string;
  retryDelayMs?: string;
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

interface ResolvedDiscordSetup {
  webhookUrl: string;
  username: string;
  avatarUrl?: string;
  threadId?: string;
  retries: number;
  retryDelayMs: number;
  shouldSendTest: boolean;
  routingPreset?: NotifierRoutingPreset;
}

export class DiscordSetupError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = "DiscordSetupError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function validateDiscordWebhookUrl(webhookUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new DiscordSetupError("Discord webhook URL is invalid.");
  }

  const validHost = parsed.hostname === "discord.com" || parsed.hostname === "discordapp.com";
  if (parsed.protocol !== "https:" || !validHost || !parsed.pathname.startsWith("/api/webhooks/")) {
    throw new DiscordSetupError(
      "Discord webhook URL must look like https://discord.com/api/webhooks/...",
    );
  }
}

function validateOptionalHttpUrl(value: string | undefined, label: string): void {
  if (!value) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DiscordSetupError(`${label} is invalid.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DiscordSetupError(`${label} must start with http:// or https://.`);
  }
}

function parseNonNegativeInteger(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new DiscordSetupError(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function existingIntegerText(value: unknown, fallback: number): string {
  if (value === undefined || value === null || value === "") return String(fallback);
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? String(parsed) : String(fallback);
}

function readConfigContext(): ConfigContext {
  const configPath = findConfigFile() ?? undefined;
  if (!configPath) {
    throw new DiscordSetupError(
      "No agent-orchestrator.yaml found. Run 'ao start' first to create one.",
    );
  }

  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};
  return { configPath, rawConfig };
}

function getExistingDiscord(rawConfig: Record<string, unknown>): Record<string, unknown> {
  const notifiers = isRecord(rawConfig["notifiers"]) ? rawConfig["notifiers"] : {};
  const existing = notifiers["discord"];
  return isRecord(existing) ? existing : {};
}

function formatFetchError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function effectiveWebhookUrl(webhookUrl: string, threadId?: string): string {
  if (!threadId) return webhookUrl;
  const separator = webhookUrl.includes("?") ? "&" : "?";
  return `${webhookUrl}${separator}thread_id=${encodeURIComponent(threadId)}`;
}

function buildSetupPayload(resolved: ResolvedDiscordSetup): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    username: resolved.username,
    content: "AO Discord notifications are ready.",
    embeds: [
      {
        title: "AO Discord notifications are ready",
        description: "This channel is now configured to receive AO notifications.",
        color: 0x57f287,
        timestamp: new Date().toISOString(),
        footer: { text: "Agent Orchestrator" },
      },
    ],
  };
  if (resolved.avatarUrl) payload["avatar_url"] = resolved.avatarUrl;
  return payload;
}

async function sendSetupProbe(resolved: ResolvedDiscordSetup): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETUP_TIMEOUT_MS);
  const url = effectiveWebhookUrl(resolved.webhookUrl, resolved.threadId);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildSetupPayload(resolved)),
      signal: controller.signal,
    });

    if (response.ok || response.status === 204) return;

    const body = await response.text().catch(() => "");
    throw new DiscordSetupError(
      `Discord setup test failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})${body ? `: ${body}` : ""}`,
    );
  } catch (error) {
    if (error instanceof DiscordSetupError) throw error;
    throw new DiscordSetupError(`Discord setup test failed: ${formatFetchError(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function shouldReplaceConflictingDiscord(
  existingPlugin: unknown,
  force: boolean,
  nonInteractive: boolean,
): Promise<boolean> {
  if (existingPlugin === undefined || existingPlugin === "discord" || force) return true;
  if (nonInteractive) {
    throw new DiscordSetupError(
      `notifiers.discord already uses plugin "${String(existingPlugin)}". Re-run with --force to replace it.`,
    );
  }

  const clack = await import("@clack/prompts");
  const replace = await clack.confirm({
    message: `notifiers.discord already uses plugin "${String(existingPlugin)}". Replace it?`,
    initialValue: false,
  });

  if (clack.isCancel(replace) || !replace) {
    console.log(chalk.dim("Keeping existing Discord notifier config."));
    return false;
  }

  return true;
}

function printManualWebhookInstructions(): void {
  console.log("");
  console.log(chalk.bold("Create a Discord incoming webhook"));
  console.log(`  1. Open ${DISCORD_APP_URL}`);
  console.log("  2. Open the target server and channel.");
  console.log("  3. Open Edit Channel > Integrations > Webhooks.");
  console.log("  4. Create a new webhook.");
  console.log("  5. Copy the webhook URL and paste it here.");
  console.log(chalk.dim(`Discord help: ${DISCORD_SUPPORT_WEBHOOK_URL}`));
  console.log(chalk.dim(`Developer docs: ${DISCORD_WEBHOOK_DOCS_URL}`));
  console.log("");
}

function explainChannelBinding(): void {
  console.log(
    chalk.dim(
      "Discord webhook URLs are bound to the channel selected in Discord. To change channels, create a webhook in that channel.",
    ),
  );
}

function cancelSetup(clack: ClackPrompts): never {
  clack.cancel("Setup cancelled.");
  throw new DiscordSetupError("Setup cancelled.", 0);
}

async function promptDiscordWebhookUrl(
  clack: ClackPrompts,
  initialValue: string | undefined,
): Promise<string> {
  const webhookUrlInput = await clack.text({
    message: "Discord webhook URL:",
    placeholder: "https://discord.com/api/webhooks/...",
    initialValue,
    validate: (value) => {
      if (!value) return "Discord webhook URL is required";
      try {
        validateDiscordWebhookUrl(String(value));
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
      message: "After creating the Discord webhook, what do you want to do?",
      options: [
        {
          value: "enter-url",
          label: "Paste webhook URL",
          hint: "Continue setup",
        },
        {
          value: "show-steps",
          label: "Show steps again",
          hint: "Reprint the Discord links and steps",
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
      return promptDiscordWebhookUrl(clack, initialValue);
    }
  }
}

async function promptChangeWebhookUrl(
  clack: ClackPrompts,
  existingWebhookUrl: string | undefined,
): Promise<string | "back"> {
  while (true) {
    const next = await clack.select({
      message: "How do you want to change the Discord webhook URL?",
      options: [
        {
          value: "enter-url",
          label: "Paste new webhook URL",
          hint: "Use a different Discord webhook URL",
        },
        {
          value: "need-url",
          label: "Show me how to create a new webhook",
          hint: "AO will print Discord steps and wait",
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
      return promptDiscordWebhookUrl(clack, existingWebhookUrl);
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
  opts: DiscordSetupOptions,
  existingWebhookUrl: string | undefined,
): Promise<string> {
  const providedWebhookUrl = stringValue(opts.webhookUrl);
  if (providedWebhookUrl) return providedWebhookUrl;

  while (true) {
    const source = existingWebhookUrl
      ? await clack.select({
          message: "Discord notifier is already configured. What do you want to do?",
          options: [
            {
              value: "use-existing",
              label: "Use existing webhook URL",
              hint: "Keep sending to the currently configured Discord channel",
            },
            {
              value: "change-url",
              label: "Change webhook URL",
              hint: "Paste a different Discord webhook URL",
            },
            {
              value: "need-url",
              label: "Show me how to create a new webhook",
              hint: "AO will print Discord steps and wait",
            },
            {
              value: "cancel",
              label: "Cancel setup",
              hint: "Do not change config",
            },
          ],
        })
      : await clack.select({
          message: "Do you already have a Discord webhook URL?",
          options: [
            {
              value: "have-url",
              label: "Yes, I have the URL",
              hint: "Paste the existing Discord webhook URL",
            },
            {
              value: "need-url",
              label: "No, show me how to create one",
              hint: "AO will print Discord steps and wait",
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
      return promptDiscordWebhookUrl(clack, undefined);
    }

    if (source === "need-url") {
      const result = await promptAfterWebhookInstructions(clack, undefined);
      if (result === "back") continue;
      return result;
    }
  }
}

async function resolveInteractiveSetup(
  opts: DiscordSetupOptions,
  existingDiscord: Record<string, unknown>,
  rawConfig: Record<string, unknown>,
): Promise<ResolvedDiscordSetup> {
  const clack = await import("@clack/prompts");
  const existingWebhookUrl = stringValue(existingDiscord["webhookUrl"]);
  const optionRoutingPreset = resolveDiscordRoutingPreset(opts.routingPreset);

  clack.intro(chalk.bgCyan(chalk.black(" ao setup discord ")));
  explainChannelBinding();

  while (true) {
    const resolvedWebhookUrl = await resolveInteractiveWebhookUrl(clack, opts, existingWebhookUrl);

    const usernameInput = await clack.text({
      message: "Display name AO should request for Discord messages:",
      placeholder: DEFAULT_USERNAME,
      initialValue:
        stringValue(opts.username) ?? stringValue(existingDiscord["username"]) ?? DEFAULT_USERNAME,
    });

    if (clack.isCancel(usernameInput)) {
      cancelSetup(clack);
    }

    const avatarUrlInput = await clack.text({
      message: "Avatar image URL (optional):",
      placeholder: "https://example.com/avatar.png",
      initialValue: stringValue(opts.avatarUrl) ?? stringValue(existingDiscord["avatarUrl"]),
      validate: (value) => {
        if (!value) return undefined;
        try {
          validateOptionalHttpUrl(String(value), "Avatar URL");
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    });

    if (clack.isCancel(avatarUrlInput)) {
      cancelSetup(clack);
    }

    const threadIdInput = await clack.text({
      message: "Thread ID (optional; posts into an existing Discord thread):",
      placeholder: "1234567890",
      initialValue: stringValue(opts.threadId) ?? stringValue(existingDiscord["threadId"]),
    });

    if (clack.isCancel(threadIdInput)) {
      cancelSetup(clack);
    }

    const retriesInput = await clack.text({
      message: "Retries for rate limits, network errors, and 5xx responses:",
      placeholder: String(DEFAULT_RETRIES),
      initialValue:
        stringValue(opts.retries) ??
        existingIntegerText(existingDiscord["retries"], DEFAULT_RETRIES),
      validate: (value) => {
        try {
          parseNonNegativeInteger(value, "Retries", DEFAULT_RETRIES);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    });

    if (clack.isCancel(retriesInput)) {
      cancelSetup(clack);
    }

    const retryDelayInput = await clack.text({
      message: "Base retry delay in milliseconds:",
      placeholder: String(DEFAULT_RETRY_DELAY_MS),
      initialValue:
        stringValue(opts.retryDelayMs) ??
        existingIntegerText(existingDiscord["retryDelayMs"], DEFAULT_RETRY_DELAY_MS),
      validate: (value) => {
        try {
          parseNonNegativeInteger(value, "Retry delay", DEFAULT_RETRY_DELAY_MS);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    });

    if (clack.isCancel(retryDelayInput)) {
      cancelSetup(clack);
    }

    const routingSelection =
      optionRoutingPreset ??
      (await promptNotifierRoutingPreset(clack, rawConfig, "discord", "Discord", () =>
        cancelSetup(clack),
      ));
    if (routingSelection === "back") continue;

    return buildResolvedSetup(
      String(resolvedWebhookUrl),
      stringValue(usernameInput),
      stringValue(avatarUrlInput),
      stringValue(threadIdInput),
      retriesInput,
      retryDelayInput,
      routingSelection === "preserve" ? undefined : routingSelection,
      opts,
    );
  }
}

function resolveNonInteractiveSetup(
  opts: DiscordSetupOptions,
  existingDiscord: Record<string, unknown>,
): ResolvedDiscordSetup {
  const webhookUrl =
    stringValue(opts.webhookUrl) ??
    (opts.refresh ? stringValue(existingDiscord["webhookUrl"]) : undefined);
  if (!webhookUrl) {
    throw new DiscordSetupError(
      "Discord webhook URL is required. Pass --webhook-url, or run `ao setup discord --refresh` with an existing Discord config.",
    );
  }

  return buildResolvedSetup(
    webhookUrl,
    stringValue(opts.username) ?? stringValue(existingDiscord["username"]),
    stringValue(opts.avatarUrl) ?? stringValue(existingDiscord["avatarUrl"]),
    stringValue(opts.threadId) ?? stringValue(existingDiscord["threadId"]),
    opts.retries ?? existingDiscord["retries"],
    opts.retryDelayMs ?? existingDiscord["retryDelayMs"],
    resolveDiscordRoutingPreset(opts.routingPreset) ?? (opts.refresh ? undefined : "all"),
    opts,
  );
}

function buildResolvedSetup(
  webhookUrl: string,
  username: string | undefined,
  avatarUrl: string | undefined,
  threadId: string | undefined,
  retriesValue: unknown,
  retryDelayMsValue: unknown,
  routingPreset: NotifierRoutingPreset | undefined,
  opts: DiscordSetupOptions,
): ResolvedDiscordSetup {
  const normalizedWebhookUrl = webhookUrl.trim();
  validateDiscordWebhookUrl(normalizedWebhookUrl);
  validateOptionalHttpUrl(avatarUrl, "Avatar URL");

  return {
    webhookUrl: normalizedWebhookUrl,
    username: username ?? DEFAULT_USERNAME,
    avatarUrl,
    threadId,
    retries: parseNonNegativeInteger(retriesValue, "Retries", DEFAULT_RETRIES),
    retryDelayMs: parseNonNegativeInteger(retryDelayMsValue, "Retry delay", DEFAULT_RETRY_DELAY_MS),
    shouldSendTest: opts.test !== false,
    routingPreset,
  };
}

function resolveDiscordRoutingPreset(value: string | undefined): NotifierRoutingPreset | undefined {
  try {
    return resolveRoutingPresetOption(value, "Discord") as NotifierRoutingPreset | undefined;
  } catch (error) {
    throw new DiscordSetupError(error instanceof Error ? error.message : String(error));
  }
}

function writeDiscordConfig(configPath: string, resolved: ResolvedDiscordSetup): void {
  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};

  const notifiers = isRecord(rawConfig["notifiers"]) ? rawConfig["notifiers"] : {};
  const existingDiscord = isRecord(notifiers["discord"]) ? notifiers["discord"] : {};
  const discordConfig: Record<string, unknown> = {
    ...existingDiscord,
    plugin: "discord",
    webhookUrl: resolved.webhookUrl,
    username: resolved.username,
    retries: resolved.retries,
    retryDelayMs: resolved.retryDelayMs,
  };
  if (resolved.avatarUrl) discordConfig["avatarUrl"] = resolved.avatarUrl;
  else delete discordConfig["avatarUrl"];
  if (resolved.threadId) discordConfig["threadId"] = resolved.threadId;
  else delete discordConfig["threadId"];
  notifiers["discord"] = discordConfig;
  rawConfig["notifiers"] = notifiers;

  const defaults = isRecord(rawConfig["defaults"]) ? rawConfig["defaults"] : {};
  rawConfig["defaults"] = defaults;

  applyNotifierRoutingPreset(rawConfig, "discord", resolved.routingPreset);

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
  const existingDiscord = getExistingDiscord(context.rawConfig);
  const plugin = stringValue(existingDiscord["plugin"]);
  const webhookUrl = stringValue(existingDiscord["webhookUrl"]);
  const username = stringValue(existingDiscord["username"]) ?? DEFAULT_USERNAME;
  const avatarUrl = stringValue(existingDiscord["avatarUrl"]);
  const threadId = stringValue(existingDiscord["threadId"]);
  const retries = parseNonNegativeInteger(existingDiscord["retries"], "Retries", DEFAULT_RETRIES);
  const retryDelayMs = parseNonNegativeInteger(
    existingDiscord["retryDelayMs"],
    "Retry delay",
    DEFAULT_RETRY_DELAY_MS,
  );

  console.log(chalk.bold("Discord notifier status"));
  console.log(`  Config: ${context.configPath}`);
  console.log(`  Plugin: ${plugin ?? chalk.dim("not configured")}`);
  console.log(`  Webhook URL: ${webhookUrlStatus(webhookUrl)}`);
  console.log(`  Username: ${username}`);
  console.log(`  Avatar URL: ${avatarUrl ?? chalk.dim("not configured")}`);
  console.log(`  Thread ID: ${threadId ?? chalk.dim("not configured")}`);
  console.log(`  Retries: ${retries}`);
  console.log(`  Retry delay: ${retryDelayMs}ms`);
  console.log(`  Routing: ${getNotifierRoutingState(context.rawConfig, "discord").label}`);

  if (plugin !== "discord" || !webhookUrl) return;

  try {
    await sendSetupProbe(
      buildResolvedSetup(
        webhookUrl,
        username,
        avatarUrl,
        threadId,
        retries,
        retryDelayMs,
        undefined,
        {
          test: true,
        },
      ),
    );
    console.log(chalk.green("  Probe: PASS"));
  } catch (error) {
    console.log(
      chalk.red(`  Probe: FAIL ${error instanceof Error ? error.message : String(error)}`),
    );
  }
}

export async function runDiscordSetupAction(opts: DiscordSetupOptions): Promise<void> {
  const nonInteractive = opts.nonInteractive || !process.stdin.isTTY;
  const force = Boolean(opts.force);

  if (opts.status) {
    await printStatus();
    return;
  }

  const context = readConfigContext();
  const existingDiscord = getExistingDiscord(context.rawConfig);
  const shouldWire = await shouldReplaceConflictingDiscord(
    existingDiscord["plugin"],
    force,
    nonInteractive,
  );
  if (!shouldWire) return;

  const resolved = nonInteractive
    ? resolveNonInteractiveSetup(opts, existingDiscord)
    : await resolveInteractiveSetup(opts, existingDiscord, context.rawConfig);

  if (resolved.shouldSendTest) {
    await sendSetupProbe(resolved);
    console.log(chalk.green("✓ Discord setup test passed"));
  } else {
    console.log(chalk.dim("Skipped Discord setup test."));
  }

  writeDiscordConfig(context.configPath, resolved);
  console.log(chalk.green(`✓ Config written to ${context.configPath}`));

  if (!nonInteractive) {
    const clack = await import("@clack/prompts");
    clack.outro(
      `${chalk.green("Discord setup complete!")} AO will send notifications through the configured Discord webhook.\n` +
        chalk.dim("  Test it with: ao notify test --to discord --template basic"),
    );
  } else {
    console.log(chalk.green("\n✓ Discord setup complete."));
    console.log(chalk.dim("Test it with: ao notify test --to discord --template basic"));
  }
}
