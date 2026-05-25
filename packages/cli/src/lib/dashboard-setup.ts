import { readFileSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import { parseDocument } from "yaml";
import {
  CONFIG_SCHEMA_URL,
  DEFAULT_DASHBOARD_NOTIFICATION_LIMIT,
  getDashboardNotificationStorePath,
  isCanonicalGlobalConfigPath,
  findConfigFile,
  normalizeDashboardNotificationLimit,
  readDashboardNotificationsFromFile,
} from "@aoagents/ao-core";
import {
  applyNotifierRoutingPreset,
  ensureNotifierDefault,
  getNotifierRoutingState,
  resolveRoutingPresetOption,
  type NotifierRoutingPreset,
} from "./notifier-routing.js";

export interface DashboardSetupOptions {
  limit?: string;
  refresh?: boolean;
  status?: boolean;
  force?: boolean;
  nonInteractive?: boolean;
  routingPreset?: string;
}

interface ConfigContext {
  configPath: string;
  rawConfig: Record<string, unknown>;
}

interface DashboardConfig {
  plugin: "dashboard";
  limit: number;
}

interface ResolvedDashboardSetup {
  limit: number;
  shouldWriteConfig: boolean;
  routingPreset?: NotifierRoutingPreset;
}

export class DashboardSetupError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = "DashboardSetupError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readConfigContext(): ConfigContext {
  const configPath = findConfigFile() ?? undefined;
  if (!configPath) {
    throw new DashboardSetupError(
      "No agent-orchestrator.yaml found. Run 'ao start' first to create one.",
    );
  }

  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};
  return { configPath, rawConfig };
}

function getExistingDashboard(rawConfig: Record<string, unknown>): Record<string, unknown> {
  const notifiers = isRecord(rawConfig["notifiers"]) ? rawConfig["notifiers"] : {};
  const existing = notifiers["dashboard"];
  return isRecord(existing) ? existing : {};
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_DASHBOARD_NOTIFICATION_LIMIT;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new DashboardSetupError("Dashboard notification limit must be a number.");
  }
  return normalizeDashboardNotificationLimit(parsed);
}

function resolveDashboardRoutingPreset(
  value: string | undefined,
): NotifierRoutingPreset | undefined {
  try {
    return resolveRoutingPresetOption(value, "dashboard") as NotifierRoutingPreset | undefined;
  } catch (error) {
    throw new DashboardSetupError(error instanceof Error ? error.message : String(error));
  }
}

function toDashboardConfig(resolved: ResolvedDashboardSetup): DashboardConfig {
  return {
    plugin: "dashboard",
    limit: resolved.limit,
  };
}

function hasDashboardConfig(entry: Record<string, unknown>): boolean {
  return Object.keys(entry).length > 0;
}

function shouldWriteDashboardConfig(
  existingDashboard: Record<string, unknown>,
  limit: number,
): boolean {
  return hasDashboardConfig(existingDashboard) || limit !== DEFAULT_DASHBOARD_NOTIFICATION_LIMIT;
}

function writeDashboardConfig(configPath: string, resolved: ResolvedDashboardSetup): void {
  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};

  const notifiers = isRecord(rawConfig["notifiers"]) ? rawConfig["notifiers"] : {};
  if (resolved.shouldWriteConfig) {
    notifiers["dashboard"] = toDashboardConfig(resolved);
    rawConfig["notifiers"] = notifiers;
  } else if (isRecord(notifiers["dashboard"])) {
    delete notifiers["dashboard"];
    rawConfig["notifiers"] = notifiers;
  }

  ensureNotifierDefault(rawConfig, "dashboard");

  applyNotifierRoutingPreset(rawConfig, "dashboard", resolved.routingPreset);

  if (!isCanonicalGlobalConfigPath(configPath)) {
    const currentSchema = doc.get("$schema");
    if (!(typeof currentSchema === "string" && currentSchema.trim().length > 0)) {
      doc.set("$schema", CONFIG_SCHEMA_URL);
    }
  }

  doc.setIn(["defaults"], rawConfig["defaults"]);
  if (rawConfig["notifiers"] !== undefined) {
    doc.setIn(["notifiers"], rawConfig["notifiers"]);
  }
  if (rawConfig["notificationRouting"] !== undefined) {
    doc.setIn(["notificationRouting"], rawConfig["notificationRouting"]);
  }
  writeFileSync(configPath, doc.toString({ indent: 2 }));
}

async function shouldReplaceConflictingDashboard(
  plugin: unknown,
  force: boolean,
  nonInteractive: boolean,
): Promise<boolean> {
  if (plugin === undefined || plugin === "dashboard" || force) return true;

  if (nonInteractive) {
    throw new DashboardSetupError(
      `notifiers.dashboard already uses plugin "${String(plugin)}". Pass --force to replace it.`,
    );
  }

  const clack = await import("@clack/prompts");
  const answer = await clack.confirm({
    message: `notifiers.dashboard already uses plugin "${String(plugin)}". Replace it?`,
    initialValue: false,
  });

  if (clack.isCancel(answer)) {
    clack.cancel("Dashboard setup cancelled.");
    throw new DashboardSetupError("Dashboard setup cancelled.", 0);
  }

  return answer === true;
}

async function resolveInteractiveSetup(
  opts: DashboardSetupOptions,
  existingDashboard: Record<string, unknown>,
): Promise<ResolvedDashboardSetup> {
  const clack = await import("@clack/prompts");
  const optionRoutingPreset = resolveDashboardRoutingPreset(opts.routingPreset);
  const existingLimit = parseLimit(existingDashboard["limit"]);

  clack.intro(chalk.bgCyan(chalk.black(" ao setup dashboard ")));

  while (true) {
    const limitInput = await clack.text({
      message: "How many dashboard notifications should AO keep?",
      placeholder: String(DEFAULT_DASHBOARD_NOTIFICATION_LIMIT),
      initialValue: stringValue(opts.limit) ?? String(existingLimit),
      validate: (value) => {
        try {
          parseLimit(value);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    });

    if (clack.isCancel(limitInput)) {
      clack.cancel("Dashboard setup cancelled.");
      throw new DashboardSetupError("Dashboard setup cancelled.", 0);
    }

    const limit = parseLimit(limitInput);
    return {
      limit,
      shouldWriteConfig: shouldWriteDashboardConfig(existingDashboard, limit),
      routingPreset: optionRoutingPreset,
    };
  }
}

function resolveNonInteractiveSetup(
  opts: DashboardSetupOptions,
  existingDashboard: Record<string, unknown>,
): ResolvedDashboardSetup {
  const limit =
    opts.limit !== undefined
      ? parseLimit(opts.limit)
      : opts.refresh || existingDashboard["limit"] !== undefined
        ? parseLimit(existingDashboard["limit"])
        : DEFAULT_DASHBOARD_NOTIFICATION_LIMIT;
  const routingPreset = resolveDashboardRoutingPreset(opts.routingPreset) ?? undefined;

  return {
    limit,
    shouldWriteConfig: shouldWriteDashboardConfig(existingDashboard, limit),
    routingPreset,
  };
}

function printStatus(): void {
  const context = readConfigContext();
  const existingDashboard = getExistingDashboard(context.rawConfig);
  const plugin = stringValue(existingDashboard["plugin"]);
  const limit = parseLimit(existingDashboard["limit"]);
  const storePath = getDashboardNotificationStorePath(context.configPath);
  const records = readDashboardNotificationsFromFile(storePath, limit);
  const latest = records.at(-1);

  console.log(chalk.bold("Dashboard notifier status"));
  console.log(`  Config: ${context.configPath}`);
  console.log(`  Plugin: ${plugin ?? chalk.dim("not configured")}`);
  console.log(`  Limit: ${limit}`);
  console.log(`  Store: ${storePath}`);
  console.log(`  Stored: ${records.length}`);
  console.log(`  Latest: ${latest?.receivedAt ?? chalk.dim("none")}`);
  console.log(`  Routing: ${getNotifierRoutingState(context.rawConfig, "dashboard").label}`);
}

export async function runDashboardSetupAction(opts: DashboardSetupOptions): Promise<void> {
  const nonInteractive = opts.nonInteractive || !process.stdin.isTTY;
  const force = Boolean(opts.force);

  if (opts.status) {
    printStatus();
    return;
  }

  const context = readConfigContext();
  const existingDashboard = getExistingDashboard(context.rawConfig);
  const shouldWire = await shouldReplaceConflictingDashboard(
    existingDashboard["plugin"],
    force,
    nonInteractive,
  );
  if (!shouldWire) return;

  const resolved = nonInteractive
    ? resolveNonInteractiveSetup(opts, existingDashboard)
    : await resolveInteractiveSetup(opts, existingDashboard);

  writeDashboardConfig(context.configPath, resolved);
  console.log(chalk.green(`Config written to ${context.configPath}`));

  if (!nonInteractive) {
    const clack = await import("@clack/prompts");
    clack.outro(
      `${chalk.green("Dashboard setup complete!")} AO will retain the latest ${resolved.limit} dashboard notifications.\n` +
        chalk.dim("  Test it with: ao notify test --to dashboard --template basic"),
    );
  } else {
    console.log(chalk.green("\nDashboard setup complete."));
    console.log(chalk.dim("Test it with: ao notify test --to dashboard --template basic"));
  }
}
