import { readFileSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import { parseDocument } from "yaml";
import { CONFIG_SCHEMA_URL, findConfigFile, isCanonicalGlobalConfigPath } from "@aoagents/ao-core";
import {
  applyNotifierRoutingPreset,
  ensureNotifierDefault,
  getNotifierRoutingState,
  promptNotifierRoutingPreset,
  resolveRoutingPresetOption,
  routingLabel,
  type ClackPrompts,
  type NotifierRoutingPreset,
} from "./notifier-routing.js";

const SLACK_TOOLKIT = "slack";
const DISCORD_TOOLKIT = "discordbot";
const GMAIL_TOOLKIT = "gmail";
const DISCORD_TOOL_VERSION = "20260429_01";
const GMAIL_TOOL_VERSION = "20260506_01";
const COMPOSIO_NOTIFIER = "composio";
const COMPOSIO_SLACK_NOTIFIER = "composio-slack";
const COMPOSIO_DISCORD_WEBHOOK_NOTIFIER = "composio-discord";
const COMPOSIO_DISCORD_BOT_NOTIFIER = "composio-discord-bot";
const COMPOSIO_MAIL_NOTIFIER = "composio-mail";
const DEFAULT_COMPOSIO_USER_ID = "aoagent";
const GMAIL_SEND_TOOL = "GMAIL_SEND_EMAIL";
const COMPOSIO_DASHBOARD_URL = "https://app.composio.dev";
const DISCORD_APP_URL = "https://discord.com/app";
const DISCORD_DEVELOPER_PORTAL_URL = "https://discord.com/developers/applications";
const DISCORD_WEBHOOK_DOCS_URL =
  "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks";

export class ComposioSetupError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "ComposioSetupError";
  }
}

export interface ComposioSetupOptions {
  apiKey?: string;
  userId?: string;
  channel?: string;
  connectedAccountId?: string;
  webhookUrl?: string;
  channelId?: string;
  botToken?: string;
  emailTo?: string;
  authConfigId?: string;
  connect?: boolean;
  slack?: boolean;
  discordWebhook?: boolean;
  discordBot?: boolean;
  gmail?: boolean;
  nonInteractive?: boolean;
  status?: boolean;
  force?: boolean;
  waitMs?: string;
  routingPreset?: string;
}

export interface ComposioDiscordWebhookSetupOptions {
  apiKey?: string;
  userId?: string;
  webhookUrl?: string;
  connectedAccountId?: string;
  nonInteractive?: boolean;
  status?: boolean;
  force?: boolean;
  routingPreset?: string;
}

export interface ComposioDiscordBotSetupOptions {
  apiKey?: string;
  userId?: string;
  channelId?: string;
  botToken?: string;
  connectedAccountId?: string;
  nonInteractive?: boolean;
  status?: boolean;
  force?: boolean;
  routingPreset?: string;
}

export interface ComposioMailSetupOptions {
  apiKey?: string;
  userId?: string;
  emailTo?: string;
  authConfigId?: string;
  connectedAccountId?: string;
  connect?: boolean;
  nonInteractive?: boolean;
  status?: boolean;
  force?: boolean;
  waitMs?: string;
  routingPreset?: string;
}

type ComposioAppChoice = "slack" | "discord-webhook" | "discord-bot" | "gmail";

interface ResolvedApiKey {
  apiKey: string;
  shouldWriteApiKey: boolean;
  sourceLabel: string;
}

interface ConnectedAccount {
  id: string;
  status?: string;
  statusReason?: string | null;
  toolkit?: { slug?: string };
  authConfig?: { id?: string; name?: string };
  alias?: string | null;
  isDisabled?: boolean;
  scopes?: string[];
}

interface AuthConfigSummary {
  id: string;
  toolkit?: { slug?: string };
  toolAccessConfig?: {
    toolsAvailableForExecution?: string[];
    toolsForConnectedAccountCreation?: string[];
  };
  restrictToFollowingTools?: string[];
}

interface ConnectionRequest {
  id?: string;
  redirectUrl?: string;
  waitForConnection?: (timeout?: number) => Promise<unknown>;
}

interface ComposioSetupClient {
  connectedAccounts: {
    list: (query?: Record<string, unknown>) => Promise<unknown>;
    get?: (id: string) => Promise<unknown>;
    link?: (
      userId: string,
      authConfigId: string,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
    initiate?: (
      userId: string,
      authConfigId: string,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
    waitForConnection?: (id: string, timeout?: number) => Promise<unknown>;
  };
  authConfigs?: {
    list?: (query?: Record<string, unknown>) => Promise<unknown>;
    create?: (toolkit: string, options?: Record<string, unknown>) => Promise<unknown>;
    get?: (id: string) => Promise<unknown>;
    retrieve?: (id: string) => Promise<unknown>;
  };
  toolkits?: {
    authorize?: (userId: string, toolkitSlug: string, authConfigId?: string) => Promise<unknown>;
  };
}

interface ResolvedComposioSetup {
  apiKey: string;
  shouldWriteApiKey: boolean;
  userId: string;
  targetName?: string;
  channel?: string;
  connectedAccountId?: string;
  connectionUrl?: string;
  routingPreset?: NotifierRoutingPreset;
}

interface ResolvedDiscordSetup {
  apiKey: string;
  shouldWriteApiKey: boolean;
  userId: string;
  mode: "webhook" | "bot";
  targetName: string;
  webhookUrl?: string;
  channelId?: string;
  connectedAccountId?: string;
  routingPreset?: NotifierRoutingPreset;
}

interface ResolvedMailSetup {
  apiKey: string;
  shouldWriteApiKey: boolean;
  userId: string;
  emailTo?: string;
  connectedAccountId?: string;
  connectionUrl?: string;
  targetName?: string;
  routingPreset?: NotifierRoutingPreset;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value === "string") return [value];
  return [];
}

function resolveComposioRoutingPreset(
  value: string | undefined,
): NotifierRoutingPreset | undefined {
  try {
    return resolveRoutingPresetOption(value, "Composio") as NotifierRoutingPreset | undefined;
  } catch (error) {
    throw new ComposioSetupError(error instanceof Error ? error.message : String(error));
  }
}

function routingReviewLabel(preset: NotifierRoutingPreset | undefined): string {
  return preset ? routingLabel(preset) : "unchanged";
}

function scopeArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string") {
    return value
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function getExistingComposioConfig(rawConfig: Record<string, unknown>): Record<string, unknown> {
  return getExistingNotifierConfig(rawConfig, COMPOSIO_NOTIFIER);
}

function getExistingNotifierConfig(
  rawConfig: Record<string, unknown>,
  notifierName: string,
): Record<string, unknown> {
  const notifiers = isRecord(rawConfig["notifiers"]) ? rawConfig["notifiers"] : {};
  const existing = isRecord(notifiers[notifierName]) ? notifiers[notifierName] : {};
  return existing;
}

function resolveApiKeyCandidate(
  opts: { apiKey?: string },
  existing: Record<string, unknown>,
): ResolvedApiKey | undefined {
  const optionKey = stringValue(opts.apiKey);
  if (optionKey) {
    return {
      apiKey: optionKey,
      shouldWriteApiKey: true,
      sourceLabel: "command option",
    };
  }

  const envKey = stringValue(process.env.COMPOSIO_API_KEY);
  if (envKey) {
    return {
      apiKey: envKey,
      shouldWriteApiKey: false,
      sourceLabel: "COMPOSIO_API_KEY",
    };
  }

  const existingKey = stringValue(existing["composioApiKey"]);
  if (existingKey && !existingKey.includes("${")) {
    return {
      apiKey: existingKey,
      shouldWriteApiKey: true,
      sourceLabel: "agent-orchestrator.yaml",
    };
  }

  return undefined;
}

function resolveApiKey(
  opts: { apiKey?: string },
  existing: Record<string, unknown>,
): { apiKey?: string; shouldWriteApiKey: boolean } {
  const candidate = resolveApiKeyCandidate(opts, existing);
  return {
    apiKey: candidate?.apiKey,
    shouldWriteApiKey: candidate?.shouldWriteApiKey ?? false,
  };
}

function resolveUserId(opts: { userId?: string }, existing: Record<string, unknown>): string {
  return (
    stringValue(opts.userId) ??
    stringValue(existing["userId"]) ??
    stringValue(existing["entityId"]) ??
    stringValue(process.env.COMPOSIO_USER_ID) ??
    stringValue(process.env.COMPOSIO_ENTITY_ID) ??
    DEFAULT_COMPOSIO_USER_ID
  );
}

function isComposioSetupClient(value: unknown): value is ComposioSetupClient {
  return (
    isRecord(value) &&
    isRecord(value["connectedAccounts"]) &&
    typeof value["connectedAccounts"]["list"] === "function"
  );
}

async function loadComposioClient(apiKey: string): Promise<ComposioSetupClient> {
  const mod = (await import("@composio/core")) as unknown as Record<string, unknown>;
  const ComposioClass = (mod.Composio ??
    (mod.default as Record<string, unknown> | undefined)?.Composio ??
    mod.default) as (new (opts: { apiKey: string }) => unknown) | undefined;

  if (typeof ComposioClass !== "function") {
    throw new ComposioSetupError("Could not find Composio class in @composio/core module.");
  }

  const client = new ComposioClass({ apiKey });
  if (!isComposioSetupClient(client)) {
    throw new ComposioSetupError("Composio SDK client does not expose connectedAccounts.list().");
  }

  return client;
}

function toConnectedAccount(value: unknown): ConnectedAccount | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value["id"]);
  if (!id) return null;
  const data = isRecord(value["data"]) ? value["data"] : {};
  const params = isRecord(value["params"]) ? value["params"] : {};
  const state = isRecord(value["state"]) ? value["state"] : {};
  const stateVal = isRecord(state["val"]) ? state["val"] : {};

  return {
    id,
    status: stringValue(value["status"]),
    statusReason: stringValue(value["statusReason"]) ?? stringValue(value["status_reason"]) ?? null,
    toolkit: isRecord(value["toolkit"])
      ? { slug: stringValue(value["toolkit"]["slug"]) }
      : undefined,
    authConfig: isRecord(value["authConfig"])
      ? {
          id: stringValue(value["authConfig"]["id"]),
          name: stringValue(value["authConfig"]["name"]),
        }
      : undefined,
    alias: stringValue(value["alias"]) ?? null,
    isDisabled: value["isDisabled"] === true || value["is_disabled"] === true,
    scopes: [
      ...scopeArray(data["scope"]),
      ...scopeArray(data["scopes"]),
      ...scopeArray(params["scope"]),
      ...scopeArray(params["scopes"]),
      ...scopeArray(stateVal["scope"]),
      ...scopeArray(stateVal["scopes"]),
    ],
  };
}

function toAuthConfigSummary(value: unknown): AuthConfigSummary | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value["id"]);
  if (!id) return null;
  const toolkit = isRecord(value["toolkit"]) ? value["toolkit"] : {};
  const toolAccessConfig = isRecord(value["toolAccessConfig"])
    ? value["toolAccessConfig"]
    : isRecord(value["tool_access_config"])
      ? value["tool_access_config"]
      : {};

  return {
    id,
    toolkit: isRecord(toolkit) ? { slug: stringValue(toolkit["slug"]) } : undefined,
    toolAccessConfig: {
      toolsAvailableForExecution: asStringArray(
        toolAccessConfig["toolsAvailableForExecution"] ??
          toolAccessConfig["tools_available_for_execution"],
      ),
      toolsForConnectedAccountCreation: asStringArray(
        toolAccessConfig["toolsForConnectedAccountCreation"] ??
          toolAccessConfig["tools_for_connected_account_creation"],
      ),
    },
    restrictToFollowingTools: asStringArray(
      value["restrictToFollowingTools"] ?? value["restrict_to_following_tools"],
    ),
  };
}

function accountsFromListResult(result: unknown): ConnectedAccount[] {
  if (Array.isArray(result))
    return result.map(toConnectedAccount).filter((a): a is ConnectedAccount => a !== null);
  if (isRecord(result) && Array.isArray(result["items"])) {
    return result["items"].map(toConnectedAccount).filter((a): a is ConnectedAccount => a !== null);
  }
  if (isRecord(result) && Array.isArray(result["data"])) {
    return result["data"].map(toConnectedAccount).filter((a): a is ConnectedAccount => a !== null);
  }
  return [];
}

function authConfigsFromListResult(result: unknown): AuthConfigSummary[] {
  if (Array.isArray(result))
    return result.map(toAuthConfigSummary).filter((a): a is AuthConfigSummary => a !== null);
  if (isRecord(result) && Array.isArray(result["items"])) {
    return result["items"]
      .map(toAuthConfigSummary)
      .filter((a): a is AuthConfigSummary => a !== null);
  }
  if (isRecord(result) && Array.isArray(result["data"])) {
    return result["data"]
      .map(toAuthConfigSummary)
      .filter((a): a is AuthConfigSummary => a !== null);
  }
  return [];
}

function isActive(account: ConnectedAccount): boolean {
  if (account.isDisabled) return false;
  return !account.status || account.status.toUpperCase() === "ACTIVE";
}

function isToolkit(account: ConnectedAccount, toolkit: string): boolean {
  return !account.toolkit?.slug || account.toolkit.slug.toLowerCase() === toolkit;
}

function hasGmailNotifyScopes(account: ConnectedAccount): boolean {
  const scopes = new Set(account.scopes ?? []);
  if (scopes.has("https://mail.google.com/")) return true;
  const canSend = scopes.has("https://www.googleapis.com/auth/gmail.send");
  const canReadProfile =
    scopes.has("https://www.googleapis.com/auth/gmail.metadata") ||
    scopes.has("https://www.googleapis.com/auth/gmail.readonly") ||
    scopes.has("https://www.googleapis.com/auth/gmail.modify");
  return canSend && canReadProfile;
}

function authConfigAllowsGmailSend(config: AuthConfigSummary): boolean {
  const tools = [
    ...(config.toolAccessConfig?.toolsForConnectedAccountCreation ?? []),
    ...(config.toolAccessConfig?.toolsAvailableForExecution ?? []),
    ...(config.restrictToFollowingTools ?? []),
  ];
  return tools.includes(GMAIL_SEND_TOOL);
}

async function withConnectedAccountDetails(
  client: ComposioSetupClient,
  account: ConnectedAccount,
): Promise<ConnectedAccount> {
  if (!client.connectedAccounts.get) return account;
  const detailed = toConnectedAccount(await client.connectedAccounts.get(account.id));
  return detailed ?? account;
}

async function listActiveSlackAccounts(
  client: ComposioSetupClient,
  userId: string,
): Promise<ConnectedAccount[]> {
  return listActiveToolkitAccounts(client, userId, SLACK_TOOLKIT);
}

async function listActiveGmailAccounts(
  client: ComposioSetupClient,
  userId: string,
): Promise<ConnectedAccount[]> {
  return listActiveToolkitAccounts(client, userId, GMAIL_TOOLKIT);
}

async function listUsableGmailAccounts(
  client: ComposioSetupClient,
  userId: string,
): Promise<ConnectedAccount[]> {
  const accounts = await listActiveGmailAccounts(client, userId);
  const detailed = await Promise.all(
    accounts.map((account) => withConnectedAccountDetails(client, account)),
  );
  const usable: ConnectedAccount[] = [];
  for (const account of detailed) {
    if (await accountCanSendGmail(client, account)) {
      usable.push(account);
    }
  }
  return usable;
}

async function listActiveToolkitAccounts(
  client: ComposioSetupClient,
  userId: string,
  toolkit: string,
): Promise<ConnectedAccount[]> {
  const result = await client.connectedAccounts.list({
    userIds: [userId],
    toolkitSlugs: [toolkit],
    statuses: ["ACTIVE"],
    limit: 25,
  });
  return accountsFromListResult(result).filter(
    (account) => isActive(account) && isToolkit(account, toolkit),
  );
}

async function verifyConnectedAccount(
  client: ComposioSetupClient,
  userId: string,
  connectedAccountId: string,
): Promise<ConnectedAccount> {
  return verifyConnectedAccountForToolkit(
    client,
    userId,
    connectedAccountId,
    SLACK_TOOLKIT,
    "Slack",
    () => listActiveSlackAccounts(client, userId),
  );
}

async function verifyConnectedAccountForToolkit(
  client: ComposioSetupClient,
  userId: string,
  connectedAccountId: string,
  toolkit: string,
  label: string,
  fallbackList?: () => Promise<ConnectedAccount[]>,
): Promise<ConnectedAccount> {
  const account = client.connectedAccounts.get
    ? toConnectedAccount(await client.connectedAccounts.get(connectedAccountId))
    : ((await fallbackList?.())?.find((candidate) => candidate.id === connectedAccountId) ?? null);

  if (!account) {
    throw new ComposioSetupError(
      `Could not find Composio connected account ${connectedAccountId} for user ${userId}.`,
    );
  }
  if (!isToolkit(account, toolkit)) {
    throw new ComposioSetupError(
      `Connected account ${connectedAccountId} is not a ${label} account.`,
    );
  }
  if (!isActive(account)) {
    throw new ComposioSetupError(
      `Connected account ${connectedAccountId} is not ACTIVE (status: ${account.status ?? "unknown"}).`,
    );
  }
  return account;
}

async function getAuthConfig(
  client: ComposioSetupClient,
  authConfigId: string,
): Promise<AuthConfigSummary | null> {
  const result = client.authConfigs?.get
    ? await client.authConfigs.get(authConfigId)
    : client.authConfigs?.retrieve
      ? await client.authConfigs.retrieve(authConfigId)
      : null;
  return toAuthConfigSummary(result);
}

async function accountCanSendGmail(
  client: ComposioSetupClient,
  account: ConnectedAccount,
): Promise<boolean> {
  if (hasGmailNotifyScopes(account)) return true;
  const authConfigId = account.authConfig?.id;
  if (!authConfigId) return false;
  const authConfig = await getAuthConfig(client, authConfigId);
  return authConfig ? authConfigAllowsGmailSend(authConfig) : false;
}

async function resolveGmailConnectAuthConfigId(
  client: ComposioSetupClient,
  explicitAuthConfigId: string | undefined,
  nonInteractive: boolean,
): Promise<string> {
  if (explicitAuthConfigId) {
    const config = await getAuthConfig(client, explicitAuthConfigId);
    if (config?.toolkit?.slug && config.toolkit.slug.toLowerCase() !== GMAIL_TOOLKIT) {
      throw new ComposioSetupError(`Auth config ${explicitAuthConfigId} is not a Gmail config.`);
    }
    if (config && !authConfigAllowsGmailSend(config)) {
      console.log(
        chalk.yellow(
          `Auth config ${explicitAuthConfigId} does not explicitly list ${GMAIL_SEND_TOOL}; creating the link anyway.`,
        ),
      );
    }
    return explicitAuthConfigId;
  }

  if (!client.authConfigs?.list) {
    throw new ComposioSetupError(
      "Composio SDK client does not expose authConfigs.list(); pass --auth-config-id.",
    );
  }

  const configs = authConfigsFromListResult(
    await client.authConfigs.list({ toolkit: GMAIL_TOOLKIT }),
  ).filter(
    (config) => !config.toolkit?.slug || config.toolkit.slug.toLowerCase() === GMAIL_TOOLKIT,
  );
  const sendConfigs = configs.filter(authConfigAllowsGmailSend);
  const candidates = sendConfigs.length > 0 ? sendConfigs : configs;

  if (candidates.length === 0) {
    throw new ComposioSetupError(
      "No Composio Gmail auth config found. Create/connect Gmail in Composio, or rerun with --auth-config-id ac_...",
    );
  }

  if (sendConfigs.length === 0) {
    console.log(
      chalk.yellow(
        `No Gmail auth config explicitly lists ${GMAIL_SEND_TOOL}; using an existing Gmail auth config anyway.`,
      ),
    );
  }

  return (await chooseAuthConfig(candidates, nonInteractive, "Gmail")).id;
}

async function chooseAccount(
  accounts: ConnectedAccount[],
  nonInteractive: boolean,
  label = "Slack",
): Promise<ConnectedAccount> {
  if (accounts.length === 1) return accounts[0]!;

  if (nonInteractive) {
    throw new ComposioSetupError(
      `Multiple active ${label} connected accounts found. Re-run with --connected-account-id.\n` +
        accounts.map((account) => `  - ${account.id}`).join("\n"),
    );
  }

  const clack = await import("@clack/prompts");
  const selected = await clack.select({
    message: `Select the ${label} connected account AO should use:`,
    options: accounts.map((account) => ({
      value: account.id,
      label: account.alias ? `${account.alias} (${account.id})` : account.id,
    })),
  });

  if (clack.isCancel(selected)) {
    throw new ComposioSetupError("Setup cancelled.", 0);
  }

  return accounts.find((account) => account.id === selected)!;
}

async function chooseAuthConfig(
  configs: AuthConfigSummary[],
  nonInteractive: boolean,
  label: string,
): Promise<AuthConfigSummary> {
  if (configs.length === 1) return configs[0]!;

  if (nonInteractive) {
    throw new ComposioSetupError(
      `Multiple ${label} auth configs found. Re-run with --auth-config-id.\n` +
        configs.map((config) => `  - ${config.id}`).join("\n"),
    );
  }

  const clack = await import("@clack/prompts");
  const selected = await clack.select({
    message: `Select the ${label} auth config AO should use:`,
    options: configs.map((config) => ({
      value: config.id,
      label: config.id,
    })),
  });

  if (clack.isCancel(selected)) {
    throw new ComposioSetupError("Setup cancelled.", 0);
  }

  return configs.find((config) => config.id === selected)!;
}

function toConnectionRequest(value: unknown): ConnectionRequest {
  if (!isRecord(value)) return {};
  return {
    id: stringValue(value["id"]),
    redirectUrl: stringValue(value["redirectUrl"]),
    waitForConnection:
      typeof value["waitForConnection"] === "function"
        ? (value["waitForConnection"] as (timeout?: number) => Promise<unknown>)
        : undefined,
  };
}

async function resolveManagedAuthConfigId(
  client: ComposioSetupClient,
  toolkit: string,
  label: string,
  name: string,
  options: {
    scopes?: readonly string[];
    toolsForConnectedAccountCreation?: string[];
    existingAuthConfigPredicate?: (config: AuthConfigSummary) => boolean;
    forceCreate?: boolean;
  } = {},
): Promise<string> {
  if (!options.forceCreate) {
    const existing = client.authConfigs?.list
      ? authConfigsFromListResult(await client.authConfigs.list({ toolkit })).find(
          (config) =>
            (!config.toolkit?.slug || config.toolkit.slug.toLowerCase() === toolkit) &&
            (!options.existingAuthConfigPredicate || options.existingAuthConfigPredicate(config)),
        )?.id
      : undefined;
    if (existing) return existing;
  }

  if (!client.authConfigs?.create) {
    throw new ComposioSetupError(
      `Composio SDK client does not expose authConfigs.create(); connect ${label} in Composio and pass --connected-account-id.`,
    );
  }

  const created = await client.authConfigs.create(toolkit, {
    type: "use_composio_managed_auth",
    name,
    ...(options.scopes ? { credentials: { scopes: [...options.scopes] } } : {}),
    ...(options.toolsForConnectedAccountCreation
      ? {
          toolAccessConfig: {
            toolsForConnectedAccountCreation: options.toolsForConnectedAccountCreation,
          },
        }
      : {}),
  });
  const createdId = isRecord(created) ? stringValue(created["id"]) : undefined;
  if (!createdId) {
    throw new ComposioSetupError(`Could not create a Composio ${label} auth config.`);
  }

  return createdId;
}

async function createConnectionRequest(
  client: ComposioSetupClient,
  userId: string,
  waitMs: number,
): Promise<{ account?: ConnectedAccount; url?: string }> {
  return createManagedOAuthConnectionRequest(
    client,
    userId,
    SLACK_TOOLKIT,
    "Slack",
    "Slack Auth Config",
    waitMs,
  );
}

async function createManagedOAuthConnectionRequest(
  client: ComposioSetupClient,
  userId: string,
  toolkit: string,
  label: string,
  authConfigName: string,
  waitMs: number,
  options: {
    authConfigId?: string;
    scopes?: readonly string[];
    toolsForConnectedAccountCreation?: string[];
    existingAuthConfigPredicate?: (config: AuthConfigSummary) => boolean;
    forceCreateAuthConfig?: boolean;
  } = {},
): Promise<{ account?: ConnectedAccount; url?: string }> {
  let request: ConnectionRequest;

  if (client.connectedAccounts.link) {
    const authConfigId =
      options.authConfigId ??
      (await resolveManagedAuthConfigId(client, toolkit, label, authConfigName, {
        scopes: options.scopes,
        toolsForConnectedAccountCreation: options.toolsForConnectedAccountCreation,
        existingAuthConfigPredicate: options.existingAuthConfigPredicate,
        forceCreate: options.forceCreateAuthConfig,
      }));
    request = toConnectionRequest(
      await client.connectedAccounts.link(userId, authConfigId, { allowMultiple: true }),
    );
  } else if (client.toolkits?.authorize) {
    request = toConnectionRequest(
      await client.toolkits.authorize(userId, toolkit, options.authConfigId),
    );
  } else {
    throw new ComposioSetupError(
      `Composio SDK client does not expose connectedAccounts.link(); connect ${label} in Composio and pass --connected-account-id.`,
    );
  }

  if (request.redirectUrl) {
    console.log(chalk.cyan(`Open this Composio ${label} connect URL: ${request.redirectUrl}`));
  }

  if (!request.id && !request.waitForConnection) {
    return { url: request.redirectUrl };
  }

  try {
    const connected = request.waitForConnection
      ? await request.waitForConnection(waitMs)
      : await client.connectedAccounts.waitForConnection?.(request.id!, waitMs);
    const account = toConnectedAccount(connected);
    return account ? { account, url: request.redirectUrl } : { url: request.redirectUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.yellow(`Connection did not complete yet: ${message}`));
    return { url: request.redirectUrl };
  }
}

function parseWaitMs(value: string | undefined): number {
  if (!value) return 60_000;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ComposioSetupError("--wait-ms must be a non-negative number.");
  }
  return parsed;
}

function channelConfig(channel: string | undefined): Record<string, string> {
  const value = stringValue(channel);
  if (!value) return {};
  if (/^[CGD][A-Z0-9]{8,}$/.test(value)) {
    return { channelId: value };
  }
  return { channelName: value };
}

function shouldUseInteractiveComposioHub(
  opts: ComposioSetupOptions,
  nonInteractive: boolean,
): boolean {
  if (nonInteractive || opts.status) return false;
  if (getDirectComposioAppChoice(opts)) return true;
  return !(
    stringValue(opts.apiKey) ||
    stringValue(opts.userId) ||
    stringValue(opts.channel) ||
    stringValue(opts.connectedAccountId) ||
    (stringValue(opts.waitMs) && stringValue(opts.waitMs) !== "60000")
  );
}

function getDirectComposioAppChoice(opts: ComposioSetupOptions): ComposioAppChoice | undefined {
  const choices: ComposioAppChoice[] = [];
  if (opts.slack) choices.push("slack");
  if (opts.discordWebhook) choices.push("discord-webhook");
  if (opts.discordBot) choices.push("discord-bot");
  if (opts.gmail) choices.push("gmail");

  if (choices.length > 1) {
    throw new ComposioSetupError(
      "Choose only one Composio app flag: --slack, --discord-webhook, --discord-bot, or --gmail.",
    );
  }
  return choices[0];
}

function shouldUseInteractiveDedicatedSetup(
  opts: { nonInteractive?: boolean; status?: boolean },
  nonInteractive: boolean,
): boolean {
  return !nonInteractive && !opts.status;
}

function cancelInteractiveComposioSetup(clack: ClackPrompts): never {
  clack.cancel("Setup cancelled.");
  throw new ComposioSetupError("Setup cancelled.", 0);
}

function printComposioApiKeyInstructions(): void {
  console.log("");
  console.log(chalk.bold("Find your Composio API key"));
  console.log(`  1. Open ${COMPOSIO_DASHBOARD_URL}`);
  console.log("  2. Open your project settings or developer settings.");
  console.log("  3. Create or copy an API key that can execute tools.");
  console.log("");
}

function printComposioSlackAccountInfo(): void {
  console.log(
    chalk.dim(
      "AO uses a Composio Slack connected account to execute SLACK_SEND_MESSAGE. The userId groups connected accounts inside your Composio project.",
    ),
  );
}

function printComposioSlackChannelInfo(): void {
  console.log(
    chalk.dim(
      "Slack channel is optional for Composio. If set, AO passes it to SLACK_SEND_MESSAGE; use the channel name without # or a Slack channel id.",
    ),
  );
}

function printComposioSlackReview(resolved: ResolvedComposioSetup, apiKeySource: string): void {
  console.log("");
  console.log(chalk.bold("Review Composio Slack setup"));
  console.log("  app: Slack");
  console.log(`  notifier: ${resolved.targetName ?? COMPOSIO_NOTIFIER}`);
  console.log(`  api key: configured from ${apiKeySource}`);
  console.log(`  userId: ${resolved.userId}`);
  console.log(`  connectedAccountId: ${resolved.connectedAccountId ?? "not configured"}`);
  console.log(`  channel: ${resolved.channel ?? "not set"}`);
  console.log(`  routing: ${routingReviewLabel(resolved.routingPreset)}`);
  console.log("");
}

function redactDiscordWebhookUrl(webhookUrl: string | undefined): string {
  if (!webhookUrl) return "not configured";
  try {
    const parsed = new URL(webhookUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const webhookIndex = segments.findIndex((segment) => segment === "webhooks");
    if (webhookIndex >= 0 && segments[webhookIndex + 1]) {
      return `${parsed.origin}/api/webhooks/${segments[webhookIndex + 1]}/...`;
    }
  } catch {
    // Fall through to generic redaction.
  }
  return "configured";
}

function printComposioDiscordWebhookInfo(): void {
  console.log(
    chalk.dim(
      "AO uses Composio's discordbot toolkit with DISCORDBOT_EXECUTE_WEBHOOK. Webhook mode stores the Discord webhook token as a Composio bearer connected account; no Discord bot invite is required.",
    ),
  );
}

function printDiscordWebhookInstructions(): void {
  console.log("");
  console.log(chalk.bold("Create a Discord webhook URL"));
  console.log(`  1. Open ${DISCORD_APP_URL}`);
  console.log("  2. Open the target server and channel.");
  console.log("  3. Open Edit Channel > Integrations > Webhooks.");
  console.log("  4. Create a webhook and copy its URL.");
  console.log("  5. Paste the URL here.");
  console.log(chalk.dim(`Discord help: ${DISCORD_WEBHOOK_DOCS_URL}`));
  console.log("");
}

function printComposioDiscordWebhookReview(
  resolved: ResolvedDiscordSetup,
  apiKeySource: string,
): void {
  console.log("");
  console.log(chalk.bold("Review Composio Discord webhook setup"));
  console.log("  app: Discord webhook");
  console.log(`  notifier: ${resolved.targetName}`);
  console.log(`  api key: configured from ${apiKeySource}`);
  console.log(`  userId: ${resolved.userId}`);
  console.log(`  webhookUrl: ${redactDiscordWebhookUrl(resolved.webhookUrl)}`);
  console.log(
    `  connectedAccountId: ${resolved.connectedAccountId ?? "will be created from webhook URL"}`,
  );
  console.log(`  toolVersion: ${DISCORD_TOOL_VERSION}`);
  console.log(`  routing: ${routingReviewLabel(resolved.routingPreset)}`);
  console.log("");
}

function printComposioDiscordBotInfo(): void {
  console.log(
    chalk.dim(
      "AO uses Composio's discordbot toolkit with DISCORDBOT_CREATE_MESSAGE. Bot mode requires a Discord channel id and a Composio Discord bot connected account.",
    ),
  );
}

function printDiscordBotInstructions(): void {
  console.log("");
  console.log(chalk.bold("Create and invite a Discord bot"));
  console.log(`  1. Open ${DISCORD_DEVELOPER_PORTAL_URL}`);
  console.log("  2. Create or select an application, then open Bot.");
  console.log("  3. Create/reset the bot token and keep it available for this setup.");
  console.log("  4. Open OAuth2 > URL Generator.");
  console.log("  5. Select the bot scope and grant View Channel + Send Messages.");
  console.log("  6. Open the generated URL and invite the bot to the target server.");
  console.log("  7. In Discord, enable Developer Mode and copy the target channel ID.");
  console.log("");
}

function printDiscordChannelIdInstructions(): void {
  console.log("");
  console.log(chalk.bold("Find a Discord channel ID"));
  console.log("  1. Open Discord User Settings > Advanced.");
  console.log("  2. Enable Developer Mode.");
  console.log("  3. Right-click the target channel.");
  console.log("  4. Click Copy Channel ID and paste it here.");
  console.log("");
}

function printComposioDiscordBotReview(resolved: ResolvedDiscordSetup, apiKeySource: string): void {
  console.log("");
  console.log(chalk.bold("Review Composio Discord bot setup"));
  console.log("  app: Discord bot");
  console.log(`  notifier: ${resolved.targetName}`);
  console.log(`  api key: configured from ${apiKeySource}`);
  console.log(`  userId: ${resolved.userId}`);
  console.log(`  channelId: ${resolved.channelId ?? "not configured"}`);
  console.log(`  connectedAccountId: ${resolved.connectedAccountId ?? "not configured"}`);
  console.log(`  toolVersion: ${DISCORD_TOOL_VERSION}`);
  console.log(`  routing: ${routingReviewLabel(resolved.routingPreset)}`);
  console.log("");
}

function printComposioGmailInfo(): void {
  console.log(
    chalk.dim(
      "AO uses Composio's Gmail toolkit with GMAIL_SEND_EMAIL. Gmail mode requires a recipient email and a Gmail connected account with send/profile access.",
    ),
  );
}

function printComposioGmailConnectInfo(): void {
  console.log("");
  console.log(chalk.bold("Connect Gmail in Composio"));
  console.log(`  1. Open ${COMPOSIO_DASHBOARD_URL}`);
  console.log("  2. Make sure your project has a Gmail auth config with send access.");
  console.log("  3. AO can create a Composio connect link from that existing auth config.");
  console.log("  4. Complete the Google OAuth flow, then return here.");
  console.log(
    chalk.dim(
      "AO does not create Gmail OAuth/auth configs because Google may block unverified or invalid OAuth apps.",
    ),
  );
  console.log("");
}

function printComposioGmailReview(resolved: ResolvedMailSetup, apiKeySource: string): void {
  console.log("");
  console.log(chalk.bold("Review Composio Gmail setup"));
  console.log("  app: Gmail");
  console.log(`  notifier: ${resolved.targetName ?? COMPOSIO_NOTIFIER}`);
  console.log(`  api key: configured from ${apiKeySource}`);
  console.log(`  userId: ${resolved.userId}`);
  console.log(`  emailTo: ${resolved.emailTo ?? "not configured"}`);
  console.log(`  connectedAccountId: ${resolved.connectedAccountId ?? "not configured"}`);
  console.log(`  toolVersion: ${GMAIL_TOOL_VERSION}`);
  console.log(`  routing: ${routingReviewLabel(resolved.routingPreset)}`);
  console.log("");
}

function printComposioAppRequirements(choice: ComposioAppChoice): void {
  console.log("");
  if (choice === "discord-webhook") {
    console.log(chalk.bold("Composio Discord webhook setup"));
    console.log("  Required: Composio API key, userId, Discord webhook URL.");
    console.log("  AO creates/stores a Composio connected account from the webhook token.");
    console.log("  No Discord bot invite is required for webhook mode.");
    console.log("  Current command: ao setup composio-discord --webhook-url <url>");
  } else if (choice === "discord-bot") {
    console.log(chalk.bold("Composio Discord bot setup"));
    console.log("  Required: Composio API key, userId, Discord channel id.");
    console.log("  Also required once: bot token, unless you already have connectedAccountId.");
    console.log("  Current command: ao setup composio-discord-bot --channel-id <id>");
  } else if (choice === "gmail") {
    console.log(chalk.bold("Composio Gmail setup"));
    console.log("  Required: Composio API key, userId, recipient email, Gmail connectedAccountId.");
    console.log("  Gmail OAuth/auth config must be usable in Composio with send/profile access.");
    console.log("  Current command: ao setup composio-mail --email-to <email>");
  }
  console.log(
    chalk.dim("This interactive hub currently implements Slack, Discord webhook/bot, and Gmail."),
  );
  console.log("");
}

async function promptApiKeyInput(clack: ClackPrompts): Promise<ResolvedApiKey> {
  const apiKeyInput = await clack.password({
    message: "Composio API key:",
    validate: (value) => {
      if (!String(value ?? "").trim()) return "Composio API key is required.";
    },
  });

  if (clack.isCancel(apiKeyInput)) {
    cancelInteractiveComposioSetup(clack);
  }

  return {
    apiKey: String(apiKeyInput).trim(),
    shouldWriteApiKey: true,
    sourceLabel: "prompt",
  };
}

async function promptInteractiveComposioApiKey(
  clack: ClackPrompts,
  opts: ComposioSetupOptions,
  existing: Record<string, unknown>,
): Promise<ResolvedApiKey | "back"> {
  const existingKey = resolveApiKeyCandidate(opts, existing);

  while (true) {
    const choice = existingKey
      ? await clack.select({
          message: `Composio API key is already available from ${existingKey.sourceLabel}.`,
          options: [
            {
              value: "use-existing",
              label: "Use existing API key",
              hint: "Keep the configured key",
            },
            {
              value: "enter-new",
              label: "Enter a new API key",
              hint: "Store it in this config",
            },
            {
              value: "show-steps",
              label: "Show where to find it",
              hint: "Print Composio dashboard steps",
            },
            { value: "back", label: "Back", hint: "Return to app choices" },
            { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
          ],
        })
      : await clack.select({
          message: "Composio API key is required to list and create connected accounts.",
          options: [
            {
              value: "enter-new",
              label: "Enter API key",
              hint: "Store it in this config",
            },
            {
              value: "show-steps",
              label: "Show where to find it",
              hint: "Print Composio dashboard steps",
            },
            { value: "back", label: "Back", hint: "Return to app choices" },
            { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
          ],
        });

    if (clack.isCancel(choice) || choice === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (choice === "back") return "back";
    if (choice === "use-existing" && existingKey) return existingKey;
    if (choice === "show-steps") {
      printComposioApiKeyInstructions();
      continue;
    }
    if (choice === "enter-new") {
      return promptApiKeyInput(clack);
    }
  }
}

async function promptInteractiveComposioUserId(
  clack: ClackPrompts,
  opts: ComposioSetupOptions,
  existing: Record<string, unknown>,
): Promise<string | "back"> {
  const currentUserId = resolveUserId(opts, existing);
  console.log(
    chalk.dim(
      `userId is the Composio user namespace AO uses for tool execution and connected-account lookup. For AO-managed setups, ${DEFAULT_COMPOSIO_USER_ID} is the recommended default.`,
    ),
  );

  while (true) {
    const choice = await clack.select({
      message: `Composio userId: ${currentUserId}`,
      options: [
        { value: "use-current", label: `Use ${currentUserId}`, hint: "Recommended" },
        { value: "change", label: "Change userId", hint: "Use a different Composio user id" },
        { value: "back", label: "Back", hint: "Return to API key" },
        { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
      ],
    });

    if (clack.isCancel(choice) || choice === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (choice === "back") return "back";
    if (choice === "use-current") return currentUserId;
    if (choice === "change") {
      const nextUserId = await clack.text({
        message: "Composio userId:",
        initialValue: currentUserId,
        validate: (value) => {
          if (!String(value ?? "").trim()) return "Composio userId is required.";
        },
      });
      if (clack.isCancel(nextUserId)) {
        cancelInteractiveComposioSetup(clack);
      }
      return String(nextUserId).trim();
    }
  }
}

async function promptManualSlackConnectedAccountId(
  clack: ClackPrompts,
  client: ComposioSetupClient,
  userId: string,
  initialValue: string | undefined,
): Promise<string | "back"> {
  const accountId = await clack.text({
    message: "Composio Slack connectedAccountId:",
    placeholder: "ca_...",
    initialValue,
    validate: (value) => {
      if (!String(value ?? "").trim()) return "connectedAccountId is required.";
    },
  });

  if (clack.isCancel(accountId)) {
    cancelInteractiveComposioSetup(clack);
  }

  try {
    const account = await verifyConnectedAccount(client, userId, String(accountId).trim());
    return account.id;
  } catch (error) {
    console.log(chalk.yellow(error instanceof Error ? error.message : String(error)));
    return "back";
  }
}

async function promptChooseSlackConnectedAccount(
  clack: ClackPrompts,
  accounts: ConnectedAccount[],
): Promise<ConnectedAccount | "back"> {
  if (accounts.length === 0) {
    console.log(
      chalk.yellow("No active Slack connected accounts were found for this Composio userId."),
    );
    return "back";
  }

  const selected = await clack.select({
    message: "Select the Slack connected account AO should use:",
    options: [
      ...accounts.map((account) => ({
        value: account.id,
        label: account.alias ? `${account.alias} (${account.id})` : account.id,
      })),
      { value: "back", label: "Back", hint: "Return to Slack account options" },
      { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
    ],
  });

  if (clack.isCancel(selected) || selected === "cancel") {
    cancelInteractiveComposioSetup(clack);
  }
  if (selected === "back") return "back";
  return accounts.find((account) => account.id === selected) ?? "back";
}

async function promptAfterSlackConnectLink(
  clack: ClackPrompts,
  client: ComposioSetupClient,
  userId: string,
  existingConnectedAccountId: string | undefined,
): Promise<string | "back" | "retry-link"> {
  console.log(
    chalk.yellow(
      "Slack connection did not complete yet. Open the connect URL above and finish the Composio flow.",
    ),
  );

  while (true) {
    const next = await clack.select({
      message: "After opening the Composio Slack connect link, what do you want to do?",
      options: [
        {
          value: "check-active",
          label: "I completed the connection",
          hint: "Check Composio for active Slack accounts",
        },
        {
          value: "retry-link",
          label: "Generate link again",
          hint: "Create a fresh Composio Slack connect URL",
        },
        {
          value: "enter-id",
          label: "Enter connectedAccountId",
          hint: "Use an existing ca_... value",
        },
        {
          value: "back",
          label: "Back",
          hint: "Return to Slack account options",
        },
        {
          value: "cancel",
          label: "Cancel setup",
          hint: "Do not change config",
        },
      ],
    });

    if (clack.isCancel(next) || next === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (next === "back") return "back";
    if (next === "retry-link") return "retry-link";

    if (next === "enter-id") {
      const accountId = await promptManualSlackConnectedAccountId(
        clack,
        client,
        userId,
        existingConnectedAccountId,
      );
      if (accountId !== "back") return accountId;
      continue;
    }

    if (next === "check-active") {
      const account = await promptChooseSlackConnectedAccount(
        clack,
        await listActiveSlackAccounts(client, userId),
      );
      if (account !== "back") return account.id;
    }
  }
}

async function promptInteractiveSlackAccount(
  clack: ClackPrompts,
  client: ComposioSetupClient,
  userId: string,
  opts: ComposioSetupOptions,
  existing: Record<string, unknown>,
): Promise<string | "back"> {
  const existingConnectedAccountId =
    stringValue(opts.connectedAccountId) ?? stringValue(existing["connectedAccountId"]);
  printComposioSlackAccountInfo();

  while (true) {
    const options = [
      ...(existingConnectedAccountId
        ? [
            {
              value: "use-existing",
              label: "Use existing connected account",
              hint: existingConnectedAccountId,
            },
          ]
        : []),
      {
        value: "choose-active",
        label: "Choose active Slack account",
        hint: "List accounts already connected in Composio",
      },
      {
        value: "create-link",
        label: "Generate Slack connect link",
        hint: "Open Composio OAuth link and wait for completion",
      },
      {
        value: "enter-id",
        label: "Enter connectedAccountId",
        hint: "Use an existing ca_... value",
      },
      { value: "back", label: "Back", hint: "Return to userId" },
      { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
    ];
    const choice = await clack.select({
      message: "How do you want to choose the Slack connected account?",
      options,
    });

    if (clack.isCancel(choice) || choice === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (choice === "back") return "back";

    if (choice === "use-existing" && existingConnectedAccountId) {
      try {
        const account = await verifyConnectedAccount(client, userId, existingConnectedAccountId);
        return account.id;
      } catch (error) {
        console.log(chalk.yellow(error instanceof Error ? error.message : String(error)));
        continue;
      }
    }

    if (choice === "choose-active") {
      const account = await promptChooseSlackConnectedAccount(
        clack,
        await listActiveSlackAccounts(client, userId),
      );
      if (account !== "back") return account.id;
      continue;
    }

    if (choice === "create-link") {
      while (true) {
        const connection = await createConnectionRequest(client, userId, parseWaitMs(opts.waitMs));
        if (connection.account) return connection.account.id;
        const next = await promptAfterSlackConnectLink(
          clack,
          client,
          userId,
          existingConnectedAccountId,
        );
        if (next === "retry-link") continue;
        if (next !== "back") return next;
        break;
      }
      continue;
    }

    if (choice === "enter-id") {
      const accountId = await promptManualSlackConnectedAccountId(
        clack,
        client,
        userId,
        existingConnectedAccountId,
      );
      if (accountId !== "back") return accountId;
    }
  }
}

async function promptInteractiveSlackChannel(
  clack: ClackPrompts,
  opts: ComposioSetupOptions,
  existing: Record<string, unknown>,
): Promise<string | undefined | "back"> {
  const existingChannel =
    stringValue(opts.channel) ??
    stringValue(existing["channelName"]) ??
    stringValue(existing["channelId"]);
  printComposioSlackChannelInfo();

  while (true) {
    const choice = await clack.select({
      message: `Slack channel: ${existingChannel ?? "not set"}`,
      options: [
        {
          value: "use-current",
          label: existingChannel ? `Use ${existingChannel}` : "Leave unset",
          hint: existingChannel ? "Keep current Slack target override" : "Do not pass channel",
        },
        {
          value: "change",
          label: "Set channel",
          hint: "Channel name without #, or a Slack channel id",
        },
        ...(existingChannel
          ? [{ value: "clear", label: "Clear channel", hint: "Do not pass channel" }]
          : []),
        { value: "back", label: "Back", hint: "Return to Slack account" },
        { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
      ],
    });

    if (clack.isCancel(choice) || choice === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (choice === "back") return "back";
    if (choice === "use-current") return existingChannel;
    if (choice === "clear") return undefined;
    if (choice === "change") {
      const channel = await clack.text({
        message: "Slack channel name or id:",
        placeholder: "iamasx",
        initialValue: existingChannel,
      });
      if (clack.isCancel(channel)) {
        cancelInteractiveComposioSetup(clack);
      }
      return stringValue(channel);
    }
  }
}

async function promptInteractiveComposioSlackReview(
  clack: ClackPrompts,
  resolved: ResolvedComposioSetup,
  apiKeySource: string,
): Promise<"write" | "channel" | "account" | "routing" | "app" | "cancel"> {
  printComposioSlackReview(resolved, apiKeySource);
  const choice = await clack.select({
    message: "Write this Composio Slack config?",
    options: [
      { value: "write", label: "Write config", hint: "Update agent-orchestrator.yaml" },
      { value: "channel", label: "Change channel", hint: "Return to channel step" },
      { value: "account", label: "Change Slack account", hint: "Return to account step" },
      { value: "routing", label: "Change routing", hint: "Choose notification priorities" },
      { value: "app", label: "Back to app choices", hint: "Choose another Composio app" },
      { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
    ],
  });

  if (clack.isCancel(choice) || choice === "cancel") {
    cancelInteractiveComposioSetup(clack);
  }
  return choice as "write" | "channel" | "account" | "routing" | "app" | "cancel";
}

async function promptDiscordWebhookUrlInput(
  clack: ClackPrompts,
  initialValue: string | undefined,
): Promise<string> {
  const webhookUrlInput = await clack.text({
    message: "Discord webhook URL:",
    placeholder: "https://discord.com/api/webhooks/...",
    initialValue,
    validate: (value) => {
      if (!String(value ?? "").trim()) return "Discord webhook URL is required.";
      try {
        parseDiscordWebhookUrl(String(value).trim());
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });

  if (clack.isCancel(webhookUrlInput)) {
    cancelInteractiveComposioSetup(clack);
  }

  return String(webhookUrlInput).trim();
}

async function promptAfterDiscordWebhookInstructions(
  clack: ClackPrompts,
  initialValue: string | undefined,
): Promise<string | "back"> {
  printDiscordWebhookInstructions();

  while (true) {
    const next = await clack.select({
      message: "After creating the Discord webhook, what do you want to do?",
      options: [
        { value: "enter-url", label: "Paste webhook URL", hint: "Continue setup" },
        {
          value: "show-steps",
          label: "Show steps again",
          hint: "Reprint the Discord app URL and steps",
        },
        { value: "back", label: "Back", hint: "Return to webhook URL options" },
        { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
      ],
    });

    if (clack.isCancel(next) || next === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (next === "back") return "back";
    if (next === "show-steps") {
      printDiscordWebhookInstructions();
      continue;
    }
    if (next === "enter-url") {
      return promptDiscordWebhookUrlInput(clack, initialValue);
    }
  }
}

async function promptInteractiveDiscordWebhookUrl(
  clack: ClackPrompts,
  existingWebhookUrl: string | undefined,
): Promise<string | "back"> {
  printComposioDiscordWebhookInfo();

  while (true) {
    const choice = await clack.select({
      message: `Discord webhook URL: ${redactDiscordWebhookUrl(existingWebhookUrl)}`,
      options: [
        ...(existingWebhookUrl
          ? [
              {
                value: "use-existing",
                label: "Use existing webhook URL",
                hint: redactDiscordWebhookUrl(existingWebhookUrl),
              },
            ]
          : []),
        {
          value: "enter-url",
          label: "Paste webhook URL",
          hint: "Use a Discord incoming webhook URL",
        },
        {
          value: "show-steps",
          label: "Show me how to create one",
          hint: "Print Discord webhook creation steps",
        },
        { value: "back", label: "Back", hint: "Return to userId" },
        { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
      ],
    });

    if (clack.isCancel(choice) || choice === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (choice === "back") return "back";
    if (choice === "use-existing" && existingWebhookUrl) return existingWebhookUrl;
    if (choice === "enter-url") {
      return promptDiscordWebhookUrlInput(clack, existingWebhookUrl);
    }
    if (choice === "show-steps") {
      const result = await promptAfterDiscordWebhookInstructions(clack, existingWebhookUrl);
      if (result !== "back") return result;
    }
  }
}

async function promptInteractiveComposioDiscordWebhookReview(
  clack: ClackPrompts,
  resolved: ResolvedDiscordSetup,
  apiKeySource: string,
): Promise<"write" | "webhook" | "account" | "routing" | "app" | "cancel"> {
  printComposioDiscordWebhookReview(resolved, apiKeySource);
  const choice = await clack.select({
    message: "Write this Composio Discord webhook config?",
    options: [
      { value: "write", label: "Write config", hint: "Update agent-orchestrator.yaml" },
      { value: "webhook", label: "Change webhook URL", hint: "Return to webhook URL step" },
      {
        value: "account",
        label: "Change connected account",
        hint: "Create, choose, or enter a Composio connected account",
      },
      { value: "routing", label: "Change routing", hint: "Choose notification priorities" },
      { value: "app", label: "Back to app choices", hint: "Choose another Composio app" },
      { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
    ],
  });

  if (clack.isCancel(choice) || choice === "cancel") {
    cancelInteractiveComposioSetup(clack);
  }
  return choice as "write" | "webhook" | "account" | "routing" | "app" | "cancel";
}

async function promptManualDiscordWebhookConnectedAccountId(
  clack: ClackPrompts,
  client: ComposioSetupClient,
  userId: string,
  initialValue: string | undefined,
): Promise<string | "back"> {
  const accountId = await clack.text({
    message: "Composio Discord webhook connectedAccountId:",
    placeholder: "ca_...",
    initialValue,
    validate: (value) => {
      if (!String(value ?? "").trim()) return "connectedAccountId is required.";
    },
  });

  if (clack.isCancel(accountId)) {
    cancelInteractiveComposioSetup(clack);
  }

  try {
    const account = await verifyConnectedAccountForToolkit(
      client,
      userId,
      String(accountId).trim(),
      DISCORD_TOOLKIT,
      "Discord webhook",
    );
    return account.id;
  } catch (error) {
    console.log(chalk.yellow(error instanceof Error ? error.message : String(error)));
    return "back";
  }
}

async function promptChooseDiscordWebhookConnectedAccount(
  clack: ClackPrompts,
  accounts: ConnectedAccount[],
): Promise<ConnectedAccount | "back"> {
  if (accounts.length === 0) {
    console.log(
      chalk.yellow(
        "No active Discord webhook connected accounts were found for this Composio userId.",
      ),
    );
    return "back";
  }

  const selected = await clack.select({
    message: "Select the Discord webhook connected account AO should use:",
    options: [
      ...accounts.map((account) => ({
        value: account.id,
        label: account.alias ? `${account.alias} (${account.id})` : account.id,
      })),
      { value: "back", label: "Back", hint: "Return to Discord webhook account options" },
      { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
    ],
  });

  if (clack.isCancel(selected) || selected === "cancel") {
    cancelInteractiveComposioSetup(clack);
  }
  if (selected === "back") return "back";
  return accounts.find((account) => account.id === selected) ?? "back";
}

async function promptInteractiveDiscordWebhookAccount(
  clack: ClackPrompts,
  client: ComposioSetupClient,
  userId: string,
  webhookUrl: string,
  existingConnectedAccountId: string | undefined,
): Promise<string | "back"> {
  while (true) {
    const choice = await clack.select({
      message: "How do you want to configure the Composio Discord webhook connected account?",
      options: [
        ...(existingConnectedAccountId
          ? [
              {
                value: "use-existing",
                label: "Use existing connected account",
                hint: existingConnectedAccountId,
              },
            ]
          : []),
        {
          value: "create-account",
          label: "Create from webhook URL",
          hint: "Store the webhook token in Composio for this userId",
        },
        {
          value: "choose-active",
          label: "Choose active Discord account",
          hint: "List discordbot accounts already connected in Composio",
        },
        {
          value: "enter-id",
          label: "Enter connectedAccountId",
          hint: "Use an existing ca_... value",
        },
        { value: "back", label: "Back", hint: "Return to webhook URL" },
        { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
      ],
    });

    if (clack.isCancel(choice) || choice === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (choice === "back") return "back";

    if (choice === "use-existing" && existingConnectedAccountId) {
      try {
        const account = await verifyConnectedAccountForToolkit(
          client,
          userId,
          existingConnectedAccountId,
          DISCORD_TOOLKIT,
          "Discord webhook",
        );
        return account.id;
      } catch (error) {
        console.log(chalk.yellow(error instanceof Error ? error.message : String(error)));
        continue;
      }
    }

    if (choice === "create-account") {
      return resolveDiscordWebhookConnectedAccountId(client, userId, webhookUrl);
    }

    if (choice === "choose-active") {
      const account = await promptChooseDiscordWebhookConnectedAccount(
        clack,
        await listActiveToolkitAccounts(client, userId, DISCORD_TOOLKIT),
      );
      if (account !== "back") return account.id;
      continue;
    }

    if (choice === "enter-id") {
      const accountId = await promptManualDiscordWebhookConnectedAccountId(
        clack,
        client,
        userId,
        existingConnectedAccountId,
      );
      if (accountId !== "back") return accountId;
    }
  }
}

function validateDiscordChannelIdInput(value: string): string | undefined {
  if (!value.trim()) return "Discord channel id is required.";
  if (!/^\d{8,}$/.test(value.trim())) return "Discord channel id must be numeric.";
}

async function promptDiscordBotChannelIdInput(
  clack: ClackPrompts,
  initialValue: string | undefined,
): Promise<string> {
  const channelIdInput = await clack.text({
    message: "Discord channel ID:",
    placeholder: "1234567890",
    initialValue,
    validate: (value) => validateDiscordChannelIdInput(String(value ?? "")),
  });

  if (clack.isCancel(channelIdInput)) {
    cancelInteractiveComposioSetup(clack);
  }

  return String(channelIdInput).trim();
}

async function promptAfterDiscordChannelIdInstructions(
  clack: ClackPrompts,
  initialValue: string | undefined,
): Promise<string | "back"> {
  printDiscordChannelIdInstructions();

  while (true) {
    const next = await clack.select({
      message: "After copying the Discord channel ID, what do you want to do?",
      options: [
        { value: "enter-id", label: "Paste channel ID", hint: "Continue setup" },
        {
          value: "show-steps",
          label: "Show steps again",
          hint: "Reprint the Developer Mode steps",
        },
        { value: "back", label: "Back", hint: "Return to channel options" },
        { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
      ],
    });

    if (clack.isCancel(next) || next === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (next === "back") return "back";
    if (next === "show-steps") {
      printDiscordChannelIdInstructions();
      continue;
    }
    if (next === "enter-id") {
      return promptDiscordBotChannelIdInput(clack, initialValue);
    }
  }
}

async function promptInteractiveDiscordBotChannel(
  clack: ClackPrompts,
  existingChannelId: string | undefined,
): Promise<string | "back"> {
  printComposioDiscordBotInfo();

  while (true) {
    const choice = await clack.select({
      message: `Discord channel ID: ${existingChannelId ?? "not configured"}`,
      options: [
        ...(existingChannelId
          ? [
              {
                value: "use-existing",
                label: "Use existing channel ID",
                hint: existingChannelId,
              },
            ]
          : []),
        { value: "enter-id", label: "Paste channel ID", hint: "Use a Discord channel id" },
        {
          value: "show-steps",
          label: "Show me how to find it",
          hint: "Print Developer Mode channel-id steps",
        },
        { value: "back", label: "Back", hint: "Return to userId" },
        { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
      ],
    });

    if (clack.isCancel(choice) || choice === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (choice === "back") return "back";
    if (choice === "use-existing" && existingChannelId) return existingChannelId;
    if (choice === "enter-id") return promptDiscordBotChannelIdInput(clack, existingChannelId);
    if (choice === "show-steps") {
      const result = await promptAfterDiscordChannelIdInstructions(clack, existingChannelId);
      if (result !== "back") return result;
    }
  }
}

async function promptManualDiscordBotConnectedAccountId(
  clack: ClackPrompts,
  client: ComposioSetupClient,
  userId: string,
  initialValue: string | undefined,
): Promise<string | "back"> {
  const accountId = await clack.text({
    message: "Composio Discord bot connectedAccountId:",
    placeholder: "ca_...",
    initialValue,
    validate: (value) => {
      if (!String(value ?? "").trim()) return "connectedAccountId is required.";
    },
  });

  if (clack.isCancel(accountId)) {
    cancelInteractiveComposioSetup(clack);
  }

  try {
    const account = await verifyConnectedAccountForToolkit(
      client,
      userId,
      String(accountId).trim(),
      DISCORD_TOOLKIT,
      "Discord Bot",
    );
    return account.id;
  } catch (error) {
    console.log(chalk.yellow(error instanceof Error ? error.message : String(error)));
    return "back";
  }
}

async function promptChooseDiscordBotConnectedAccount(
  clack: ClackPrompts,
  accounts: ConnectedAccount[],
): Promise<ConnectedAccount | "back"> {
  if (accounts.length === 0) {
    console.log(
      chalk.yellow("No active Discord bot connected accounts were found for this Composio userId."),
    );
    return "back";
  }

  const selected = await clack.select({
    message: "Select the Discord bot connected account AO should use:",
    options: [
      ...accounts.map((account) => ({
        value: account.id,
        label: account.alias ? `${account.alias} (${account.id})` : account.id,
      })),
      { value: "back", label: "Back", hint: "Return to Discord bot account options" },
      { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
    ],
  });

  if (clack.isCancel(selected) || selected === "cancel") {
    cancelInteractiveComposioSetup(clack);
  }
  if (selected === "back") return "back";
  return accounts.find((account) => account.id === selected) ?? "back";
}

async function promptDiscordBotTokenInput(
  clack: ClackPrompts,
  optionToken: string | undefined,
): Promise<string | "back"> {
  const envToken = stringValue(process.env.DISCORD_BOT_TOKEN);
  if (optionToken || envToken) {
    const choice = await clack.select({
      message: "Discord bot token:",
      options: [
        ...(optionToken
          ? [
              {
                value: "use-option",
                label: "Use provided bot token",
                hint: "Used once; not written to config",
              },
            ]
          : []),
        ...(envToken
          ? [
              {
                value: "use-env",
                label: "Use DISCORD_BOT_TOKEN",
                hint: "Use the current environment",
              },
            ]
          : []),
        { value: "paste", label: "Paste bot token", hint: "Used once; not written to config" },
        { value: "back", label: "Back", hint: "Return to account options" },
        { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
      ],
    });

    if (clack.isCancel(choice) || choice === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (choice === "back") return "back";
    if (choice === "use-option" && optionToken) return optionToken;
    if (choice === "use-env" && envToken) return envToken;
  }

  printDiscordBotInstructions();
  const token = await clack.password({
    message: "Discord bot token:",
    validate: (value) => {
      if (!String(value ?? "").trim()) return "Discord bot token is required.";
    },
  });

  if (clack.isCancel(token)) {
    cancelInteractiveComposioSetup(clack);
  }

  return String(token).trim();
}

async function promptInteractiveDiscordBotAccount(
  clack: ClackPrompts,
  client: ComposioSetupClient,
  userId: string,
  channelId: string,
  existingConnectedAccountId: string | undefined,
  optionToken: string | undefined,
): Promise<string | "back"> {
  while (true) {
    const choice = await clack.select({
      message: "How do you want to configure the Composio Discord bot account?",
      options: [
        ...(existingConnectedAccountId
          ? [
              {
                value: "use-existing",
                label: "Use existing connected account",
                hint: existingConnectedAccountId,
              },
            ]
          : []),
        {
          value: "choose-active",
          label: "Choose active Discord bot account",
          hint: "List active discordbot accounts for this userId",
        },
        {
          value: "enter-id",
          label: "Enter connectedAccountId",
          hint: "Use an existing ca_... value",
        },
        {
          value: "create-account",
          label: "Create from bot token",
          hint: "Validate channel access and store a Composio connected account",
        },
        { value: "back", label: "Back", hint: "Return to channel ID" },
        { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
      ],
    });

    if (clack.isCancel(choice) || choice === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (choice === "back") return "back";

    if (choice === "use-existing" && existingConnectedAccountId) {
      try {
        const account = await verifyConnectedAccountForToolkit(
          client,
          userId,
          existingConnectedAccountId,
          DISCORD_TOOLKIT,
          "Discord Bot",
        );
        return account.id;
      } catch (error) {
        console.log(chalk.yellow(error instanceof Error ? error.message : String(error)));
      }
      continue;
    }

    if (choice === "choose-active") {
      const account = await promptChooseDiscordBotConnectedAccount(
        clack,
        await listActiveToolkitAccounts(client, userId, DISCORD_TOOLKIT),
      );
      if (account !== "back") return account.id;
      continue;
    }

    if (choice === "enter-id") {
      const accountId = await promptManualDiscordBotConnectedAccountId(
        clack,
        client,
        userId,
        existingConnectedAccountId,
      );
      if (accountId !== "back") return accountId;
      continue;
    }

    if (choice === "create-account") {
      const token = await promptDiscordBotTokenInput(clack, optionToken);
      if (token === "back") continue;
      try {
        await validateDiscordBotChannelAccess(token, channelId);
        return await createDiscordBearerConnectedAccount(
          client,
          userId,
          token,
          "Discord Bot Auth Config",
        );
      } catch (error) {
        console.log(chalk.yellow(error instanceof Error ? error.message : String(error)));
      }
    }
  }
}

async function promptInteractiveComposioDiscordBotReview(
  clack: ClackPrompts,
  resolved: ResolvedDiscordSetup,
  apiKeySource: string,
): Promise<"write" | "channel" | "account" | "routing" | "app" | "cancel"> {
  printComposioDiscordBotReview(resolved, apiKeySource);
  const choice = await clack.select({
    message: "Write this Composio Discord bot config?",
    options: [
      { value: "write", label: "Write config", hint: "Update agent-orchestrator.yaml" },
      { value: "channel", label: "Change channel ID", hint: "Return to channel step" },
      { value: "account", label: "Change bot account", hint: "Return to account step" },
      { value: "routing", label: "Change routing", hint: "Choose notification priorities" },
      { value: "app", label: "Back to app choices", hint: "Choose another Composio app" },
      { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
    ],
  });

  if (clack.isCancel(choice) || choice === "cancel") {
    cancelInteractiveComposioSetup(clack);
  }
  return choice as "write" | "channel" | "account" | "routing" | "app" | "cancel";
}

function validateEmailInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Recipient email is required.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "Enter a valid email address.";
}

async function promptGmailEmailInput(
  clack: ClackPrompts,
  initialValue: string | undefined,
): Promise<string> {
  const email = await clack.text({
    message: "Recipient email:",
    placeholder: "alerts@example.com",
    initialValue,
    validate: (value) => validateEmailInput(String(value ?? "")),
  });

  if (clack.isCancel(email)) {
    cancelInteractiveComposioSetup(clack);
  }

  return String(email).trim();
}

async function promptInteractiveGmailEmail(
  clack: ClackPrompts,
  existingEmailTo: string | undefined,
): Promise<string | "back"> {
  printComposioGmailInfo();

  while (true) {
    const choice = await clack.select({
      message: `Gmail recipient email: ${existingEmailTo ?? "not configured"}`,
      options: [
        ...(existingEmailTo
          ? [
              {
                value: "use-existing",
                label: "Use existing recipient",
                hint: existingEmailTo,
              },
            ]
          : []),
        {
          value: "enter-email",
          label: "Enter recipient email",
          hint: "AO sends notification emails to this address",
        },
        { value: "back", label: "Back", hint: "Return to userId" },
        { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
      ],
    });

    if (clack.isCancel(choice) || choice === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (choice === "back") return "back";
    if (choice === "use-existing" && existingEmailTo) return existingEmailTo;
    if (choice === "enter-email") return promptGmailEmailInput(clack, existingEmailTo);
  }
}

async function verifyUsableGmailConnectedAccount(
  client: ComposioSetupClient,
  userId: string,
  connectedAccountId: string,
): Promise<ConnectedAccount> {
  const account = await withConnectedAccountDetails(
    client,
    await verifyConnectedAccountForToolkit(
      client,
      userId,
      connectedAccountId,
      GMAIL_TOOLKIT,
      "Gmail",
      () => listActiveGmailAccounts(client, userId),
    ),
  );
  if (!(await accountCanSendGmail(client, account))) {
    throw new ComposioSetupError(
      `Connected account ${connectedAccountId} is missing Gmail send/profile access. Reconnect Gmail in Composio with send access, or use a different Gmail connected account.`,
    );
  }
  return account;
}

async function promptManualGmailConnectedAccountId(
  clack: ClackPrompts,
  client: ComposioSetupClient,
  userId: string,
  initialValue: string | undefined,
): Promise<string | "back"> {
  const accountId = await clack.text({
    message: "Composio Gmail connectedAccountId:",
    placeholder: "ca_...",
    initialValue,
    validate: (value) => {
      if (!String(value ?? "").trim()) return "connectedAccountId is required.";
    },
  });

  if (clack.isCancel(accountId)) {
    cancelInteractiveComposioSetup(clack);
  }

  try {
    const account = await verifyUsableGmailConnectedAccount(
      client,
      userId,
      String(accountId).trim(),
    );
    return account.id;
  } catch (error) {
    console.log(chalk.yellow(error instanceof Error ? error.message : String(error)));
    return "back";
  }
}

async function promptChooseGmailConnectedAccount(
  clack: ClackPrompts,
  accounts: ConnectedAccount[],
): Promise<ConnectedAccount | "back"> {
  if (accounts.length === 0) {
    console.log(
      chalk.yellow(
        "No active Gmail connected accounts with send/profile access were found for this Composio userId.",
      ),
    );
    return "back";
  }

  const selected = await clack.select({
    message: "Select the Gmail connected account AO should use:",
    options: [
      ...accounts.map((account) => ({
        value: account.id,
        label: account.alias ? `${account.alias} (${account.id})` : account.id,
      })),
      { value: "back", label: "Back", hint: "Return to Gmail account options" },
      { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
    ],
  });

  if (clack.isCancel(selected) || selected === "cancel") {
    cancelInteractiveComposioSetup(clack);
  }
  if (selected === "back") return "back";
  return accounts.find((account) => account.id === selected) ?? "back";
}

async function promptManualGmailAuthConfigId(
  clack: ClackPrompts,
  client: ComposioSetupClient,
  initialValue: string | undefined,
): Promise<string | "back"> {
  const authConfigId = await clack.text({
    message: "Composio Gmail authConfigId:",
    placeholder: "ac_...",
    initialValue,
    validate: (value) => {
      if (!String(value ?? "").trim()) return "authConfigId is required.";
    },
  });

  if (clack.isCancel(authConfigId)) {
    cancelInteractiveComposioSetup(clack);
  }

  const id = String(authConfigId).trim();
  const config = await getAuthConfig(client, id);
  if (config?.toolkit?.slug && config.toolkit.slug.toLowerCase() !== GMAIL_TOOLKIT) {
    console.log(chalk.yellow(`Auth config ${id} is not a Gmail config.`));
    return "back";
  }
  if (config && !authConfigAllowsGmailSend(config)) {
    console.log(
      chalk.yellow(
        `Auth config ${id} does not explicitly list ${GMAIL_SEND_TOOL}; AO will create the connect link anyway.`,
      ),
    );
  }
  return id;
}

async function listGmailAuthConfigs(client: ComposioSetupClient): Promise<AuthConfigSummary[]> {
  if (!client.authConfigs?.list) {
    throw new ComposioSetupError(
      "Composio SDK client does not expose authConfigs.list(); enter a Gmail authConfigId manually.",
    );
  }
  return authConfigsFromListResult(
    await client.authConfigs.list({ toolkit: GMAIL_TOOLKIT }),
  ).filter(
    (config) => !config.toolkit?.slug || config.toolkit.slug.toLowerCase() === GMAIL_TOOLKIT,
  );
}

async function promptChooseGmailAuthConfig(
  clack: ClackPrompts,
  configs: AuthConfigSummary[],
): Promise<AuthConfigSummary | "back"> {
  if (configs.length === 0) {
    console.log(
      chalk.yellow(
        "No Composio Gmail auth configs were found. Create one in Composio or enter authConfigId manually.",
      ),
    );
    return "back";
  }

  const sendConfigs = configs.filter(authConfigAllowsGmailSend);
  const candidates = sendConfigs.length > 0 ? sendConfigs : configs;
  if (sendConfigs.length === 0) {
    console.log(
      chalk.yellow(
        `No Gmail auth config explicitly lists ${GMAIL_SEND_TOOL}; showing existing Gmail auth configs anyway.`,
      ),
    );
  }

  const selected = await clack.select({
    message: "Select the Gmail auth config for the Composio connect link:",
    options: [
      ...candidates.map((config) => ({
        value: config.id,
        label: config.id,
        hint: authConfigAllowsGmailSend(config) ? GMAIL_SEND_TOOL : "Gmail auth config",
      })),
      { value: "back", label: "Back", hint: "Return to Gmail account options" },
      { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
    ],
  });

  if (clack.isCancel(selected) || selected === "cancel") {
    cancelInteractiveComposioSetup(clack);
  }
  if (selected === "back") return "back";
  return candidates.find((config) => config.id === selected) ?? "back";
}

async function promptInteractiveGmailAuthConfig(
  clack: ClackPrompts,
  client: ComposioSetupClient,
  existingAuthConfigId: string | undefined,
): Promise<string | "back"> {
  printComposioGmailConnectInfo();

  while (true) {
    const choice = await clack.select({
      message: "How should AO choose the Gmail auth config for the connect link?",
      options: [
        ...(existingAuthConfigId
          ? [
              {
                value: "use-existing",
                label: "Use existing authConfigId",
                hint: existingAuthConfigId,
              },
            ]
          : []),
        {
          value: "choose-existing",
          label: "Choose existing Gmail auth config",
          hint: "List Gmail auth configs in Composio",
        },
        {
          value: "enter-id",
          label: "Enter authConfigId",
          hint: "Use an existing ac_... value",
        },
        { value: "back", label: "Back", hint: "Return to Gmail account options" },
        { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
      ],
    });

    if (clack.isCancel(choice) || choice === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (choice === "back") return "back";
    if (choice === "use-existing" && existingAuthConfigId) return existingAuthConfigId;

    if (choice === "enter-id") {
      const id = await promptManualGmailAuthConfigId(clack, client, existingAuthConfigId);
      if (id !== "back") return id;
      continue;
    }

    if (choice === "choose-existing") {
      try {
        const config = await promptChooseGmailAuthConfig(clack, await listGmailAuthConfigs(client));
        if (config !== "back") return config.id;
      } catch (error) {
        console.log(chalk.yellow(error instanceof Error ? error.message : String(error)));
      }
    }
  }
}

async function promptAfterGmailConnectLink(
  clack: ClackPrompts,
  client: ComposioSetupClient,
  userId: string,
  existingConnectedAccountId: string | undefined,
): Promise<string | "back" | "retry-link" | "change-auth-config"> {
  console.log(
    chalk.yellow(
      "Gmail connection did not complete yet. Open the connect URL above and finish the Composio flow.",
    ),
  );

  while (true) {
    const next = await clack.select({
      message: "After opening the Composio Gmail connect link, what do you want to do?",
      options: [
        {
          value: "check-active",
          label: "I completed the connection",
          hint: "Check Composio for usable Gmail accounts",
        },
        {
          value: "retry-link",
          label: "Generate link again",
          hint: "Use the same Gmail auth config",
        },
        {
          value: "change-auth-config",
          label: "Change authConfigId",
          hint: "Use a different Gmail auth config",
        },
        {
          value: "enter-id",
          label: "Enter connectedAccountId",
          hint: "Use an existing ca_... value",
        },
        {
          value: "back",
          label: "Back",
          hint: "Return to Gmail account options",
        },
        {
          value: "cancel",
          label: "Cancel setup",
          hint: "Do not change config",
        },
      ],
    });

    if (clack.isCancel(next) || next === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (next === "back") return "back";
    if (next === "retry-link") return "retry-link";
    if (next === "change-auth-config") return "change-auth-config";

    if (next === "enter-id") {
      const accountId = await promptManualGmailConnectedAccountId(
        clack,
        client,
        userId,
        existingConnectedAccountId,
      );
      if (accountId !== "back") return accountId;
      continue;
    }

    if (next === "check-active") {
      const account = await promptChooseGmailConnectedAccount(
        clack,
        await listUsableGmailAccounts(client, userId),
      );
      if (account !== "back") return account.id;
    }
  }
}

async function promptInteractiveGmailAccount(
  clack: ClackPrompts,
  client: ComposioSetupClient,
  userId: string,
  opts: ComposioSetupOptions,
  existingConnectedAccountId: string | undefined,
  existingAuthConfigId: string | undefined,
): Promise<string | "back"> {
  let authConfigId = existingAuthConfigId;

  while (true) {
    const choice = await clack.select({
      message: "How do you want to choose the Gmail connected account?",
      options: [
        ...(existingConnectedAccountId
          ? [
              {
                value: "use-existing",
                label: "Use existing connected account",
                hint: existingConnectedAccountId,
              },
            ]
          : []),
        {
          value: "choose-active",
          label: "Choose active Gmail account",
          hint: "List accounts already connected in Composio",
        },
        {
          value: "create-link",
          label: "Generate Gmail connect link",
          hint: "Use an existing Composio Gmail auth config",
        },
        {
          value: "enter-id",
          label: "Enter connectedAccountId",
          hint: "Use an existing ca_... value",
        },
        { value: "back", label: "Back", hint: "Return to recipient email" },
        { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
      ],
    });

    if (clack.isCancel(choice) || choice === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }
    if (choice === "back") return "back";

    if (choice === "use-existing" && existingConnectedAccountId) {
      try {
        const account = await verifyUsableGmailConnectedAccount(
          client,
          userId,
          existingConnectedAccountId,
        );
        return account.id;
      } catch (error) {
        console.log(chalk.yellow(error instanceof Error ? error.message : String(error)));
      }
      continue;
    }

    if (choice === "choose-active") {
      const account = await promptChooseGmailConnectedAccount(
        clack,
        await listUsableGmailAccounts(client, userId),
      );
      if (account !== "back") return account.id;
      continue;
    }

    if (choice === "enter-id") {
      const accountId = await promptManualGmailConnectedAccountId(
        clack,
        client,
        userId,
        existingConnectedAccountId,
      );
      if (accountId !== "back") return accountId;
      continue;
    }

    if (choice === "create-link") {
      while (true) {
        if (!authConfigId) {
          const selectedAuthConfigId = await promptInteractiveGmailAuthConfig(
            clack,
            client,
            authConfigId,
          );
          if (selectedAuthConfigId === "back") break;
          authConfigId = selectedAuthConfigId;
        }

        const connection = await createManagedOAuthConnectionRequest(
          client,
          userId,
          GMAIL_TOOLKIT,
          "Gmail",
          "Gmail Auth Config",
          parseWaitMs(opts.waitMs),
          { authConfigId },
        );

        if (connection.account) {
          try {
            const account = await withConnectedAccountDetails(client, connection.account);
            if (await accountCanSendGmail(client, account)) return account.id;
            console.log(
              chalk.yellow(
                `Connected Gmail account ${account.id} is missing Gmail send/profile access.`,
              ),
            );
          } catch (error) {
            console.log(chalk.yellow(error instanceof Error ? error.message : String(error)));
          }
        }

        const next = await promptAfterGmailConnectLink(
          clack,
          client,
          userId,
          existingConnectedAccountId,
        );
        if (next === "retry-link") continue;
        if (next === "change-auth-config") {
          authConfigId = undefined;
          continue;
        }
        if (next !== "back") return next;
        break;
      }
    }
  }
}

async function promptInteractiveComposioGmailReview(
  clack: ClackPrompts,
  resolved: ResolvedMailSetup,
  apiKeySource: string,
): Promise<"write" | "email" | "account" | "routing" | "app" | "cancel"> {
  printComposioGmailReview(resolved, apiKeySource);
  const choice = await clack.select({
    message: "Write this Composio Gmail config?",
    options: [
      { value: "write", label: "Write config", hint: "Update agent-orchestrator.yaml" },
      { value: "email", label: "Change recipient email", hint: "Return to email step" },
      { value: "account", label: "Change Gmail account", hint: "Return to account step" },
      { value: "routing", label: "Change routing", hint: "Choose notification priorities" },
      { value: "app", label: "Back to app choices", hint: "Choose another Composio app" },
      { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
    ],
  });

  if (clack.isCancel(choice) || choice === "cancel") {
    cancelInteractiveComposioSetup(clack);
  }
  return choice as "write" | "email" | "account" | "routing" | "app" | "cancel";
}

async function confirmComposioSlackConflict(
  clack: ClackPrompts,
  targetName: string,
  existingPlugin: string | undefined,
  force: boolean | undefined,
): Promise<boolean> {
  if (!existingPlugin || existingPlugin === "composio" || force) return true;
  const replace = await clack.confirm({
    message: `notifiers.${targetName} already uses plugin "${existingPlugin}". Replace it with Composio Slack?`,
    initialValue: false,
  });

  if (clack.isCancel(replace)) {
    cancelInteractiveComposioSetup(clack);
  }
  if (!replace) {
    console.log(chalk.dim(`Keeping existing notifiers.${targetName} config.`));
    return false;
  }
  return true;
}

async function confirmComposioDiscordWebhookConflict(
  clack: ClackPrompts,
  targetName: string,
  existingPlugin: string | undefined,
  force: boolean | undefined,
  label = "Composio Discord webhook",
): Promise<boolean> {
  if (!existingPlugin || existingPlugin === "composio" || force) return true;
  const replace = await clack.confirm({
    message: `notifiers.${targetName} already uses plugin "${existingPlugin}". Replace it with ${label}?`,
    initialValue: false,
  });

  if (clack.isCancel(replace)) {
    cancelInteractiveComposioSetup(clack);
  }
  if (!replace) {
    console.log(chalk.dim(`Keeping existing notifiers.${targetName} config.`));
    return false;
  }
  return true;
}

async function runInteractiveComposioSlackSetup(
  clack: ClackPrompts,
  opts: ComposioSetupOptions,
  configPath: string,
  rawConfig: Record<string, unknown>,
  targetName = COMPOSIO_NOTIFIER,
): Promise<"back" | "done"> {
  const existing = getExistingNotifierConfig(rawConfig, targetName);
  const existingPlugin = stringValue(existing["plugin"]);
  const canReplace = await confirmComposioSlackConflict(
    clack,
    targetName,
    existingPlugin,
    opts.force,
  );
  if (!canReplace) return "back";

  const optionRoutingPreset = resolveComposioRoutingPreset(opts.routingPreset);
  let step: "api-key" | "user-id" | "account" | "channel" | "routing" | "review" = "api-key";
  let apiKey: ResolvedApiKey | undefined;
  let userId: string | undefined;
  let client: ComposioSetupClient | undefined;
  let connectedAccountId: string | undefined;
  let channel: string | undefined;
  let routingPreset: NotifierRoutingPreset | undefined;

  while (true) {
    if (step === "api-key") {
      const result = await promptInteractiveComposioApiKey(clack, opts, existing);
      if (result === "back") return "back";
      apiKey = result;
      client = await loadComposioClient(apiKey.apiKey);
      step = "user-id";
      continue;
    }

    if (step === "user-id") {
      const result = await promptInteractiveComposioUserId(clack, opts, existing);
      if (result === "back") {
        step = "api-key";
        continue;
      }
      userId = result;
      step = "account";
      continue;
    }

    if (step === "account") {
      if (!client || !userId) {
        step = "api-key";
        continue;
      }
      const result = await promptInteractiveSlackAccount(clack, client, userId, opts, existing);
      if (result === "back") {
        step = "user-id";
        continue;
      }
      connectedAccountId = result;
      step = "channel";
      continue;
    }

    if (step === "channel") {
      const result = await promptInteractiveSlackChannel(clack, opts, existing);
      if (result === "back") {
        step = "account";
        continue;
      }
      channel = result;
      step = "routing";
      continue;
    }

    if (step === "routing") {
      const selection =
        optionRoutingPreset ??
        (await promptNotifierRoutingPreset(clack, rawConfig, targetName, "Composio Slack", () =>
          cancelInteractiveComposioSetup(clack),
        ));
      if (selection === "back") {
        step = "channel";
        continue;
      }
      routingPreset = selection === "preserve" ? undefined : selection;
      step = "review";
      continue;
    }

    if (!apiKey || !userId || !connectedAccountId) {
      step = "api-key";
      continue;
    }

    const resolved: ResolvedComposioSetup = {
      apiKey: apiKey.apiKey,
      shouldWriteApiKey: apiKey.shouldWriteApiKey,
      userId,
      targetName,
      channel,
      connectedAccountId,
      routingPreset,
    };
    const reviewChoice = await promptInteractiveComposioSlackReview(
      clack,
      resolved,
      apiKey.sourceLabel,
    );
    if (reviewChoice === "channel") {
      step = "channel";
      continue;
    }
    if (reviewChoice === "account") {
      step = "account";
      continue;
    }
    if (reviewChoice === "routing") {
      step = "routing";
      continue;
    }
    if (reviewChoice === "app") {
      return "back";
    }

    writeComposioConfig(configPath, resolved);
    console.log(chalk.green(`✓ Config written to ${configPath}`));
    console.log(chalk.green(`✓ Slack connected account: ${connectedAccountId}`));
    console.log(chalk.dim(`Test it with: ao notify test --to ${targetName} --template ci-failing`));
    clack.outro("Composio Slack setup complete.");
    return "done";
  }
}

async function runInteractiveComposioDiscordWebhookSetup(
  clack: ClackPrompts,
  opts: ComposioSetupOptions,
  configPath: string,
  rawConfig: Record<string, unknown>,
  targetName = COMPOSIO_NOTIFIER,
): Promise<"back" | "done"> {
  const existing = getExistingNotifierConfig(rawConfig, targetName);
  const existingPlugin = stringValue(existing["plugin"]);
  const existingWebhookUrl =
    stringValue(opts.webhookUrl) ??
    stringValue(existing["webhookUrl"]) ??
    stringValue(process.env.DISCORD_WEBHOOK_URL);
  const explicitConnectedAccountId = stringValue(opts.connectedAccountId);
  const existingConnectedAccountId = stringValue(existing["connectedAccountId"]);
  const canReplace = await confirmComposioDiscordWebhookConflict(
    clack,
    targetName,
    existingPlugin,
    opts.force,
  );
  if (!canReplace) return "back";

  const optionRoutingPreset = resolveComposioRoutingPreset(opts.routingPreset);
  let step: "api-key" | "user-id" | "webhook" | "account" | "routing" | "review" = "api-key";
  let apiKey: ResolvedApiKey | undefined;
  let userId: string | undefined;
  let webhookUrl: string | undefined;
  let connectedAccountId: string | undefined;
  let routingPreset: NotifierRoutingPreset | undefined;
  let setupClient: ComposioSetupClient | undefined;

  while (true) {
    if (step === "api-key") {
      const result = await promptInteractiveComposioApiKey(clack, opts, existing);
      if (result === "back") return "back";
      apiKey = result;
      step = "user-id";
      continue;
    }

    if (step === "user-id") {
      const result = await promptInteractiveComposioUserId(clack, opts, existing);
      if (result === "back") {
        step = "api-key";
        continue;
      }
      userId = result;
      step = "webhook";
      continue;
    }

    if (step === "webhook") {
      const result = await promptInteractiveDiscordWebhookUrl(
        clack,
        webhookUrl ?? existingWebhookUrl,
      );
      if (result === "back") {
        step = "user-id";
        continue;
      }
      webhookUrl = result;
      connectedAccountId = explicitConnectedAccountId;
      step = "account";
      continue;
    }

    if (step === "account") {
      if (!apiKey || !userId || !webhookUrl) {
        step = "api-key";
        continue;
      }

      setupClient ??= await loadComposioClient(apiKey.apiKey);
      const result = await promptInteractiveDiscordWebhookAccount(
        clack,
        setupClient,
        userId,
        webhookUrl,
        connectedAccountId ?? explicitConnectedAccountId ?? existingConnectedAccountId,
      );
      if (result === "back") {
        step = "webhook";
        continue;
      }
      connectedAccountId = result;
      step = "routing";
      continue;
    }

    if (step === "routing") {
      const selection =
        optionRoutingPreset ??
        (await promptNotifierRoutingPreset(
          clack,
          rawConfig,
          targetName,
          "Composio Discord webhook",
          () => cancelInteractiveComposioSetup(clack),
        ));
      if (selection === "back") {
        step = "webhook";
        continue;
      }
      routingPreset = selection === "preserve" ? undefined : selection;
      step = "review";
      continue;
    }

    if (!apiKey || !userId || !webhookUrl) {
      step = "api-key";
      continue;
    }
    if (!connectedAccountId) {
      step = "account";
      continue;
    }

    const resolved: ResolvedDiscordSetup = {
      apiKey: apiKey.apiKey,
      shouldWriteApiKey: apiKey.shouldWriteApiKey,
      userId,
      mode: "webhook",
      targetName,
      webhookUrl,
      connectedAccountId,
      routingPreset,
    };
    const reviewChoice = await promptInteractiveComposioDiscordWebhookReview(
      clack,
      resolved,
      apiKey.sourceLabel,
    );
    if (reviewChoice === "webhook") {
      step = "webhook";
      continue;
    }
    if (reviewChoice === "account") {
      step = "account";
      continue;
    }
    if (reviewChoice === "routing") {
      step = "routing";
      continue;
    }
    if (reviewChoice === "app") {
      return "back";
    }

    writeComposioDiscordConfig(configPath, resolved);
    console.log(chalk.green(`✓ Config written to ${configPath}`));
    console.log(chalk.green("✓ Discord webhook configured through Composio"));
    console.log(chalk.green(`✓ Discord webhook connected account: ${resolved.connectedAccountId}`));
    console.log(chalk.dim(`Test it with: ao notify test --to ${targetName} --template basic`));
    clack.outro("Composio Discord webhook setup complete.");
    return "done";
  }
}

async function runInteractiveComposioDiscordBotSetup(
  clack: ClackPrompts,
  opts: ComposioSetupOptions,
  configPath: string,
  rawConfig: Record<string, unknown>,
  targetName = COMPOSIO_NOTIFIER,
): Promise<"back" | "done"> {
  const existing = getExistingNotifierConfig(rawConfig, targetName);
  const existingPlugin = stringValue(existing["plugin"]);
  const existingIsBot =
    stringValue(existing["defaultApp"]) === "discord" && stringValue(existing["mode"]) === "bot";
  const existingChannelId =
    stringValue(opts.channelId) ?? (existingIsBot ? stringValue(existing["channelId"]) : undefined);
  const existingConnectedAccountId = existingIsBot
    ? (stringValue(opts.connectedAccountId) ?? stringValue(existing["connectedAccountId"]))
    : stringValue(opts.connectedAccountId);
  const optionBotToken = stringValue(opts.botToken);
  const canReplace = await confirmComposioDiscordWebhookConflict(
    clack,
    targetName,
    existingPlugin,
    opts.force,
    "Composio Discord bot",
  );
  if (!canReplace) return "back";

  const optionRoutingPreset = resolveComposioRoutingPreset(opts.routingPreset);
  let step: "api-key" | "user-id" | "channel" | "account" | "routing" | "review" = "api-key";
  let apiKey: ResolvedApiKey | undefined;
  let userId: string | undefined;
  let client: ComposioSetupClient | undefined;
  let channelId: string | undefined;
  let connectedAccountId: string | undefined;
  let routingPreset: NotifierRoutingPreset | undefined;

  while (true) {
    if (step === "api-key") {
      const result = await promptInteractiveComposioApiKey(clack, opts, existing);
      if (result === "back") return "back";
      apiKey = result;
      client = await loadComposioClient(apiKey.apiKey);
      step = "user-id";
      continue;
    }

    if (step === "user-id") {
      const result = await promptInteractiveComposioUserId(clack, opts, existing);
      if (result === "back") {
        step = "api-key";
        continue;
      }
      userId = result;
      step = "channel";
      continue;
    }

    if (step === "channel") {
      const result = await promptInteractiveDiscordBotChannel(
        clack,
        channelId ?? existingChannelId,
      );
      if (result === "back") {
        step = "user-id";
        continue;
      }
      if (result !== existingChannelId || (channelId && channelId !== result)) {
        connectedAccountId = undefined;
      }
      channelId = result;
      step = "account";
      continue;
    }

    if (step === "account") {
      if (!client || !userId || !channelId) {
        step = "api-key";
        continue;
      }
      const result = await promptInteractiveDiscordBotAccount(
        clack,
        client,
        userId,
        channelId,
        connectedAccountId ??
          (channelId === existingChannelId ? existingConnectedAccountId : undefined),
        optionBotToken,
      );
      if (result === "back") {
        step = "channel";
        continue;
      }
      connectedAccountId = result;
      step = "routing";
      continue;
    }

    if (step === "routing") {
      const selection =
        optionRoutingPreset ??
        (await promptNotifierRoutingPreset(
          clack,
          rawConfig,
          targetName,
          "Composio Discord bot",
          () => cancelInteractiveComposioSetup(clack),
        ));
      if (selection === "back") {
        step = "account";
        continue;
      }
      routingPreset = selection === "preserve" ? undefined : selection;
      step = "review";
      continue;
    }

    if (!apiKey || !userId || !channelId || !connectedAccountId) {
      step = "api-key";
      continue;
    }

    const resolved: ResolvedDiscordSetup = {
      apiKey: apiKey.apiKey,
      shouldWriteApiKey: apiKey.shouldWriteApiKey,
      userId,
      mode: "bot",
      targetName,
      channelId,
      connectedAccountId,
      routingPreset,
    };
    const reviewChoice = await promptInteractiveComposioDiscordBotReview(
      clack,
      resolved,
      apiKey.sourceLabel,
    );
    if (reviewChoice === "channel") {
      step = "channel";
      continue;
    }
    if (reviewChoice === "account") {
      step = "account";
      continue;
    }
    if (reviewChoice === "routing") {
      step = "routing";
      continue;
    }
    if (reviewChoice === "app") {
      return "back";
    }

    writeComposioDiscordConfig(configPath, resolved);
    console.log(chalk.green(`✓ Config written to ${configPath}`));
    console.log(chalk.green(`✓ Discord bot connected account: ${connectedAccountId}`));
    console.log(chalk.dim(`Test it with: ao notify test --to ${targetName} --template basic`));
    clack.outro("Composio Discord bot setup complete.");
    return "done";
  }
}

async function runInteractiveComposioGmailSetup(
  clack: ClackPrompts,
  opts: ComposioSetupOptions,
  configPath: string,
  rawConfig: Record<string, unknown>,
  targetName = COMPOSIO_NOTIFIER,
): Promise<"back" | "done"> {
  const existing = getExistingNotifierConfig(rawConfig, targetName);
  const existingPlugin = stringValue(existing["plugin"]);
  const existingIsGmail = stringValue(existing["defaultApp"]) === "gmail";
  const existingEmailTo =
    stringValue(opts.emailTo) ?? (existingIsGmail ? stringValue(existing["emailTo"]) : undefined);
  const existingConnectedAccountId = existingIsGmail
    ? (stringValue(opts.connectedAccountId) ?? stringValue(existing["connectedAccountId"]))
    : stringValue(opts.connectedAccountId);
  const existingAuthConfigId =
    stringValue(opts.authConfigId) ??
    (existingIsGmail ? stringValue(existing["authConfigId"]) : undefined);
  const canReplace = await confirmComposioDiscordWebhookConflict(
    clack,
    targetName,
    existingPlugin,
    opts.force,
    "Composio Gmail",
  );
  if (!canReplace) return "back";

  const optionRoutingPreset = resolveComposioRoutingPreset(opts.routingPreset);
  let step: "api-key" | "user-id" | "email" | "account" | "routing" | "review" = "api-key";
  let apiKey: ResolvedApiKey | undefined;
  let userId: string | undefined;
  let client: ComposioSetupClient | undefined;
  let emailTo: string | undefined;
  let connectedAccountId: string | undefined;
  let routingPreset: NotifierRoutingPreset | undefined;

  while (true) {
    if (step === "api-key") {
      const result = await promptInteractiveComposioApiKey(clack, opts, existing);
      if (result === "back") return "back";
      apiKey = result;
      client = await loadComposioClient(apiKey.apiKey);
      step = "user-id";
      continue;
    }

    if (step === "user-id") {
      const result = await promptInteractiveComposioUserId(clack, opts, existing);
      if (result === "back") {
        step = "api-key";
        continue;
      }
      userId = result;
      step = "email";
      continue;
    }

    if (step === "email") {
      const result = await promptInteractiveGmailEmail(clack, emailTo ?? existingEmailTo);
      if (result === "back") {
        step = "user-id";
        continue;
      }
      emailTo = result;
      step = "account";
      continue;
    }

    if (step === "account") {
      if (!client || !userId) {
        step = "api-key";
        continue;
      }
      const result = await promptInteractiveGmailAccount(
        clack,
        client,
        userId,
        opts,
        connectedAccountId ?? existingConnectedAccountId,
        existingAuthConfigId,
      );
      if (result === "back") {
        step = "email";
        continue;
      }
      connectedAccountId = result;
      step = "routing";
      continue;
    }

    if (step === "routing") {
      const selection =
        optionRoutingPreset ??
        (await promptNotifierRoutingPreset(clack, rawConfig, targetName, "Composio Gmail", () =>
          cancelInteractiveComposioSetup(clack),
        ));
      if (selection === "back") {
        step = "account";
        continue;
      }
      routingPreset = selection === "preserve" ? undefined : selection;
      step = "review";
      continue;
    }

    if (!apiKey || !userId || !emailTo || !connectedAccountId) {
      step = "api-key";
      continue;
    }

    const resolved: ResolvedMailSetup = {
      apiKey: apiKey.apiKey,
      shouldWriteApiKey: apiKey.shouldWriteApiKey,
      userId,
      emailTo,
      connectedAccountId,
      targetName,
      routingPreset,
    };
    const reviewChoice = await promptInteractiveComposioGmailReview(
      clack,
      resolved,
      apiKey.sourceLabel,
    );
    if (reviewChoice === "email") {
      step = "email";
      continue;
    }
    if (reviewChoice === "account") {
      step = "account";
      continue;
    }
    if (reviewChoice === "routing") {
      step = "routing";
      continue;
    }
    if (reviewChoice === "app") {
      return "back";
    }

    writeComposioMailConfig(configPath, resolved, targetName);
    console.log(chalk.green(`✓ Config written to ${configPath}`));
    console.log(chalk.green(`✓ Gmail connected account: ${connectedAccountId}`));
    console.log(chalk.dim(`Test it with: ao notify test --to ${targetName} --template basic`));
    clack.outro("Composio Gmail setup complete.");
    return "done";
  }
}

async function showComposioAppPlaceholder(
  clack: ClackPrompts,
  choice: ComposioAppChoice,
): Promise<"back"> {
  printComposioAppRequirements(choice);
  const next = await clack.select({
    message: "What do you want to do next?",
    options: [
      { value: "back", label: "Back to app choices", hint: "Pick another Composio app" },
      { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
    ],
  });

  if (clack.isCancel(next) || next === "cancel") {
    cancelInteractiveComposioSetup(clack);
  }
  return "back";
}

async function runInteractiveComposioSetupHub(
  opts: ComposioSetupOptions,
  configPath: string,
  rawConfig: Record<string, unknown>,
): Promise<void> {
  const clack = await import("@clack/prompts");
  let directChoice = getDirectComposioAppChoice(opts);
  clack.intro("AO Composio notifier setup");

  while (true) {
    const choice =
      directChoice ??
      (await clack.select({
        message: "Which Composio app do you want to configure?",
        options: [
          { value: "slack", label: "Slack" },
          {
            value: "discord-webhook",
            label: "Discord webhook",
          },
          {
            value: "discord-bot",
            label: "Discord bot",
          },
          {
            value: "gmail",
            label: "Gmail",
          },
          { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
        ],
      }));
    directChoice = undefined;

    if (clack.isCancel(choice) || choice === "cancel") {
      cancelInteractiveComposioSetup(clack);
    }

    if (choice === "slack") {
      const result = await runInteractiveComposioSlackSetup(clack, opts, configPath, rawConfig);
      if (result === "done") return;
      continue;
    }

    if (choice === "discord-webhook") {
      const result = await runInteractiveComposioDiscordWebhookSetup(
        clack,
        opts,
        configPath,
        rawConfig,
      );
      if (result === "done") return;
      continue;
    }

    if (choice === "discord-bot") {
      const result = await runInteractiveComposioDiscordBotSetup(
        clack,
        opts,
        configPath,
        rawConfig,
      );
      if (result === "done") return;
      continue;
    }

    if (choice === "gmail") {
      const result = await runInteractiveComposioGmailSetup(clack, opts, configPath, rawConfig);
      if (result === "done") return;
      continue;
    }

    await showComposioAppPlaceholder(clack, choice as ComposioAppChoice);
  }
}

function parseDiscordWebhookUrl(webhookUrl: string): { webhookId: string; webhookToken: string } {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new ComposioSetupError(
      "Invalid Discord webhook URL. Expected https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN.",
    );
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const webhookIndex = segments.findIndex((segment) => segment === "webhooks");
  const webhookId = webhookIndex >= 0 ? segments[webhookIndex + 1] : undefined;
  const webhookToken = webhookIndex >= 0 ? segments[webhookIndex + 2] : undefined;
  if (!webhookId || !webhookToken) {
    throw new ComposioSetupError(
      "Invalid Discord webhook URL. Expected https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN.",
    );
  }

  return {
    webhookId: decodeURIComponent(webhookId),
    webhookToken: decodeURIComponent(webhookToken),
  };
}

async function createDiscordBearerAuthConfig(
  client: ComposioSetupClient,
  token: string,
  name: string,
): Promise<string> {
  if (!client.authConfigs?.create) {
    throw new ComposioSetupError(
      "Composio SDK client does not expose authConfigs.create(); pass --connected-account-id.",
    );
  }

  let authConfig: unknown;
  try {
    authConfig = await client.authConfigs.create(DISCORD_TOOLKIT, {
      type: "use_custom_auth",
      name,
      authScheme: "BEARER_TOKEN",
      credentials: { token },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ComposioSetupError(`Could not create a Composio Discord auth config: ${message}`);
  }

  const authConfigId = isRecord(authConfig) ? stringValue(authConfig["id"]) : undefined;
  if (!authConfigId) {
    throw new ComposioSetupError("Could not create a Composio Discord auth config.");
  }

  return authConfigId;
}

async function createDiscordBearerConnectedAccountWithAuthConfig(
  client: ComposioSetupClient,
  userId: string,
  authConfigId: string,
  token: string,
): Promise<string> {
  if (!client.connectedAccounts.initiate) {
    throw new ComposioSetupError(
      "Composio SDK client does not expose connectedAccounts.initiate(); pass --connected-account-id.",
    );
  }

  let request: ConnectionRequest;
  try {
    request = toConnectionRequest(
      await client.connectedAccounts.initiate(userId, authConfigId, {
        allowMultiple: true,
        config: {
          authScheme: "BEARER_TOKEN",
          val: {
            status: "ACTIVE",
            token,
          },
        },
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ComposioSetupError(
      `Could not create a Composio Discord connected account: ${message}`,
    );
  }

  if (!request.id) {
    throw new ComposioSetupError("Could not create a Composio Discord connected account.");
  }

  return request.id;
}

async function createDiscordBearerConnectedAccount(
  client: ComposioSetupClient,
  userId: string,
  token: string,
  name: string,
): Promise<string> {
  const authConfigId = await createDiscordBearerAuthConfig(client, token, name);
  return createDiscordBearerConnectedAccountWithAuthConfig(client, userId, authConfigId, token);
}

async function resolveDiscordWebhookConnectedAccountId(
  client: ComposioSetupClient,
  userId: string,
  webhookUrl: string,
  connectedAccountId?: string,
  explicitConnectedAccountId = false,
): Promise<string> {
  if (connectedAccountId) {
    try {
      const account = await verifyConnectedAccountForToolkit(
        client,
        userId,
        connectedAccountId,
        DISCORD_TOOLKIT,
        "Discord webhook",
      );
      return account.id;
    } catch (error) {
      if (explicitConnectedAccountId) throw error;
      console.log(chalk.yellow(error instanceof Error ? error.message : String(error)));
      console.log(chalk.dim("Creating a new Discord webhook connected account for this userId."));
    }
  }

  const { webhookToken } = parseDiscordWebhookUrl(webhookUrl);
  return createDiscordBearerConnectedAccount(
    client,
    userId,
    webhookToken,
    "Discord Webhook Auth Config",
  );
}

async function validateDiscordBotChannelAccess(botToken: string, channelId: string): Promise<void> {
  const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`, {
    headers: {
      Authorization: `Bot ${botToken}`,
    },
  });

  if (res.ok) return;

  let message = `${res.status} ${res.statusText}`.trim();
  try {
    const body = (await res.json()) as unknown;
    if (isRecord(body) && stringValue(body["message"])) {
      message = `${res.status} ${stringValue(body["message"])}`;
    }
  } catch {
    // Keep the HTTP status message.
  }

  if (res.status === 401) {
    throw new ComposioSetupError(`Discord bot token is invalid (${message}).`);
  }
  if (res.status === 403) {
    throw new ComposioSetupError(
      `Discord bot cannot access channel ${channelId} (${message}). Invite the bot to the server and grant View Channel + Send Messages.`,
    );
  }
  throw new ComposioSetupError(`Could not validate Discord channel ${channelId}: ${message}.`);
}

function writeComposioConfig(configPath: string, resolved: ResolvedComposioSetup): void {
  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};
  const notifiers = isRecord(rawConfig["notifiers"]) ? rawConfig["notifiers"] : {};
  const targetName = resolved.targetName ?? COMPOSIO_NOTIFIER;
  const existing = isRecord(notifiers[targetName]) ? notifiers[targetName] : {};
  const channel = channelConfig(resolved.channel);

  const composioConfig: Record<string, unknown> = {
    ...existing,
    plugin: "composio",
    defaultApp: "slack",
    userId: resolved.userId,
    ...channel,
  };

  if ("channelId" in channel) delete composioConfig["channelName"];
  else if ("channelName" in channel) delete composioConfig["channelId"];
  else {
    delete composioConfig["channelId"];
    delete composioConfig["channelName"];
  }

  if (resolved.connectedAccountId) {
    composioConfig["connectedAccountId"] = resolved.connectedAccountId;
  } else {
    delete composioConfig["connectedAccountId"];
  }

  if (resolved.shouldWriteApiKey) {
    composioConfig["composioApiKey"] = resolved.apiKey;
  }

  delete composioConfig["mode"];
  delete composioConfig["webhookUrl"];
  delete composioConfig["emailTo"];
  delete composioConfig["entityId"];
  delete composioConfig["botToken"];
  delete composioConfig["authConfigId"];
  delete composioConfig["toolVersion"];
  notifiers[targetName] = composioConfig;
  rawConfig["notifiers"] = notifiers;

  if (resolved.routingPreset) {
    ensureNotifierDefault(rawConfig, targetName);
  }
  applyNotifierRoutingPreset(rawConfig, targetName, resolved.routingPreset);

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

function writeComposioDiscordConfig(configPath: string, resolved: ResolvedDiscordSetup): void {
  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};
  const notifiers = isRecord(rawConfig["notifiers"]) ? rawConfig["notifiers"] : {};
  const existingRaw = notifiers[resolved.targetName];
  const existing = isRecord(existingRaw) ? existingRaw : {};

  const composioConfig: Record<string, unknown> = {
    ...existing,
    plugin: "composio",
    defaultApp: "discord",
    mode: resolved.mode,
    userId: resolved.userId,
    toolVersion: DISCORD_TOOL_VERSION,
  };

  if (resolved.mode === "webhook") {
    composioConfig["webhookUrl"] = resolved.webhookUrl;
    delete composioConfig["channelId"];
    delete composioConfig["channelName"];
    delete composioConfig["emailTo"];
    if (resolved.connectedAccountId) {
      composioConfig["connectedAccountId"] = resolved.connectedAccountId;
    } else {
      delete composioConfig["connectedAccountId"];
    }
  } else {
    composioConfig["channelId"] = resolved.channelId;
    delete composioConfig["webhookUrl"];
    delete composioConfig["channelName"];
    delete composioConfig["emailTo"];
    if (resolved.connectedAccountId) {
      composioConfig["connectedAccountId"] = resolved.connectedAccountId;
    } else {
      delete composioConfig["connectedAccountId"];
    }
  }

  if (resolved.shouldWriteApiKey) {
    composioConfig["composioApiKey"] = resolved.apiKey;
  }

  delete composioConfig["entityId"];
  delete composioConfig["botToken"];
  delete composioConfig["authConfigId"];
  notifiers[resolved.targetName] = composioConfig;
  rawConfig["notifiers"] = notifiers;

  if (resolved.routingPreset) {
    ensureNotifierDefault(rawConfig, resolved.targetName);
  }
  applyNotifierRoutingPreset(rawConfig, resolved.targetName, resolved.routingPreset);

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

function writeComposioMailConfig(
  configPath: string,
  resolved: ResolvedMailSetup,
  targetName = COMPOSIO_MAIL_NOTIFIER,
): void {
  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};
  const notifiers = isRecord(rawConfig["notifiers"]) ? rawConfig["notifiers"] : {};
  const existingRaw = notifiers[targetName];
  const existing = isRecord(existingRaw) ? existingRaw : {};

  const composioConfig: Record<string, unknown> = {
    ...existing,
    plugin: "composio",
    defaultApp: "gmail",
    userId: resolved.userId,
    emailTo: resolved.emailTo,
    toolVersion: GMAIL_TOOL_VERSION,
  };

  if (resolved.connectedAccountId) {
    composioConfig["connectedAccountId"] = resolved.connectedAccountId;
  } else {
    delete composioConfig["connectedAccountId"];
  }

  if (resolved.shouldWriteApiKey) {
    composioConfig["composioApiKey"] = resolved.apiKey;
  }

  delete composioConfig["entityId"];
  delete composioConfig["channelId"];
  delete composioConfig["channelName"];
  delete composioConfig["webhookUrl"];
  delete composioConfig["mode"];
  delete composioConfig["authConfigId"];
  delete composioConfig["botToken"];
  notifiers[targetName] = composioConfig;
  rawConfig["notifiers"] = notifiers;

  if (resolved.routingPreset) {
    ensureNotifierDefault(rawConfig, targetName);
  }
  applyNotifierRoutingPreset(rawConfig, targetName, resolved.routingPreset);

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

function printStatus(
  resolved: Pick<ResolvedComposioSetup, "apiKey" | "userId" | "connectedAccountId">,
  accounts: ConnectedAccount[],
  targetName = COMPOSIO_NOTIFIER,
  rawConfig?: Record<string, unknown>,
): void {
  console.log(chalk.bold(`AO Composio notifier (${targetName})`));
  console.log("  api key: configured");
  console.log(`  userId: ${resolved.userId}`);
  console.log(`  connectedAccountId: ${resolved.connectedAccountId ?? "not configured"}`);
  if (rawConfig) console.log(`  routing: ${getNotifierRoutingState(rawConfig, targetName).label}`);
  console.log(`  active Slack accounts: ${accounts.length}`);
  for (const account of accounts) {
    console.log(`    - ${account.id}${account.alias ? ` (${account.alias})` : ""}`);
  }
}

function printDiscordStatus(
  resolved: Pick<ResolvedDiscordSetup, "userId" | "connectedAccountId" | "targetName" | "mode">,
  rawConfig?: Record<string, unknown>,
): void {
  console.log(chalk.bold(`AO Composio Discord notifier (${resolved.targetName})`));
  console.log("  api key: configured");
  console.log(`  mode: ${resolved.mode}`);
  console.log(`  userId: ${resolved.userId}`);
  console.log(`  connectedAccountId: ${resolved.connectedAccountId ?? "not configured"}`);
  if (rawConfig) {
    console.log(`  routing: ${getNotifierRoutingState(rawConfig, resolved.targetName).label}`);
  }
}

function printMailStatus(
  resolved: Pick<ResolvedMailSetup, "userId" | "connectedAccountId" | "emailTo">,
  accounts: ConnectedAccount[],
  rawConfig?: Record<string, unknown>,
  targetName = COMPOSIO_MAIL_NOTIFIER,
): void {
  console.log(chalk.bold(`AO Composio mail notifier (${targetName})`));
  console.log("  api key: configured");
  console.log(`  userId: ${resolved.userId}`);
  console.log(`  emailTo: ${resolved.emailTo ?? "not configured"}`);
  console.log(`  connectedAccountId: ${resolved.connectedAccountId ?? "not configured"}`);
  if (rawConfig) console.log(`  routing: ${getNotifierRoutingState(rawConfig, targetName).label}`);
  console.log(`  active Gmail accounts: ${accounts.length}`);
  for (const account of accounts) {
    console.log(`    - ${account.id}${account.alias ? ` (${account.alias})` : ""}`);
  }
}

async function resolveSetup(
  opts: ComposioSetupOptions,
  rawConfig: Record<string, unknown>,
  nonInteractive: boolean,
  targetName = COMPOSIO_NOTIFIER,
): Promise<ResolvedComposioSetup> {
  const existing = getExistingNotifierConfig(rawConfig, targetName);
  const { apiKey, shouldWriteApiKey } = resolveApiKey(opts, existing);
  if (!apiKey) {
    throw new ComposioSetupError(
      "No Composio API key found. Pass --api-key or set COMPOSIO_API_KEY.",
    );
  }

  const userId = resolveUserId(opts, existing);
  const client = await loadComposioClient(apiKey);
  const explicitConnectedAccountId =
    stringValue(opts.connectedAccountId) ?? stringValue(existing["connectedAccountId"]);
  const routingPreset = resolveComposioRoutingPreset(opts.routingPreset) ?? "all";

  if (opts.status) {
    const accounts = await listActiveSlackAccounts(client, userId);
    printStatus(
      { apiKey, userId, connectedAccountId: explicitConnectedAccountId },
      accounts,
      targetName,
      rawConfig,
    );
    return {
      apiKey,
      shouldWriteApiKey,
      userId,
      targetName,
      channel: stringValue(opts.channel),
      connectedAccountId: explicitConnectedAccountId,
      routingPreset,
    };
  }

  if (explicitConnectedAccountId) {
    const account = await verifyConnectedAccount(client, userId, explicitConnectedAccountId);
    return {
      apiKey,
      shouldWriteApiKey,
      userId,
      targetName,
      channel: stringValue(opts.channel),
      connectedAccountId: account.id,
      routingPreset,
    };
  }

  const accounts = await listActiveSlackAccounts(client, userId);
  if (accounts.length > 0) {
    const account = await chooseAccount(accounts, nonInteractive);
    return {
      apiKey,
      shouldWriteApiKey,
      userId,
      targetName,
      channel: stringValue(opts.channel),
      connectedAccountId: account.id,
      routingPreset,
    };
  }

  const connection = await createConnectionRequest(client, userId, parseWaitMs(opts.waitMs));
  return {
    apiKey,
    shouldWriteApiKey,
    userId,
    targetName,
    channel: stringValue(opts.channel),
    connectedAccountId: connection.account?.id,
    connectionUrl: connection.url,
    routingPreset,
  };
}

export async function runComposioSetupAction(opts: ComposioSetupOptions): Promise<void> {
  const nonInteractive = opts.nonInteractive || !process.stdin.isTTY;

  let configPath: string | undefined;
  try {
    configPath = findConfigFile() ?? undefined;
  } catch {
    configPath = undefined;
  }

  if (!configPath) {
    throw new ComposioSetupError(
      "No agent-orchestrator.yaml found. Run 'ao start' first to create one.",
    );
  }

  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};
  const existing = getExistingComposioConfig(rawConfig);
  const existingPlugin = stringValue(existing["plugin"]);
  const directChoice = getDirectComposioAppChoice(opts);

  if (directChoice && nonInteractive) {
    throw new ComposioSetupError(
      "Composio app flags require interactive setup. Use the dedicated setup command with --non-interactive for scriptable setup.",
    );
  }

  if (shouldUseInteractiveComposioHub(opts, nonInteractive)) {
    await runInteractiveComposioSetupHub(opts, configPath, rawConfig);
    return;
  }

  if (existingPlugin && existingPlugin !== "composio" && !opts.force) {
    throw new ComposioSetupError(
      `notifiers.composio already uses plugin "${existingPlugin}". Re-run with --force to replace it.`,
    );
  }

  const resolved = await resolveSetup(opts, rawConfig, nonInteractive);
  if (opts.status) return;

  if (resolved.connectionUrl && !resolved.connectedAccountId) {
    console.log(
      chalk.yellow(
        "Slack connection did not complete yet. Open the connect URL above, finish the Composio flow, then rerun `ao setup composio`.",
      ),
    );
    console.log(chalk.dim("No config was changed."));
    return;
  }

  writeComposioConfig(configPath, resolved);
  console.log(chalk.green(`✓ Config written to ${configPath}`));

  if (resolved.connectedAccountId) {
    console.log(chalk.green(`✓ Slack connected account: ${resolved.connectedAccountId}`));
  }

  console.log(chalk.dim("Test it with: ao notify test --to composio --template ci-failing"));
}

export async function runComposioSlackSetupAction(opts: ComposioSetupOptions): Promise<void> {
  const nonInteractive = opts.nonInteractive || !process.stdin.isTTY;

  let configPath: string | undefined;
  try {
    configPath = findConfigFile() ?? undefined;
  } catch {
    configPath = undefined;
  }

  if (!configPath) {
    throw new ComposioSetupError(
      "No agent-orchestrator.yaml found. Run 'ao start' first to create one.",
    );
  }

  const rawYaml = readFileSync(configPath, "utf-8");
  const rawConfig = (parseDocument(rawYaml).toJS() as Record<string, unknown>) ?? {};

  if (shouldUseInteractiveDedicatedSetup(opts, nonInteractive)) {
    const clack = await import("@clack/prompts");
    clack.intro("AO Composio Slack setup");
    await runInteractiveComposioSlackSetup(
      clack,
      opts,
      configPath,
      rawConfig,
      COMPOSIO_SLACK_NOTIFIER,
    );
    return;
  }

  const existing = getExistingNotifierConfig(rawConfig, COMPOSIO_SLACK_NOTIFIER);
  const existingPlugin = stringValue(existing["plugin"]);

  if (existingPlugin && existingPlugin !== "composio" && !opts.force) {
    throw new ComposioSetupError(
      `notifiers.${COMPOSIO_SLACK_NOTIFIER} already uses plugin "${existingPlugin}". Re-run with --force to replace it.`,
    );
  }

  const resolved = await resolveSetup(opts, rawConfig, nonInteractive, COMPOSIO_SLACK_NOTIFIER);
  if (opts.status) return;

  if (resolved.connectionUrl && !resolved.connectedAccountId) {
    console.log(
      chalk.yellow(
        "Slack connection did not complete yet. Open the connect URL above, finish the Composio flow, then rerun `ao setup composio-slack`.",
      ),
    );
    console.log(chalk.dim("No config was changed."));
    return;
  }

  writeComposioConfig(configPath, resolved);
  console.log(chalk.green(`✓ Config written to ${configPath}`));

  if (resolved.connectedAccountId) {
    console.log(chalk.green(`✓ Slack connected account: ${resolved.connectedAccountId}`));
  }

  console.log(
    chalk.dim(`Test it with: ao notify test --to ${COMPOSIO_SLACK_NOTIFIER} --template ci-failing`),
  );
}

async function resolveDiscordWebhookSetup(
  opts: ComposioDiscordWebhookSetupOptions,
  rawConfig: Record<string, unknown>,
): Promise<ResolvedDiscordSetup> {
  const targetName = COMPOSIO_DISCORD_WEBHOOK_NOTIFIER;
  const existing = getExistingNotifierConfig(rawConfig, targetName);
  const { apiKey, shouldWriteApiKey } = resolveApiKey(opts, existing);
  if (!apiKey) {
    throw new ComposioSetupError(
      "No Composio API key found. Pass --api-key or set COMPOSIO_API_KEY.",
    );
  }

  const userId = resolveUserId(opts, existing);
  const client = await loadComposioClient(apiKey);
  const routingPreset = resolveComposioRoutingPreset(opts.routingPreset) ?? "all";
  const explicitConnectedAccountId = stringValue(opts.connectedAccountId);
  const existingConnectedAccountId = stringValue(existing["connectedAccountId"]);
  const connectedAccountId = explicitConnectedAccountId ?? existingConnectedAccountId;
  const webhookUrl =
    stringValue(opts.webhookUrl) ??
    stringValue(process.env.DISCORD_WEBHOOK_URL) ??
    stringValue(existing["webhookUrl"]);

  if (opts.status) {
    printDiscordStatus({ targetName, mode: "webhook", userId, connectedAccountId }, rawConfig);
    return {
      apiKey,
      shouldWriteApiKey,
      userId,
      mode: "webhook",
      targetName,
      webhookUrl,
      connectedAccountId,
      routingPreset,
    };
  }

  if (!webhookUrl) {
    throw new ComposioSetupError(
      "No Discord webhook URL found. Pass --webhook-url or set DISCORD_WEBHOOK_URL.",
    );
  }
  parseDiscordWebhookUrl(webhookUrl);
  const resolvedConnectedAccountId = await resolveDiscordWebhookConnectedAccountId(
    client,
    userId,
    webhookUrl,
    connectedAccountId,
    Boolean(explicitConnectedAccountId),
  );

  return {
    apiKey,
    shouldWriteApiKey,
    userId,
    mode: "webhook",
    targetName,
    webhookUrl,
    connectedAccountId: resolvedConnectedAccountId,
    routingPreset,
  };
}

async function resolveDiscordBotSetup(
  opts: ComposioDiscordBotSetupOptions,
  rawConfig: Record<string, unknown>,
): Promise<ResolvedDiscordSetup> {
  const targetName = COMPOSIO_DISCORD_BOT_NOTIFIER;
  const existing = getExistingNotifierConfig(rawConfig, targetName);
  const { apiKey, shouldWriteApiKey } = resolveApiKey(opts, existing);
  if (!apiKey) {
    throw new ComposioSetupError(
      "No Composio API key found. Pass --api-key or set COMPOSIO_API_KEY.",
    );
  }

  const userId = resolveUserId(opts, existing);
  const client = await loadComposioClient(apiKey);
  const routingPreset = resolveComposioRoutingPreset(opts.routingPreset) ?? "all";
  const connectedAccountId =
    stringValue(opts.connectedAccountId) ?? stringValue(existing["connectedAccountId"]);
  const channelId = stringValue(opts.channelId) ?? stringValue(existing["channelId"]);
  const botToken = stringValue(opts.botToken) ?? stringValue(process.env.DISCORD_BOT_TOKEN);

  if (opts.status) {
    printDiscordStatus({ targetName, mode: "bot", userId, connectedAccountId }, rawConfig);
    return {
      apiKey,
      shouldWriteApiKey,
      userId,
      mode: "bot",
      targetName,
      channelId,
      connectedAccountId,
      routingPreset,
    };
  }

  if (!channelId) {
    throw new ComposioSetupError("No Discord channel id found. Pass --channel-id.");
  }

  if (connectedAccountId) {
    const account = await verifyConnectedAccountForToolkit(
      client,
      userId,
      connectedAccountId,
      DISCORD_TOOLKIT,
      "Discord Bot",
    );
    return {
      apiKey,
      shouldWriteApiKey,
      userId,
      mode: "bot",
      targetName,
      channelId,
      connectedAccountId: account.id,
      routingPreset,
    };
  }

  if (!botToken) {
    throw new ComposioSetupError(
      "No Discord bot token found. Pass --bot-token or set DISCORD_BOT_TOKEN.",
    );
  }

  await validateDiscordBotChannelAccess(botToken, channelId);

  return {
    apiKey,
    shouldWriteApiKey,
    userId,
    mode: "bot",
    targetName,
    channelId,
    connectedAccountId: await createDiscordBearerConnectedAccount(
      client,
      userId,
      botToken,
      "Discord Bot Auth Config",
    ),
    routingPreset,
  };
}

async function resolveMailSetup(
  opts: ComposioMailSetupOptions,
  rawConfig: Record<string, unknown>,
  nonInteractive: boolean,
): Promise<ResolvedMailSetup> {
  const existing = getExistingNotifierConfig(rawConfig, COMPOSIO_MAIL_NOTIFIER);
  const { apiKey, shouldWriteApiKey } = resolveApiKey(opts, existing);
  if (!apiKey) {
    throw new ComposioSetupError(
      "No Composio API key found. Pass --api-key or set COMPOSIO_API_KEY.",
    );
  }

  const userId = resolveUserId(opts, existing);
  const client = await loadComposioClient(apiKey);
  const emailTo = stringValue(opts.emailTo) ?? stringValue(existing["emailTo"]);
  const authConfigId = stringValue(opts.authConfigId) ?? stringValue(existing["authConfigId"]);
  const optionConnectedAccountId = stringValue(opts.connectedAccountId);
  const existingConnectedAccountId = stringValue(existing["connectedAccountId"]);
  const connectedAccountId = optionConnectedAccountId ?? existingConnectedAccountId;
  const routingPreset = resolveComposioRoutingPreset(opts.routingPreset) ?? "all";

  if (opts.status) {
    const accounts = await listActiveGmailAccounts(client, userId);
    printMailStatus({ userId, emailTo, connectedAccountId }, accounts, rawConfig);
    return {
      apiKey,
      shouldWriteApiKey,
      userId,
      emailTo,
      connectedAccountId,
      targetName: COMPOSIO_MAIL_NOTIFIER,
      routingPreset,
    };
  }

  if (!emailTo) {
    throw new ComposioSetupError("No recipient email found. Pass --email-to.");
  }

  if (connectedAccountId) {
    let account: ConnectedAccount | undefined;
    try {
      account = await withConnectedAccountDetails(
        client,
        await verifyConnectedAccountForToolkit(
          client,
          userId,
          connectedAccountId,
          GMAIL_TOOLKIT,
          "Gmail",
          () => listActiveGmailAccounts(client, userId),
        ),
      );
    } catch (err) {
      if (optionConnectedAccountId) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        chalk.yellow(
          `Existing Gmail connected account ${connectedAccountId} could not be used: ${message}. Looking for another Gmail connected account.`,
        ),
      );
    }

    if (account && (await accountCanSendGmail(client, account))) {
      return {
        apiKey,
        shouldWriteApiKey,
        userId,
        emailTo,
        connectedAccountId: account.id,
        targetName: COMPOSIO_MAIL_NOTIFIER,
        routingPreset,
      };
    }

    if (account && optionConnectedAccountId) {
      throw new ComposioSetupError(
        `Connected account ${connectedAccountId} is missing Gmail send/profile access. Connect Gmail in Composio with send access, then rerun \`ao setup composio-mail --email-to ${emailTo} --connected-account-id ${connectedAccountId}\`, or pass a different Gmail connected account.`,
      );
    }

    if (account) {
      console.log(
        chalk.yellow(
          `Existing Gmail connected account ${connectedAccountId} is missing Gmail send/profile access. Looking for another Gmail connected account.`,
        ),
      );
    }
  }

  const accounts = await listUsableGmailAccounts(client, userId);
  if (accounts.length > 0) {
    const account = await chooseAccount(accounts, nonInteractive, "Gmail");
    return {
      apiKey,
      shouldWriteApiKey,
      userId,
      emailTo,
      connectedAccountId: account.id,
      targetName: COMPOSIO_MAIL_NOTIFIER,
      routingPreset,
    };
  }

  if (opts.connect) {
    const connection = await createManagedOAuthConnectionRequest(
      client,
      userId,
      GMAIL_TOOLKIT,
      "Gmail",
      "Gmail Auth Config",
      parseWaitMs(opts.waitMs),
      {
        authConfigId: await resolveGmailConnectAuthConfigId(client, authConfigId, nonInteractive),
      },
    );

    if (connection.account) {
      const account = await withConnectedAccountDetails(client, connection.account);
      if (!(await accountCanSendGmail(client, account))) {
        throw new ComposioSetupError(
          `Connected Gmail account ${account.id} is missing Gmail send/profile access. Fix the Gmail connection in Composio, then rerun \`ao setup composio-mail\`.`,
        );
      }
      return {
        apiKey,
        shouldWriteApiKey,
        userId,
        emailTo,
        connectedAccountId: account.id,
        targetName: COMPOSIO_MAIL_NOTIFIER,
        routingPreset,
      };
    }

    return {
      apiKey,
      shouldWriteApiKey,
      userId,
      emailTo,
      connectionUrl: connection.url,
      targetName: COMPOSIO_MAIL_NOTIFIER,
      routingPreset,
    };
  }

  throw new ComposioSetupError(
    [
      `No active Gmail connected account with send access was found for user ${userId}.`,
      "Connect Gmail in Composio first, then rerun `ao setup composio-mail`, or rerun with `--connect` to print a Composio connect URL.",
      `You can also pass an existing Gmail account with \`ao setup composio-mail --email-to ${emailTo} --connected-account-id ca_...\`.`,
    ].join(" "),
  );
}

export async function runComposioDiscordWebhookSetupAction(
  opts: ComposioDiscordWebhookSetupOptions,
): Promise<void> {
  let configPath: string | undefined;
  try {
    configPath = findConfigFile() ?? undefined;
  } catch {
    configPath = undefined;
  }

  if (!configPath) {
    throw new ComposioSetupError(
      "No agent-orchestrator.yaml found. Run 'ao start' first to create one.",
    );
  }

  const rawYaml = readFileSync(configPath, "utf-8");
  const rawConfig = (parseDocument(rawYaml).toJS() as Record<string, unknown>) ?? {};

  if (shouldUseInteractiveDedicatedSetup(opts, opts.nonInteractive || !process.stdin.isTTY)) {
    const clack = await import("@clack/prompts");
    clack.intro("AO Composio Discord webhook setup");
    await runInteractiveComposioDiscordWebhookSetup(
      clack,
      opts,
      configPath,
      rawConfig,
      COMPOSIO_DISCORD_WEBHOOK_NOTIFIER,
    );
    return;
  }

  const existing = getExistingNotifierConfig(rawConfig, COMPOSIO_DISCORD_WEBHOOK_NOTIFIER);
  const existingPlugin = stringValue(existing["plugin"]);

  if (existingPlugin && existingPlugin !== "composio" && !opts.force) {
    throw new ComposioSetupError(
      `notifiers.${COMPOSIO_DISCORD_WEBHOOK_NOTIFIER} already uses plugin "${existingPlugin}". Re-run with --force to replace it.`,
    );
  }

  const resolved = await resolveDiscordWebhookSetup(opts, rawConfig);
  if (opts.status) return;

  writeComposioDiscordConfig(configPath, resolved);
  console.log(chalk.green(`✓ Config written to ${configPath}`));
  console.log(chalk.green("✓ Discord webhook configured through Composio"));
  if (resolved.connectedAccountId) {
    console.log(chalk.green(`✓ Discord webhook connected account: ${resolved.connectedAccountId}`));
  }
  console.log(
    chalk.dim(
      `Test it with: ao notify test --to ${COMPOSIO_DISCORD_WEBHOOK_NOTIFIER} --template basic`,
    ),
  );
}

export async function runComposioDiscordBotSetupAction(
  opts: ComposioDiscordBotSetupOptions,
): Promise<void> {
  let configPath: string | undefined;
  try {
    configPath = findConfigFile() ?? undefined;
  } catch {
    configPath = undefined;
  }

  if (!configPath) {
    throw new ComposioSetupError(
      "No agent-orchestrator.yaml found. Run 'ao start' first to create one.",
    );
  }

  const rawYaml = readFileSync(configPath, "utf-8");
  const rawConfig = (parseDocument(rawYaml).toJS() as Record<string, unknown>) ?? {};

  if (shouldUseInteractiveDedicatedSetup(opts, opts.nonInteractive || !process.stdin.isTTY)) {
    const clack = await import("@clack/prompts");
    clack.intro("AO Composio Discord bot setup");
    await runInteractiveComposioDiscordBotSetup(
      clack,
      opts,
      configPath,
      rawConfig,
      COMPOSIO_DISCORD_BOT_NOTIFIER,
    );
    return;
  }

  const existing = getExistingNotifierConfig(rawConfig, COMPOSIO_DISCORD_BOT_NOTIFIER);
  const existingPlugin = stringValue(existing["plugin"]);

  if (existingPlugin && existingPlugin !== "composio" && !opts.force) {
    throw new ComposioSetupError(
      `notifiers.${COMPOSIO_DISCORD_BOT_NOTIFIER} already uses plugin "${existingPlugin}". Re-run with --force to replace it.`,
    );
  }

  const resolved = await resolveDiscordBotSetup(opts, rawConfig);
  if (opts.status) return;

  writeComposioDiscordConfig(configPath, resolved);
  console.log(chalk.green(`✓ Config written to ${configPath}`));
  console.log(chalk.green(`✓ Discord bot connected account: ${resolved.connectedAccountId}`));
  console.log(
    chalk.dim(
      `Test it with: ao notify test --to ${COMPOSIO_DISCORD_BOT_NOTIFIER} --template basic`,
    ),
  );
}

export async function runComposioMailSetupAction(opts: ComposioMailSetupOptions): Promise<void> {
  const nonInteractive = opts.nonInteractive || !process.stdin.isTTY;

  let configPath: string | undefined;
  try {
    configPath = findConfigFile() ?? undefined;
  } catch {
    configPath = undefined;
  }

  if (!configPath) {
    throw new ComposioSetupError(
      "No agent-orchestrator.yaml found. Run 'ao start' first to create one.",
    );
  }

  const rawYaml = readFileSync(configPath, "utf-8");
  const rawConfig = (parseDocument(rawYaml).toJS() as Record<string, unknown>) ?? {};

  if (shouldUseInteractiveDedicatedSetup(opts, nonInteractive)) {
    const clack = await import("@clack/prompts");
    clack.intro("AO Composio Gmail setup");
    await runInteractiveComposioGmailSetup(
      clack,
      opts,
      configPath,
      rawConfig,
      COMPOSIO_MAIL_NOTIFIER,
    );
    return;
  }

  const existing = getExistingNotifierConfig(rawConfig, COMPOSIO_MAIL_NOTIFIER);
  const existingPlugin = stringValue(existing["plugin"]);

  if (existingPlugin && existingPlugin !== "composio" && !opts.force) {
    throw new ComposioSetupError(
      `notifiers.${COMPOSIO_MAIL_NOTIFIER} already uses plugin "${existingPlugin}". Re-run with --force to replace it.`,
    );
  }

  const resolved = await resolveMailSetup(opts, rawConfig, nonInteractive);
  if (opts.status) return;

  if (resolved.connectionUrl && !resolved.connectedAccountId) {
    console.log(
      chalk.yellow(
        "Gmail connection did not complete yet. Open the connect URL above, finish the Composio flow, then rerun `ao setup composio-mail`.",
      ),
    );
    console.log(chalk.dim("No config was changed."));
    return;
  }

  writeComposioMailConfig(configPath, resolved);
  console.log(chalk.green(`✓ Config written to ${configPath}`));

  if (resolved.connectedAccountId) {
    console.log(chalk.green(`✓ Gmail connected account: ${resolved.connectedAccountId}`));
  }

  console.log(
    chalk.dim(`Test it with: ao notify test --to ${COMPOSIO_MAIL_NOTIFIER} --template basic`),
  );
}
