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

const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;
const SETUP_TIMEOUT_MS = 10_000;

export interface WebhookSetupOptions {
  url?: string;
  authToken?: string;
  refresh?: boolean;
  status?: boolean;
  test?: boolean;
  force?: boolean;
  nonInteractive?: boolean;
  routingPreset?: string;
}

interface WebhookConfig {
  plugin: "webhook";
  url: string;
  headers?: Record<string, string>;
  retries: number;
  retryDelayMs: number;
}

interface ConfigContext {
  configPath: string;
  rawConfig: Record<string, unknown>;
}

interface ResolvedWebhookSetup {
  url: string;
  headers?: Record<string, string>;
  retries: number;
  retryDelayMs: number;
  shouldSendTest: boolean;
  routingPreset?: NotifierRoutingPreset;
}

export class WebhookSetupError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = "WebhookSetupError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function validateWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookSetupError("Webhook URL is invalid.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebhookSetupError("Webhook URL must start with http:// or https://.");
  }
}

function readConfigContext(): ConfigContext {
  const configPath = findConfigFile() ?? undefined;
  if (!configPath) {
    throw new WebhookSetupError(
      "No agent-orchestrator.yaml found. Run 'ao start' first to create one.",
    );
  }

  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};
  return { configPath, rawConfig };
}

function getExistingWebhook(rawConfig: Record<string, unknown>): Record<string, unknown> {
  const notifiers = isRecord(rawConfig["notifiers"]) ? rawConfig["notifiers"] : {};
  const existing = notifiers["webhook"];
  return isRecord(existing) ? existing : {};
}

function getBearerToken(headers: unknown): string | undefined {
  if (!isRecord(headers)) return undefined;
  const authorization = stringValue(headers["Authorization"] ?? headers["authorization"]);
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function formatFetchError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function buildSetupPayload(): Record<string, unknown> {
  return {
    type: "notification",
    event: {
      id: `webhook-setup-${Date.now()}`,
      type: "setup.webhook",
      priority: "info",
      sessionId: "setup",
      projectId: "ao",
      timestamp: new Date().toISOString(),
      message: "AO webhook notifications are ready.",
      data: {
        source: "ao-setup-webhook",
      },
    },
  };
}

async function sendSetupProbe(resolved: ResolvedWebhookSetup): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETUP_TIMEOUT_MS);

  try {
    const response = await fetch(resolved.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(resolved.headers ?? {}),
      },
      body: JSON.stringify(buildSetupPayload()),
      signal: controller.signal,
    });

    if (response.ok) return;

    const body = await response.text().catch(() => "");
    throw new WebhookSetupError(
      `Webhook setup test failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})${body ? `: ${body}` : ""}`,
    );
  } catch (error) {
    if (error instanceof WebhookSetupError) throw error;
    throw new WebhookSetupError(`Webhook setup test failed: ${formatFetchError(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function shouldReplaceConflictingWebhook(
  existingPlugin: unknown,
  force: boolean,
  nonInteractive: boolean,
): Promise<boolean> {
  if (existingPlugin === undefined || existingPlugin === "webhook" || force) return true;
  if (nonInteractive) {
    throw new WebhookSetupError(
      `notifiers.webhook already uses plugin "${String(existingPlugin)}". Re-run with --force to replace it.`,
    );
  }

  const clack = await import("@clack/prompts");
  const replace = await clack.confirm({
    message: `notifiers.webhook already uses plugin "${String(existingPlugin)}". Replace it?`,
    initialValue: false,
  });

  if (clack.isCancel(replace) || !replace) {
    console.log(chalk.dim("Keeping existing webhook notifier config."));
    return false;
  }

  return true;
}

function cancelSetup(clack: ClackPrompts): never {
  clack.cancel("Setup cancelled.");
  throw new WebhookSetupError("Setup cancelled.", 0);
}

async function promptWebhookUrl(
  clack: ClackPrompts,
  initialValue: string | undefined,
): Promise<string> {
  const urlInput = await clack.text({
    message: "Webhook URL:",
    placeholder: "https://example.com/ao-events",
    initialValue,
    validate: (value) => {
      if (!value) return "URL is required";
      try {
        validateWebhookUrl(String(value));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });

  if (clack.isCancel(urlInput)) {
    cancelSetup(clack);
  }

  return String(urlInput);
}

async function promptChangeWebhookUrl(
  clack: ClackPrompts,
  existingUrl: string | undefined,
): Promise<string | "back"> {
  const next = await clack.select({
    message: "How do you want to configure the webhook URL?",
    options: [
      {
        value: "enter-url",
        label: "Add new webhook URL",
        hint: "Paste a different HTTP endpoint",
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
  return promptWebhookUrl(clack, existingUrl);
}

async function resolveInteractiveUrl(
  clack: ClackPrompts,
  opts: WebhookSetupOptions,
  existingUrl: string | undefined,
): Promise<string> {
  const providedUrl = stringValue(opts.url);
  if (providedUrl) return providedUrl;

  while (true) {
    if (!existingUrl) {
      return promptWebhookUrl(clack, undefined);
    }

    const source = await clack.select({
      message: "Webhook notifier is already configured. What do you want to do?",
      options: [
        {
          value: "use-existing",
          label: "Use existing webhook URL",
          hint: "Keep sending to the currently configured endpoint",
        },
        {
          value: "add-new",
          label: "Add new webhook URL",
          hint: "Paste a different HTTP endpoint",
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

    if (source === "use-existing") {
      return existingUrl;
    }

    if (source === "add-new") {
      const result = await promptChangeWebhookUrl(clack, existingUrl);
      if (result === "back") continue;
      return result;
    }
  }
}

async function resolveInteractiveSetup(
  opts: WebhookSetupOptions,
  existingWebhook: Record<string, unknown>,
  rawConfig: Record<string, unknown>,
): Promise<ResolvedWebhookSetup> {
  const clack = await import("@clack/prompts");
  const existingUrl = stringValue(existingWebhook["url"]);
  const existingToken = getBearerToken(existingWebhook["headers"]);
  const optionRoutingPreset = resolveWebhookRoutingPreset(opts.routingPreset);

  clack.intro(chalk.bgCyan(chalk.black(" ao setup webhook ")));

  while (true) {
    const resolvedUrl = await resolveInteractiveUrl(clack, opts, existingUrl);

    let authToken = stringValue(opts.authToken);
    if (!authToken && existingToken) {
      const keepExisting = await clack.confirm({
        message: "Keep the existing Authorization bearer token?",
        initialValue: true,
      });

      if (clack.isCancel(keepExisting)) {
        cancelSetup(clack);
      }

      if (keepExisting) authToken = existingToken;
    }

    if (!authToken) {
      const tokenInput = await clack.password({
        message: "Auth token (optional; leave blank for none):",
      });

      if (clack.isCancel(tokenInput)) {
        cancelSetup(clack);
      }

      authToken = stringValue(tokenInput);
    }

    const routingSelection =
      optionRoutingPreset ??
      (await promptNotifierRoutingPreset(clack, rawConfig, "webhook", "webhook", () =>
        cancelSetup(clack),
      ));
    if (routingSelection === "back") continue;

    const retries = numberValue(existingWebhook["retries"], DEFAULT_RETRIES);
    const retryDelayMs = numberValue(existingWebhook["retryDelayMs"], DEFAULT_RETRY_DELAY_MS);

    return buildResolvedSetup(
      resolvedUrl,
      authToken,
      retries,
      retryDelayMs,
      routingSelection === "preserve" ? undefined : routingSelection,
      opts,
    );
  }
}

function resolveNonInteractiveSetup(
  opts: WebhookSetupOptions,
  existingWebhook: Record<string, unknown>,
): ResolvedWebhookSetup {
  const url =
    stringValue(opts.url) ?? (opts.refresh ? stringValue(existingWebhook["url"]) : undefined);
  if (!url) {
    throw new WebhookSetupError(
      "Webhook URL is required. Pass --url, or run `ao setup webhook --refresh` with an existing webhook config.",
    );
  }

  const authToken = stringValue(opts.authToken) ?? getBearerToken(existingWebhook["headers"]);
  const retries = numberValue(existingWebhook["retries"], DEFAULT_RETRIES);
  const retryDelayMs = numberValue(existingWebhook["retryDelayMs"], DEFAULT_RETRY_DELAY_MS);
  const routingPreset =
    resolveWebhookRoutingPreset(opts.routingPreset) ?? (opts.refresh ? undefined : "all");

  return buildResolvedSetup(url, authToken, retries, retryDelayMs, routingPreset, opts);
}

function buildResolvedSetup(
  url: string,
  authToken: string | undefined,
  retries: number,
  retryDelayMs: number,
  routingPreset: NotifierRoutingPreset | undefined,
  opts: WebhookSetupOptions,
): ResolvedWebhookSetup {
  const normalizedUrl = url.trim();
  validateWebhookUrl(normalizedUrl);
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
  return {
    url: normalizedUrl,
    headers,
    retries,
    retryDelayMs,
    shouldSendTest: opts.test !== false,
    routingPreset,
  };
}

function resolveWebhookRoutingPreset(value: string | undefined): NotifierRoutingPreset | undefined {
  try {
    return resolveRoutingPresetOption(value, "webhook") as NotifierRoutingPreset | undefined;
  } catch (error) {
    throw new WebhookSetupError(error instanceof Error ? error.message : String(error));
  }
}

function toWebhookConfig(resolved: ResolvedWebhookSetup): WebhookConfig {
  return {
    plugin: "webhook",
    url: resolved.url,
    ...(resolved.headers ? { headers: resolved.headers } : {}),
    retries: resolved.retries,
    retryDelayMs: resolved.retryDelayMs,
  };
}

function writeWebhookConfig(configPath: string, resolved: ResolvedWebhookSetup): void {
  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};

  const notifiers = isRecord(rawConfig["notifiers"]) ? rawConfig["notifiers"] : {};
  notifiers["webhook"] = toWebhookConfig(resolved);
  rawConfig["notifiers"] = notifiers;

  const defaults = isRecord(rawConfig["defaults"]) ? rawConfig["defaults"] : {};
  rawConfig["defaults"] = defaults;

  applyNotifierRoutingPreset(rawConfig, "webhook", resolved.routingPreset);

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

async function printStatus(): Promise<void> {
  const context = readConfigContext();
  const existingWebhook = getExistingWebhook(context.rawConfig);
  const plugin = stringValue(existingWebhook["plugin"]);
  const url = stringValue(existingWebhook["url"]);
  const hasAuth = Boolean(getBearerToken(existingWebhook["headers"]));
  const retries = numberValue(existingWebhook["retries"], DEFAULT_RETRIES);
  const retryDelayMs = numberValue(existingWebhook["retryDelayMs"], DEFAULT_RETRY_DELAY_MS);

  console.log(chalk.bold("Webhook notifier status"));
  console.log(`  Config: ${context.configPath}`);
  console.log(`  Plugin: ${plugin ?? chalk.dim("not configured")}`);
  console.log(`  URL: ${url ?? chalk.dim("not configured")}`);
  console.log(`  Auth: ${hasAuth ? "Authorization bearer token configured" : "none"}`);
  console.log(`  Retries: ${retries}`);
  console.log(`  Retry delay: ${retryDelayMs}ms`);
  console.log(`  Routing: ${getNotifierRoutingState(context.rawConfig, "webhook").label}`);

  if (plugin !== "webhook" || !url) return;

  try {
    await sendSetupProbe(
      buildResolvedSetup(
        url,
        getBearerToken(existingWebhook["headers"]),
        retries,
        retryDelayMs,
        undefined,
        { test: true },
      ),
    );
    console.log(chalk.green("  Probe: PASS"));
  } catch (error) {
    console.log(
      chalk.red(`  Probe: FAIL ${error instanceof Error ? error.message : String(error)}`),
    );
  }
}

export async function runWebhookSetupAction(opts: WebhookSetupOptions): Promise<void> {
  const nonInteractive = opts.nonInteractive || !process.stdin.isTTY;
  const force = Boolean(opts.force);

  if (opts.status) {
    await printStatus();
    return;
  }

  const context = readConfigContext();
  const existingWebhook = getExistingWebhook(context.rawConfig);
  const shouldWire = await shouldReplaceConflictingWebhook(
    existingWebhook["plugin"],
    force,
    nonInteractive,
  );
  if (!shouldWire) return;

  const resolved = nonInteractive
    ? resolveNonInteractiveSetup(opts, existingWebhook)
    : await resolveInteractiveSetup(opts, existingWebhook, context.rawConfig);

  if (resolved.shouldSendTest) {
    await sendSetupProbe(resolved);
    console.log(chalk.green("✓ Webhook setup test passed"));
  } else {
    console.log(chalk.dim("Skipped webhook setup test."));
  }

  writeWebhookConfig(context.configPath, resolved);
  console.log(chalk.green(`✓ Config written to ${context.configPath}`));

  if (!nonInteractive) {
    const clack = await import("@clack/prompts");
    clack.outro(
      `${chalk.green("Webhook setup complete!")} AO will send notifications to ${resolved.url}.\n` +
        chalk.dim("  Test it with: ao notify test --to webhook --template basic"),
    );
  } else {
    console.log(chalk.green("\n✓ Webhook setup complete."));
    console.log(chalk.dim("Test it with: ao notify test --to webhook --template basic"));
  }
}
