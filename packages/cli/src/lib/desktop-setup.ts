import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import { parseDocument } from "yaml";
import { CONFIG_SCHEMA_URL, findConfigFile, isCanonicalGlobalConfigPath } from "@aoagents/ao-core";
import {
  applyNotifierRoutingPreset,
  getNotifierRoutingState,
  promptNotifierRoutingPreset,
  resolveRoutingPresetOption,
  type NotifierRoutingPreset,
} from "./notifier-routing.js";

const APP_NAME = "AO Notifier.app";
const EXECUTABLE_NAME = "ao-notifier";
const PLACEHOLDER_MARKER_NAME = "ao-notifier-placeholder";
const DESKTOP_BACKENDS = ["auto", "ao-app", "terminal-notifier", "osascript"] as const;

type DesktopBackend = (typeof DESKTOP_BACKENDS)[number];

export class DesktopSetupError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "DesktopSetupError";
  }
}

export interface DesktopSetupOptions {
  nonInteractive?: boolean;
  force?: boolean;
  status?: boolean;
  uninstall?: boolean;
  refresh?: boolean;
  backend?: string;
  dashboardUrl?: string;
  appPath?: string;
  test?: boolean;
  routingPreset?: string;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface DesktopConfigContext {
  configPath: string | undefined;
  rawConfig: Record<string, unknown>;
  existingDesktop: Record<string, unknown>;
}

interface ResolvedDesktopSetup {
  backend: DesktopBackend;
  dashboardUrl?: string;
  appPath: string;
  shouldWriteAppPath: boolean;
  shouldSendTest: boolean;
  refresh: boolean;
  routingPreset?: NotifierRoutingPreset;
}

function currentPlatform(): NodeJS.Platform | string {
  return process.env["AO_DESKTOP_SETUP_PLATFORM"] ?? platform();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isDesktopBackend(value: unknown): value is DesktopBackend {
  return typeof value === "string" && DESKTOP_BACKENDS.includes(value as DesktopBackend);
}

function parseDesktopBackend(value: unknown): DesktopBackend | undefined {
  if (value === undefined) return undefined;
  if (isDesktopBackend(value)) return value;
  throw new DesktopSetupError(
    `Invalid desktop backend "${String(value)}". Expected one of: ${DESKTOP_BACKENDS.join(", ")}.`,
  );
}

function packageDirFromImport(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve("@aoagents/ao-notifier-macos/package.json"));
  } catch {
    return null;
  }
}

export function getBundledNotifierAppPath(): string | null {
  const override = process.env["AO_NOTIFIER_MACOS_APP_PATH"];
  if (override) return override;

  const packageDir = packageDirFromImport();
  if (packageDir) {
    return resolve(packageDir, "dist", APP_NAME);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "notifier-macos", "dist", APP_NAME);
}

export function getInstalledNotifierAppPath(): string {
  return process.env["AO_DESKTOP_APP_INSTALL_PATH"] ?? join(homedir(), "Applications", APP_NAME);
}

export function getNotifierExecutablePath(appPath: string): string {
  return join(appPath, "Contents", "MacOS", EXECUTABLE_NAME);
}

function getNotifierPlaceholderMarkerPath(appPath: string): string {
  return join(appPath, "Contents", "Resources", PLACEHOLDER_MARKER_NAME);
}

function isPlaceholderNotifierApp(appPath: string): boolean {
  return existsSync(getNotifierPlaceholderMarkerPath(appPath));
}

function isAppInstalled(appPath = getInstalledNotifierAppPath()): boolean {
  return existsSync(getNotifierExecutablePath(appPath)) && !isPlaceholderNotifierApp(appPath);
}

function commandExists(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function execNotifierJson(appPath: string, args: string[]): JsonRecord | null {
  try {
    const output = execFileSync(getNotifierExecutablePath(appPath), args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(output) as JsonRecord;
  } catch {
    return null;
  }
}

function parseJsonOutput(output: unknown): JsonRecord | null {
  try {
    const text = Buffer.isBuffer(output) ? output.toString("utf-8") : String(output ?? "");
    if (!text.trim()) return null;
    return JSON.parse(text) as JsonRecord;
  } catch {
    return null;
  }
}

function formatExecError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function permissionDeniedMessage(): string {
  return (
    "macOS notification permission is denied for AO Notifier.app.\n" +
    "  Open System Settings > Notifications > AO Notifier and enable Allow Notifications.\n" +
    "  Then rerun: ao setup desktop --force"
  );
}

function readConfigContext(): DesktopConfigContext {
  const configPath = findOptionalConfigPath();
  if (!configPath) {
    return {
      configPath,
      rawConfig: {},
      existingDesktop: {},
    };
  }

  const rawYaml = readFileSync(configPath, "utf-8");
  const rawConfig = (parseDocument(rawYaml).toJS() as Record<string, unknown>) ?? {};
  const notifiers = (rawConfig["notifiers"] as Record<string, unknown> | undefined) ?? {};
  const existingDesktop = (notifiers["desktop"] as Record<string, unknown> | undefined) ?? {};
  return {
    configPath,
    rawConfig,
    existingDesktop,
  };
}

function printStatus(): void {
  const os = currentPlatform();
  const appPath = getInstalledNotifierAppPath();
  const installed = isAppInstalled(appPath);
  const version = installed ? execNotifierJson(appPath, ["--version-json"]) : null;
  const permission = installed ? execNotifierJson(appPath, ["--permission-status-json"]) : null;
  const context = readConfigContext();
  const configBackend = stringValue(context.existingDesktop["backend"]);
  const configDashboardUrl = stringValue(context.existingDesktop["dashboardUrl"]);
  const configAppPath = stringValue(context.existingDesktop["appPath"]);

  console.log(chalk.bold("AO desktop notifier"));
  console.log(`  platform: ${os}`);
  if (context.configPath) {
    console.log(`  config: ${context.configPath}`);
  }
  console.log(`  config backend: ${configBackend ?? "not configured"}`);
  console.log(`  dashboardUrl: ${configDashboardUrl ?? "not configured"}`);
  console.log(`  config appPath: ${configAppPath ?? "not configured"}`);
  console.log(
    `  terminal-notifier: ${commandExists("terminal-notifier") ? "available" : "missing"}`,
  );
  console.log(`  osascript: ${commandExists("osascript") ? "available" : "missing"}`);
  console.log(`  installed: ${installed ? "yes" : "no"}`);
  console.log(`  app: ${appPath}`);
  console.log(`  routing: ${getNotifierRoutingState(context.rawConfig, "desktop").label}`);
  if (version?.["version"]) {
    console.log(`  version: ${String(version["version"])}`);
  }
  if (permission?.["status"]) {
    console.log(`  permissions: ${String(permission["status"])}`);
  }
}

function copyBundledApp(targetAppPath = getInstalledNotifierAppPath()): string {
  if (currentPlatform() !== "darwin") {
    throw new DesktopSetupError("ao setup desktop is currently only supported on macOS.");
  }

  const sourceAppPath = getBundledNotifierAppPath();
  if (!sourceAppPath || !existsSync(getNotifierExecutablePath(sourceAppPath))) {
    throw new DesktopSetupError(
      "AO Notifier.app is not built. Run: pnpm --filter @aoagents/ao-notifier-macos build",
    );
  }

  if (isPlaceholderNotifierApp(sourceAppPath)) {
    throw new DesktopSetupError(
      "AO Notifier.app was built as a non-macOS placeholder and cannot be installed. " +
        "Rebuild @aoagents/ao-notifier-macos on macOS, or use --backend terminal-notifier.",
    );
  }

  mkdirSync(dirname(targetAppPath), { recursive: true });
  rmSync(targetAppPath, { recursive: true, force: true });
  cpSync(sourceAppPath, targetAppPath, { recursive: true });

  if (!isAppInstalled(targetAppPath)) {
    throw new DesktopSetupError(`AO Notifier.app install failed at ${targetAppPath}`);
  }

  return targetAppPath;
}

function requestPermission(appPath: string): void {
  let result: JsonRecord | null;

  try {
    const output = execFileSync(getNotifierExecutablePath(appPath), ["--request-permission"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    result = parseJsonOutput(output);
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown };
    result = parseJsonOutput(failure.stdout);
    if (result?.["status"] === "denied") {
      throw new DesktopSetupError(permissionDeniedMessage());
    }

    const stderr = Buffer.isBuffer(failure.stderr)
      ? failure.stderr.toString("utf-8").trim()
      : String(failure.stderr ?? "").trim();
    throw new DesktopSetupError(
      `Could not request macOS notification permission: ${stderr || formatExecError(error)}`,
    );
  }

  if (result?.["status"] === "denied") {
    throw new DesktopSetupError(permissionDeniedMessage());
  }
}

function sendAoAppSetupNotification(appPath: string, dashboardUrl?: string): void {
  const payload = {
    title: "AO Notifier",
    body: "Desktop notifications are ready.",
    sound: false,
    defaultOpenUrl: dashboardUrl,
    event: {
      id: `desktop-setup-${Date.now()}`,
      type: "setup.desktop",
      priority: "info",
      sessionId: "setup",
      projectId: "ao",
      timestamp: new Date().toISOString(),
    },
    actions: dashboardUrl ? [{ label: "Open Dashboard", url: dashboardUrl }] : [],
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
  try {
    execFileSync(getNotifierExecutablePath(appPath), ["--notify-base64", encoded], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as { stderr?: unknown };
    const stderr = Buffer.isBuffer(failure.stderr)
      ? failure.stderr.toString("utf-8").trim()
      : String(failure.stderr ?? "").trim();
    throw new DesktopSetupError(
      `Could not send desktop setup test notification: ${stderr || formatExecError(error)}`,
    );
  }
}

function sendTerminalNotifierSetupNotification(dashboardUrl?: string): void {
  const args = ["-title", "AO Notifier", "-message", "Desktop notifications are ready."];
  if (dashboardUrl) args.push("-open", dashboardUrl);
  execFileSync("terminal-notifier", args, { stdio: ["ignore", "pipe", "pipe"] });
}

function sendOsascriptSetupNotification(): void {
  execFileSync(
    "osascript",
    ["-e", 'display notification "Desktop notifications are ready." with title "AO Notifier"'],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

function findOptionalConfigPath(): string | undefined {
  try {
    return findConfigFile() ?? undefined;
  } catch {
    return undefined;
  }
}

async function shouldReplaceConflictingDesktop(
  existingPlugin: unknown,
  force: boolean,
  nonInteractive: boolean,
): Promise<boolean> {
  if (existingPlugin === undefined || existingPlugin === "desktop" || force) return true;
  if (nonInteractive) {
    throw new DesktopSetupError(
      `notifiers.desktop already uses plugin "${String(existingPlugin)}". Re-run with --force to replace it.`,
    );
  }

  const clack = await import("@clack/prompts");
  const replace = await clack.confirm({
    message: `notifiers.desktop already uses plugin "${String(existingPlugin)}". Replace it?`,
    initialValue: false,
  });

  if (clack.isCancel(replace) || !replace) {
    console.log(chalk.dim("Keeping existing desktop notifier config."));
    return false;
  }

  return true;
}

function dashboardUrlFromConfig(rawConfig: Record<string, unknown>): string | undefined {
  const port = rawConfig["port"];
  if (typeof port === "number") return `http://localhost:${port}`;
  if (typeof port === "string" && port.trim().length > 0) return `http://localhost:${port.trim()}`;
  return undefined;
}

async function chooseDesktopBackend(
  existingBackend: DesktopBackend | undefined,
  nonInteractive: boolean,
): Promise<DesktopBackend> {
  if (nonInteractive) return existingBackend ?? "ao-app";

  const clack = await import("@clack/prompts");
  const choice = await clack.select({
    message: "Choose the desktop notification backend:",
    options: [
      {
        value: "ao-app",
        label:
          existingBackend === "ao-app"
            ? "AO Notifier.app (current)"
            : "AO Notifier.app (recommended)",
        hint: "Native macOS app with actions and AO-specific behavior",
      },
      {
        value: "auto",
        label: existingBackend === "auto" ? "Auto fallback (current)" : "Auto fallback",
        hint: "AO app if installed, then terminal-notifier, then osascript",
      },
      {
        value: "terminal-notifier",
        label:
          existingBackend === "terminal-notifier"
            ? "terminal-notifier (current)"
            : "terminal-notifier",
        hint: "Requires Homebrew package; supports click-to-open",
      },
      {
        value: "osascript",
        label: existingBackend === "osascript" ? "osascript (current)" : "osascript",
        hint: "Built into macOS; basic notifications only",
      },
    ],
  });

  if (clack.isCancel(choice)) {
    clack.cancel("Setup cancelled.");
    throw new DesktopSetupError("Setup cancelled.", 0);
  }

  return choice as DesktopBackend;
}

function resolveDashboardUrl(
  opts: DesktopSetupOptions,
  rawConfig: Record<string, unknown>,
  existingDesktop: Record<string, unknown>,
): string | undefined {
  return (
    stringValue(opts.dashboardUrl) ??
    dashboardUrlFromConfig(rawConfig) ??
    stringValue(existingDesktop["dashboardUrl"])
  );
}

async function maybeInstallTerminalNotifier(nonInteractive: boolean): Promise<void> {
  if (commandExists("terminal-notifier")) return;

  if (nonInteractive) {
    throw new DesktopSetupError(
      "terminal-notifier is not installed. Install it with: brew install terminal-notifier",
    );
  }

  const clack = await import("@clack/prompts");
  const install = await clack.confirm({
    message: "terminal-notifier is not installed. Install it with Homebrew now?",
    initialValue: true,
  });

  if (clack.isCancel(install) || !install) {
    throw new DesktopSetupError(
      "terminal-notifier is required for this backend. Install it with: brew install terminal-notifier",
    );
  }

  try {
    execFileSync("brew", ["install", "terminal-notifier"], { stdio: "inherit" });
  } catch (error) {
    throw new DesktopSetupError(
      `Could not install terminal-notifier with Homebrew: ${formatExecError(error)}`,
    );
  }
}

function assertOsascriptAvailable(): void {
  if (!commandExists("osascript")) {
    throw new DesktopSetupError("osascript is not available on this system.");
  }
}

function resolveAutoBackend(appPath: string): DesktopBackend {
  if (currentPlatform() === "darwin" && isAppInstalled(appPath)) return "ao-app";
  if (commandExists("terminal-notifier")) return "terminal-notifier";
  if (commandExists("osascript")) return "osascript";
  throw new DesktopSetupError(
    "No desktop notification backend is available. Run `ao setup desktop --backend ao-app`, or install terminal-notifier.",
  );
}

async function resolveDesktopSetup(
  opts: DesktopSetupOptions,
  context: DesktopConfigContext,
  nonInteractive: boolean,
): Promise<ResolvedDesktopSetup> {
  const explicitBackend = parseDesktopBackend(opts.backend);
  const existingBackend = parseDesktopBackend(context.existingDesktop["backend"]);
  const optionRoutingPreset = resolveDesktopRoutingPreset(opts.routingPreset);

  while (true) {
    const backend =
      explicitBackend ??
      (await chooseDesktopBackend(opts.refresh ? existingBackend : undefined, nonInteractive));
    const appPath =
      stringValue(opts.appPath) ??
      stringValue(context.existingDesktop["appPath"]) ??
      getInstalledNotifierAppPath();
    const routingSelection =
      optionRoutingPreset ??
      (nonInteractive || !context.configPath
        ? opts.refresh
          ? undefined
          : "all"
        : await promptNotifierRoutingPreset(
            await import("@clack/prompts"),
            context.rawConfig,
            "desktop",
            "desktop",
            () => {
              throw new DesktopSetupError("Setup cancelled.", 0);
            },
          ));

    if (routingSelection === "back") continue;

    return {
      backend,
      dashboardUrl: resolveDashboardUrl(opts, context.rawConfig, context.existingDesktop),
      appPath,
      shouldWriteAppPath:
        Boolean(stringValue(opts.appPath)) ||
        stringValue(context.existingDesktop["appPath"]) !== undefined,
      shouldSendTest: opts.test !== false,
      refresh: Boolean(opts.refresh),
      routingPreset: routingSelection === "preserve" ? undefined : routingSelection,
    };
  }
}

function resolveDesktopRoutingPreset(value: string | undefined): NotifierRoutingPreset | undefined {
  try {
    return resolveRoutingPresetOption(value, "desktop") as NotifierRoutingPreset | undefined;
  } catch (error) {
    throw new DesktopSetupError(error instanceof Error ? error.message : String(error));
  }
}

async function prepareDesktopBackend(
  resolved: ResolvedDesktopSetup,
  force: boolean,
  nonInteractive: boolean,
): Promise<DesktopBackend> {
  if (currentPlatform() !== "darwin") {
    throw new DesktopSetupError("ao setup desktop is currently only supported on macOS.");
  }

  if (resolved.backend === "ao-app") {
    const shouldInstall = !resolved.refresh || force || !isAppInstalled(resolved.appPath);
    if (shouldInstall) {
      const appPath = copyBundledApp(resolved.appPath);
      console.log(chalk.green(`✓ Installed ${APP_NAME} to ${appPath}`));
    } else {
      console.log(chalk.green(`✓ ${APP_NAME} is installed at ${resolved.appPath}`));
    }
    requestPermission(resolved.appPath);
    console.log(chalk.green("✓ Notification permission checked"));
    return "ao-app";
  }

  if (resolved.backend === "terminal-notifier") {
    await maybeInstallTerminalNotifier(nonInteractive);
    console.log(chalk.green("✓ terminal-notifier is available"));
    return "terminal-notifier";
  }

  if (resolved.backend === "osascript") {
    assertOsascriptAvailable();
    console.log(chalk.green("✓ osascript is available"));
    return "osascript";
  }

  const effectiveBackend = resolveAutoBackend(resolved.appPath);
  if (effectiveBackend === "ao-app") {
    requestPermission(resolved.appPath);
    console.log(chalk.green(`✓ auto backend resolved to ${APP_NAME}`));
  } else if (effectiveBackend === "terminal-notifier") {
    console.log(chalk.green("✓ auto backend resolved to terminal-notifier"));
  } else {
    console.log(chalk.green("✓ auto backend resolved to osascript"));
  }
  return effectiveBackend;
}

function sendBackendSetupNotification(
  effectiveBackend: DesktopBackend,
  resolved: ResolvedDesktopSetup,
): void {
  try {
    if (effectiveBackend === "ao-app") {
      sendAoAppSetupNotification(resolved.appPath, resolved.dashboardUrl);
    } else if (effectiveBackend === "terminal-notifier") {
      sendTerminalNotifierSetupNotification(resolved.dashboardUrl);
    } else if (effectiveBackend === "osascript") {
      sendOsascriptSetupNotification();
    }
  } catch (error) {
    throw new DesktopSetupError(
      `Could not send desktop setup test notification: ${formatExecError(error)}`,
    );
  }
}

async function wireDesktopConfig(
  configPath: string | undefined,
  force: boolean,
  nonInteractive: boolean,
  resolved: ResolvedDesktopSetup,
  conflictAlreadyChecked = false,
): Promise<boolean> {
  if (!configPath) {
    console.log(chalk.dim("No agent-orchestrator.yaml found; skipping config wiring."));
    return false;
  }

  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};
  const notifiers = (rawConfig["notifiers"] as Record<string, unknown> | undefined) ?? {};
  const existingDesktop = (notifiers["desktop"] as Record<string, unknown> | undefined) ?? {};

  if (
    !conflictAlreadyChecked &&
    !(await shouldReplaceConflictingDesktop(existingDesktop["plugin"], force, nonInteractive))
  ) {
    return false;
  }

  const desktopConfig: Record<string, unknown> = {
    ...existingDesktop,
    plugin: "desktop",
    backend: resolved.backend,
  };
  if (resolved.dashboardUrl) desktopConfig["dashboardUrl"] = resolved.dashboardUrl;
  if (resolved.shouldWriteAppPath) desktopConfig["appPath"] = resolved.appPath;

  notifiers["desktop"] = desktopConfig;
  rawConfig["notifiers"] = notifiers;

  const defaults = (rawConfig["defaults"] as Record<string, unknown> | undefined) ?? {};
  rawConfig["defaults"] = defaults;

  applyNotifierRoutingPreset(rawConfig, "desktop", resolved.routingPreset);

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
  console.log(chalk.green(`✓ Config written to ${configPath}`));
  return true;
}

async function canWireDesktopConfig(
  configPath: string | undefined,
  force: boolean,
  nonInteractive: boolean,
): Promise<boolean> {
  if (!configPath) return false;
  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};
  const notifiers = (rawConfig["notifiers"] as Record<string, unknown> | undefined) ?? {};
  const existingDesktop = (notifiers["desktop"] as Record<string, unknown> | undefined) ?? {};
  return shouldReplaceConflictingDesktop(existingDesktop["plugin"], force, nonInteractive);
}

function uninstallDesktopApp(): void {
  const appPath = getInstalledNotifierAppPath();
  rmSync(appPath, { recursive: true, force: true });
  console.log(chalk.green(`✓ Removed ${appPath}`));
  console.log(chalk.dim("AO config was not changed."));
}

export async function runDesktopSetupAction(opts: DesktopSetupOptions): Promise<void> {
  const nonInteractive = opts.nonInteractive || !process.stdin.isTTY;
  const force = Boolean(opts.force);

  if (opts.status) {
    printStatus();
    return;
  }

  if (opts.uninstall) {
    uninstallDesktopApp();
    return;
  }

  const context = readConfigContext();
  const shouldWireConfig = await canWireDesktopConfig(context.configPath, force, nonInteractive);
  if (context.configPath && !shouldWireConfig) {
    console.log(chalk.dim("Skipped config wiring."));
    return;
  }

  const resolved = await resolveDesktopSetup(opts, context, nonInteractive);
  const effectiveBackend = await prepareDesktopBackend(resolved, force, nonInteractive);

  if (resolved.shouldSendTest) {
    sendBackendSetupNotification(effectiveBackend, resolved);
    console.log(chalk.green("✓ Sent desktop setup test notification"));
  } else {
    console.log(chalk.dim("Skipped desktop setup test notification."));
  }

  if (shouldWireConfig) {
    await wireDesktopConfig(context.configPath, force, nonInteractive, resolved, true);
  } else if (!context.configPath) {
    console.log(chalk.dim("No agent-orchestrator.yaml found; skipping config wiring."));
  } else {
    console.log(chalk.dim("Skipped config wiring."));
  }

  if (!nonInteractive) {
    const clack = await import("@clack/prompts");
    clack.outro(
      `${chalk.green("Desktop setup complete!")} AO will use ${resolved.backend} for desktop notifications.\n` +
        chalk.dim("  Test it with: ao notify test --to desktop --template basic"),
    );
  } else {
    console.log(chalk.green("\n✓ Desktop setup complete."));
    console.log(chalk.dim("Test it with: ao notify test --to desktop --template basic"));
  }
}
