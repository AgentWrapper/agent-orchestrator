import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import {
  DEFAULT_OPENCLAW_URL,
  HOOKS_PATH,
  detectOpenClawInstallation,
  probeGateway,
  validateToken,
} from "./openclaw-probe.js";

export type OpenClawRoutingPreset = NotifierRoutingPreset;

export interface OpenClawSetupOptions {
  url?: string;
  token?: string;
  openclawConfigPath?: string;
  nonInteractive?: boolean;
  routingPreset?: OpenClawRoutingPreset;
  refresh?: boolean;
  status?: boolean;
  test?: boolean;
  force?: boolean;
}

interface ConfigContext {
  configPath: string;
  rawConfig: Record<string, unknown>;
}

interface TokenInfo {
  value: string;
  source: "cli" | "env" | "yaml" | "openclaw-config" | "manual";
  configPath: string;
}

interface ResolvedOpenClawSetup {
  url: string;
  token: string;
  openclawConfigPath: string;
  routingPreset?: OpenClawRoutingPreset;
  shouldSendTest: boolean;
  tokenSource: TokenInfo["source"];
}

const DEFAULT_OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");
const DISPLAY_OPENCLAW_CONFIG_PATH = "~/.openclaw/openclaw.json";

export class OpenClawSetupError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "OpenClawSetupError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeOpenClawHooksUrl(url: string): string {
  const normalized = url.trim().replace(/\/+$/, "");
  return normalized.endsWith(HOOKS_PATH) ? normalized : `${normalized}${HOOKS_PATH}`;
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function displayOpenClawConfigPath(path: string): string {
  const expanded = expandHomePath(path);
  return expanded === DEFAULT_OPENCLAW_CONFIG_PATH ? DISPLAY_OPENCLAW_CONFIG_PATH : path;
}

function validateOpenClawUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OpenClawSetupError("OpenClaw webhook URL is invalid.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OpenClawSetupError("OpenClaw webhook URL must start with http:// or https://.");
  }
}

function readConfigContext(): ConfigContext {
  const configPath = findConfigFile() ?? undefined;
  if (!configPath) {
    throw new OpenClawSetupError(
      "No agent-orchestrator.yaml found. Run 'ao start' first to create one.",
    );
  }

  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};
  return { configPath, rawConfig };
}

function getExistingOpenClaw(rawConfig: Record<string, unknown>): Record<string, unknown> {
  const notifiers = isRecord(rawConfig["notifiers"]) ? rawConfig["notifiers"] : {};
  const existing = notifiers["openclaw"];
  return isRecord(existing) ? existing : {};
}

function getOpenClawJsonPath(): string {
  return DEFAULT_OPENCLAW_CONFIG_PATH;
}

function readOpenClawJson(configPath: string = DEFAULT_OPENCLAW_CONFIG_PATH): {
  path: string;
  exists: boolean;
  config: Record<string, unknown>;
  token?: string;
} {
  const path = expandHomePath(configPath);
  try {
    if (!existsSync(path)) return { path, exists: false, config: {} };
    const config = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const hooks = isRecord(config["hooks"]) ? config["hooks"] : {};
    return {
      path,
      exists: true,
      config,
      token: stringValue(hooks["token"]),
    };
  } catch {
    return { path, exists: existsSync(path), config: {} };
  }
}

function getConfiguredOpenClawConfigPath(
  opts: OpenClawSetupOptions,
  existingOpenClaw: Record<string, unknown>,
): string {
  return (
    stringValue(opts.openclawConfigPath) ??
    stringValue(existingOpenClaw["openclawConfigPath"]) ??
    stringValue(existingOpenClaw["configPath"]) ??
    getOpenClawJsonPath()
  );
}

function resolveConfiguredToken(
  existingOpenClaw: Record<string, unknown>,
  openclawConfigPath: string,
): TokenInfo | undefined {
  const openclawJson = readOpenClawJson(openclawConfigPath);
  if (openclawJson.token) {
    return {
      value: openclawJson.token,
      source: "openclaw-config",
      configPath: openclawJson.path,
    };
  }

  const rawYamlToken = stringValue(existingOpenClaw["token"]);
  if (rawYamlToken) {
    const envVarMatch = rawYamlToken.match(/^\$\{([^}]+)\}$/);
    if (envVarMatch) {
      const envValue = process.env[envVarMatch[1]];
      if (envValue) return { value: envValue, source: "env", configPath: openclawJson.path };
    } else {
      return { value: rawYamlToken, source: "yaml", configPath: openclawJson.path };
    }
  }

  const envToken = process.env["OPENCLAW_HOOKS_TOKEN"];
  if (envToken) return { value: envToken, source: "env", configPath: openclawJson.path };

  return undefined;
}

async function shouldReplaceConflictingOpenClaw(
  existingPlugin: unknown,
  force: boolean,
  nonInteractive: boolean,
): Promise<boolean> {
  if (existingPlugin === undefined || existingPlugin === "openclaw" || force) return true;
  if (nonInteractive) {
    throw new OpenClawSetupError(
      `notifiers.openclaw already uses plugin "${String(existingPlugin)}". Re-run with --force to replace it.`,
    );
  }

  const clack = await import("@clack/prompts");
  const replace = await clack.confirm({
    message: `notifiers.openclaw already uses plugin "${String(existingPlugin)}". Replace it?`,
    initialValue: false,
  });

  if (clack.isCancel(replace) || !replace) {
    console.log(chalk.dim("Keeping existing OpenClaw notifier config."));
    return false;
  }

  return true;
}

function cancelSetup(clack: ClackPrompts): never {
  clack.cancel("Setup cancelled.");
  throw new OpenClawSetupError("Setup cancelled.", 0);
}

function printOpenClawStartInstructions(): void {
  console.log("");
  console.log(chalk.bold("Start or install OpenClaw"));
  console.log("  1. Start your local OpenClaw gateway.");
  console.log("  2. Confirm the gateway URL. The default is http://127.0.0.1:18789.");
  console.log("  3. Paste the hooks URL here. AO will normalize it to /hooks/agent.");
  console.log(chalk.dim("If OpenClaw runs elsewhere, use that machine's gateway URL."));
  console.log("");
}

function printOpenClawTokenInstructions(openclawConfigPath: string): void {
  const displayPath = displayOpenClawConfigPath(openclawConfigPath);
  console.log("");
  console.log(chalk.bold("Configure the OpenClaw hooks token"));
  console.log(`  1. Open your OpenClaw config: ${displayPath}`);
  console.log("  2. In OpenClaw's webhook/hooks settings, create or copy the hooks token.");
  console.log("  3. Put that token in hooks.token and make sure hooks are enabled:");
  console.log("");
  console.log(
    chalk.cyan(`{
  "hooks": {
    "enabled": true,
    "token": "<openclaw-hooks-token>",
    "allowRequestSessionKey": true,
    "allowedSessionKeyPrefixes": ["hook:"]
  }
}`),
  );
  console.log("");
  console.log(
    chalk.dim(
      "OpenClaw requires this shared secret for POST /hooks/agent. AO reads it from the OpenClaw config and does not generate or store it in your shell profile.",
    ),
  );
  console.log(chalk.dim("Restart OpenClaw after changing the config."));
  console.log("");
}

async function promptOpenClawUrl(
  clack: ClackPrompts,
  initialValue: string | undefined,
): Promise<string> {
  const urlInput = await clack.text({
    message: "OpenClaw webhook URL:",
    placeholder: `${DEFAULT_OPENCLAW_URL}${HOOKS_PATH}`,
    initialValue,
    validate: (value) => {
      if (!value) return "OpenClaw webhook URL is required";
      try {
        validateOpenClawUrl(normalizeOpenClawHooksUrl(String(value)));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });

  if (clack.isCancel(urlInput)) {
    cancelSetup(clack);
  }

  return normalizeOpenClawHooksUrl(String(urlInput));
}

async function promptAfterOpenClawInstructions(
  clack: ClackPrompts,
  initialValue: string | undefined,
): Promise<string | "back"> {
  printOpenClawStartInstructions();

  while (true) {
    const next = await clack.select({
      message: "What do you want to do next?",
      options: [
        {
          value: "enter-url",
          label: "Enter OpenClaw URL",
          hint: "Paste the local or remote gateway URL",
        },
        {
          value: "back",
          label: "Back",
          hint: "Return to the previous menu",
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
    if (next === "enter-url") return promptOpenClawUrl(clack, initialValue);
  }
}

async function resolveInteractiveUrl(
  clack: ClackPrompts,
  opts: OpenClawSetupOptions,
  existingUrl: string | undefined,
): Promise<string> {
  const providedUrl = stringValue(opts.url);
  if (providedUrl) {
    const normalized = normalizeOpenClawHooksUrl(providedUrl);
    validateOpenClawUrl(normalized);
    return normalized;
  }

  const defaultHooksUrl = `${DEFAULT_OPENCLAW_URL}${HOOKS_PATH}`;
  let detectedUrl: string | undefined;
  const spin = clack.spinner();
  spin.start("Detecting OpenClaw gateway on localhost...");
  const probe = await probeGateway(DEFAULT_OPENCLAW_URL);
  if (probe.reachable) {
    detectedUrl = defaultHooksUrl;
    spin.stop(`Found OpenClaw gateway at ${DEFAULT_OPENCLAW_URL}`);
  } else {
    spin.stop("No OpenClaw gateway detected on localhost");
  }

  while (true) {
    const source = existingUrl
      ? await clack.select({
          message: "OpenClaw notifier is already configured. What do you want to do?",
          options: [
            {
              value: "use-existing",
              label: "Use existing gateway URL",
              hint: existingUrl,
            },
            {
              value: "change-url",
              label: "Change gateway URL",
              hint: "Paste a different OpenClaw gateway URL",
            },
            {
              value: "use-local",
              label: "Use local default URL",
              hint: defaultHooksUrl,
            },
            {
              value: "need-openclaw",
              label: "Show OpenClaw setup steps",
              hint: "AO will print the local gateway requirements",
            },
            {
              value: "cancel",
              label: "Cancel setup",
              hint: "Do not change config",
            },
          ],
        })
      : await clack.select({
          message: "How do you want to point AO at OpenClaw?",
          options: [
            {
              value: "use-local",
              label: probe.reachable ? "Use detected local gateway" : "Use local default URL",
              hint: detectedUrl ?? defaultHooksUrl,
            },
            {
              value: "change-url",
              label: "Enter a different URL",
              hint: "Use this when OpenClaw runs elsewhere",
            },
            {
              value: "need-openclaw",
              label: "Show OpenClaw setup steps",
              hint: "AO will print the local gateway requirements",
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

    if (source === "use-existing" && existingUrl) return normalizeOpenClawHooksUrl(existingUrl);
    if (source === "use-local") return detectedUrl ?? defaultHooksUrl;
    if (source === "change-url") return promptOpenClawUrl(clack, existingUrl ?? detectedUrl);
    if (source === "need-openclaw") {
      const result = await promptAfterOpenClawInstructions(clack, existingUrl ?? detectedUrl);
      if (result === "back") continue;
      return result;
    }
  }
}

async function resolveInteractiveToken(
  clack: ClackPrompts,
  opts: OpenClawSetupOptions,
  existingOpenClaw: Record<string, unknown>,
  initialOpenClawConfigPath: string,
): Promise<TokenInfo | "back"> {
  const providedToken = stringValue(opts.token);
  if (providedToken) {
    return { value: providedToken, source: "cli", configPath: expandHomePath(initialOpenClawConfigPath) };
  }

  let openclawConfigPath = initialOpenClawConfigPath;
  while (true) {
    const existingToken = resolveConfiguredToken(existingOpenClaw, openclawConfigPath);
    const options = [
      ...(existingToken
        ? [
            {
              value: "use-existing",
              label: `Use existing token from ${existingToken.source}`,
              hint:
                existingToken.source === "openclaw-config"
                  ? displayOpenClawConfigPath(existingToken.configPath)
                  : "Legacy fallback; AO will not write shell exports",
            },
          ]
        : []),
      {
        value: "check-config",
        label: existingToken ? "Check OpenClaw config again" : "I added hooks.token to OpenClaw config",
        hint: displayOpenClawConfigPath(openclawConfigPath),
      },
      {
        value: "show-steps",
        label: "Show where to configure the token",
        hint: "Print OpenClaw-side config steps",
      },
      {
        value: "manual",
        label: "Enter token manually",
        hint: "For remote OpenClaw only; AO stores it in agent-orchestrator.yaml",
      },
      {
        value: "config-path",
        label: "Use a different OpenClaw config path",
        hint: "Read hooks.token from another local OpenClaw config",
      },
      {
        value: "back",
        label: "Back",
        hint: "Return to gateway URL",
      },
      {
        value: "cancel",
        label: "Cancel setup",
        hint: "Do not change config",
      },
    ];

    const choice = await clack.select({
      message: "How should AO configure the OpenClaw hooks token?",
      options,
    });

    if (clack.isCancel(choice) || choice === "cancel") {
      cancelSetup(clack);
    }

    if (choice === "back") return "back";
    if (choice === "use-existing" && existingToken) return existingToken;
    if (choice === "check-config") {
      const refreshedToken = resolveConfiguredToken(existingOpenClaw, openclawConfigPath);
      if (refreshedToken) return refreshedToken;
      clack.log.warn(
        `No hooks.token found in ${displayOpenClawConfigPath(openclawConfigPath)} yet.`,
      );
      continue;
    }
    if (choice === "show-steps") {
      printOpenClawTokenInstructions(openclawConfigPath);
      continue;
    }
    if (choice === "config-path") {
      const pathInput = await clack.text({
        message: "OpenClaw config path:",
        placeholder: DISPLAY_OPENCLAW_CONFIG_PATH,
        initialValue: displayOpenClawConfigPath(openclawConfigPath),
        validate: (value) => (!value ? "OpenClaw config path is required" : undefined),
      });
      if (clack.isCancel(pathInput)) {
        cancelSetup(clack);
      }
      openclawConfigPath = String(pathInput);
      continue;
    }
    if (choice === "manual") {
      const input = await clack.password({
        message: "OpenClaw hooks token:",
        validate: (value) => (!value ? "Token is required" : undefined),
      });
      if (clack.isCancel(input)) {
        cancelSetup(clack);
      }
      return { value: String(input), source: "manual", configPath: expandHomePath(openclawConfigPath) };
    }
  }
}

async function resolveInteractiveRoutingPreset(
  clack: ClackPrompts,
  opts: OpenClawSetupOptions,
  rawConfig: Record<string, unknown>,
): Promise<OpenClawRoutingPreset | undefined | "back"> {
  const optionPreset = resolveOpenClawRoutingPreset(opts.routingPreset);
  if (optionPreset) return optionPreset;

  const selection = await promptNotifierRoutingPreset(
    clack,
    rawConfig,
    "openclaw",
    "OpenClaw",
    () => cancelSetup(clack),
  );
  if (selection === "preserve") return undefined;
  return selection;
}

function resolveOpenClawRoutingPreset(value: string | undefined): OpenClawRoutingPreset | undefined {
  try {
    return resolveRoutingPresetOption(value, "OpenClaw") as OpenClawRoutingPreset | undefined;
  } catch (error) {
    throw new OpenClawSetupError(error instanceof Error ? error.message : String(error));
  }
}

function printReview(resolved: ResolvedOpenClawSetup): void {
  console.log("");
  console.log(chalk.bold("OpenClaw setup review"));
  console.log(`  Webhook URL: ${resolved.url}`);
  console.log(`  Token: configured from ${resolved.tokenSource}`);
  console.log(`  OpenClaw config: ${displayOpenClawConfigPath(resolved.openclawConfigPath)}`);
  console.log(`  Routing: ${resolved.routingPreset ? routingLabel(resolved.routingPreset) : "unchanged"}`);
  console.log(`  Setup probe: ${resolved.shouldSendTest ? "enabled" : "skipped"}`);
  console.log("");
}

async function promptInteractiveReview(
  clack: ClackPrompts,
  resolved: ResolvedOpenClawSetup,
): Promise<"save" | "url" | "token" | "routing"> {
  printReview(resolved);
  const choice = await clack.select({
    message: "Save this OpenClaw setup?",
    options: [
      { value: "save", label: "Save setup" },
      { value: "url", label: "Change gateway URL" },
      { value: "token", label: "Change token" },
      { value: "routing", label: "Change routing" },
      { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
    ],
  });

  if (clack.isCancel(choice) || choice === "cancel") {
    cancelSetup(clack);
  }

  return choice as "save" | "url" | "token" | "routing";
}

async function resolveInteractiveSetup(
  opts: OpenClawSetupOptions,
  existingOpenClaw: Record<string, unknown>,
  rawConfig: Record<string, unknown>,
): Promise<ResolvedOpenClawSetup> {
  const clack = await import("@clack/prompts");
  const existingUrl = stringValue(existingOpenClaw["url"]);
  const initialOpenClawConfigPath = getConfiguredOpenClawConfigPath(opts, existingOpenClaw);

  clack.intro(chalk.bgCyan(chalk.black(" ao setup openclaw ")));

  let url: string | undefined;
  let tokenInfo: TokenInfo | undefined;
  let routingPreset: OpenClawRoutingPreset | undefined;
  let step: "url" | "token" | "routing" | "review" = "url";

  while (true) {
    if (step === "url") {
      url = await resolveInteractiveUrl(clack, opts, existingUrl);
      step = "token";
    }

    if (step === "token") {
      const selectedTokenInfo = await resolveInteractiveToken(
        clack,
        opts,
        existingOpenClaw,
        tokenInfo?.configPath ?? initialOpenClawConfigPath,
      );
      if (selectedTokenInfo === "back") {
        step = "url";
        continue;
      }
      tokenInfo = selectedTokenInfo;
      step = "routing";
    }

    if (step === "routing") {
      const selectedRoutingPreset = await resolveInteractiveRoutingPreset(
        clack,
        opts,
        rawConfig,
      );
      if (selectedRoutingPreset === "back") {
        step = "token";
        continue;
      }
      routingPreset = selectedRoutingPreset;
      step = "review";
    }

    if (step === "review") {
      const resolved = {
        url: url ?? `${DEFAULT_OPENCLAW_URL}${HOOKS_PATH}`,
        token: tokenInfo?.value ?? "",
        openclawConfigPath: tokenInfo?.configPath ?? expandHomePath(initialOpenClawConfigPath),
        routingPreset,
        shouldSendTest: opts.test !== false,
        tokenSource: tokenInfo?.source ?? "manual",
      } satisfies ResolvedOpenClawSetup;

      const next = await promptInteractiveReview(clack, resolved);
      if (next === "save") return resolved;
      step = next;
    }
  }
}

async function resolveNonInteractiveSetup(
  opts: OpenClawSetupOptions,
  existingOpenClaw: Record<string, unknown>,
  _rawConfig: Record<string, unknown>,
): Promise<ResolvedOpenClawSetup> {
  let rawUrl =
    stringValue(opts.url) ??
    process.env["OPENCLAW_GATEWAY_URL"] ??
    (opts.refresh ? stringValue(existingOpenClaw["url"]) : undefined);

  if (!rawUrl) {
    const installation = await detectOpenClawInstallation();
    if (installation.state === "running") {
      rawUrl = `${installation.gatewayUrl}${HOOKS_PATH}`;
      console.log(chalk.dim(`Auto-detected OpenClaw gateway at ${installation.gatewayUrl}`));
    } else {
      throw new OpenClawSetupError(
        "Error: OpenClaw gateway not reachable and no --url provided.\n" +
          "  Start OpenClaw first, or pass --url explicitly:\n" +
          "  Example: ao setup openclaw --url http://127.0.0.1:18789/hooks/agent --openclaw-config-path ~/.openclaw/openclaw.json --non-interactive",
      );
    }
  }

  const url = normalizeOpenClawHooksUrl(rawUrl);
  validateOpenClawUrl(url);

  const openclawConfigPath = getConfiguredOpenClawConfigPath(opts, existingOpenClaw);
  const configuredToken = resolveConfiguredToken(existingOpenClaw, openclawConfigPath);
  const tokenInfo =
    stringValue(opts.token) !== undefined
      ? ({
          value: stringValue(opts.token) as string,
          source: "cli",
          configPath: expandHomePath(openclawConfigPath),
        } satisfies TokenInfo)
      : configuredToken;

  if (!tokenInfo) {
    throw new OpenClawSetupError(
      `No OpenClaw hooks token found in ${displayOpenClawConfigPath(openclawConfigPath)}.\n` +
        "  Generate or copy the hooks token from OpenClaw, put it in hooks.token, then rerun setup.\n" +
        `  Config example: ${displayOpenClawConfigPath(openclawConfigPath)} -> hooks.token\n` +
        "  For remote OpenClaw only, pass --token explicitly.",
    );
  }

  console.log(chalk.dim("Skipping setup probe in non-interactive mode. Run `ao setup openclaw --status` to verify."));

  const routingPreset = resolveOpenClawRoutingPreset(opts.routingPreset) ?? (opts.refresh ? undefined : "urgent-action");

  return {
    url,
    token: tokenInfo.value,
    openclawConfigPath: tokenInfo.configPath,
    routingPreset,
    shouldSendTest: opts.test !== false,
    tokenSource: tokenInfo.source,
  };
}

function writeOpenClawConfig(
  configPath: string,
  resolved: ResolvedOpenClawSetup,
  nonInteractive: boolean,
): void {
  const rawYaml = readFileSync(configPath, "utf-8");
  const doc = parseDocument(rawYaml);
  const rawConfig = (doc.toJS() as Record<string, unknown>) ?? {};

  const notifiers = isRecord(rawConfig["notifiers"]) ? rawConfig["notifiers"] : {};
  const openclawConfig: Record<string, unknown> = {
    plugin: "openclaw",
    url: resolved.url,
    openclawConfigPath: displayOpenClawConfigPath(resolved.openclawConfigPath),
    retries: 3,
    retryDelayMs: 1000,
    wakeMode: "now",
  };
  if (resolved.tokenSource === "cli" || resolved.tokenSource === "manual" || resolved.tokenSource === "yaml") {
    openclawConfig["token"] = resolved.token;
  } else if (resolved.tokenSource === "env") {
    openclawConfig["token"] = "$" + "{OPENCLAW_HOOKS_TOKEN}";
  }
  notifiers["openclaw"] = openclawConfig;
  rawConfig["notifiers"] = notifiers;

  if (resolved.routingPreset) {
    ensureNotifierDefault(rawConfig, "openclaw");
  }
  applyNotifierRoutingPreset(rawConfig, "openclaw", resolved.routingPreset);

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

  if (nonInteractive) {
    console.log(chalk.green(`✓ Config written to ${configPath}`));
  }
}

function printOpenClawInstructions(nonInteractive: boolean, resolved: ResolvedOpenClawSetup): void {
  const tokenLocation =
    resolved.tokenSource === "openclaw-config"
      ? displayOpenClawConfigPath(resolved.openclawConfigPath)
      : resolved.tokenSource === "env"
        ? "OPENCLAW_HOOKS_TOKEN"
        : "agent-orchestrator.yaml";

  if (nonInteractive) {
    console.log(chalk.green("✓ AO config written (OpenClaw config left unchanged)"));
    console.log(`Token source: ${tokenLocation}`);
    return;
  }

  console.log(`\n${chalk.green.bold("Done — AO config written.")}`);
  console.log(chalk.dim("  agent-orchestrator.yaml  — notifiers.openclaw block"));
  console.log(chalk.dim(`  token source             — ${tokenLocation}`));
  if (resolved.tokenSource === "openclaw-config") {
    console.log(chalk.dim("  AO did not write OpenClaw config or shell profile exports."));
  }
}

async function runInteractiveSetupProbe(resolved: ResolvedOpenClawSetup): Promise<void> {
  if (!resolved.shouldSendTest) {
    console.log(chalk.dim("Skipped OpenClaw setup probe."));
    return;
  }

  const result = await validateToken(resolved.url, resolved.token);
  if (result.valid) {
    console.log(chalk.green("✓ OpenClaw setup probe passed"));
    return;
  }

  console.log(
    chalk.yellow(
      `OpenClaw setup probe did not pass yet: ${result.error ?? "unknown validation error"}`,
    ),
  );
  console.log(chalk.dim("Restart OpenClaw, then run `ao setup openclaw --status` to verify."));
}

async function printStatus(): Promise<void> {
  const context = readConfigContext();
  const existingOpenClaw = getExistingOpenClaw(context.rawConfig);
  const plugin = stringValue(existingOpenClaw["plugin"]);
  const configuredUrl = stringValue(existingOpenClaw["url"]);
  const url = configuredUrl ? normalizeOpenClawHooksUrl(configuredUrl) : DEFAULT_OPENCLAW_URL;
  const openclawConfigPath = getConfiguredOpenClawConfigPath({}, existingOpenClaw);
  const tokenInfo = resolveConfiguredToken(existingOpenClaw, openclawConfigPath);
  const openclawJson = readOpenClawJson(openclawConfigPath);
  const installation = await detectOpenClawInstallation(url);

  console.log(chalk.bold("OpenClaw notifier status"));
  console.log(`  Config: ${context.configPath}`);
  console.log(`  Plugin: ${plugin ?? chalk.dim("not configured")}`);
  console.log(`  Webhook URL: ${configuredUrl ?? chalk.dim("not configured")}`);
  console.log(`  Token: ${tokenInfo ? `configured from ${tokenInfo.source}` : chalk.dim("not configured")}`);
  console.log(
    `  OpenClaw config: ${openclawJson.exists ? displayOpenClawConfigPath(openclawJson.path) : chalk.dim(`${displayOpenClawConfigPath(openclawJson.path)} not found`)}`,
  );
  console.log(`  Routing: ${getNotifierRoutingState(context.rawConfig, "openclaw").label}`);
  console.log(`  Gateway: ${installation.state} at ${installation.gatewayUrl}`);
  if (installation.binaryPath) console.log(`  Binary: ${installation.binaryPath}`);

  if (plugin !== "openclaw" || !tokenInfo || installation.state !== "running") return;

  const validation = await validateToken(url, tokenInfo.value);
  if (validation.valid) {
    console.log(chalk.green("  Token probe: PASS"));
  } else {
    console.log(chalk.red(`  Token probe: FAIL ${validation.error ?? "unknown error"}`));
  }
}

export async function runOpenClawSetupAction(opts: OpenClawSetupOptions): Promise<void> {
  const nonInteractive = opts.nonInteractive || !process.stdin.isTTY;
  const force = Boolean(opts.force);

  if (opts.status) {
    await printStatus();
    return;
  }

  const context = readConfigContext();
  const existingOpenClaw = getExistingOpenClaw(context.rawConfig);
  const shouldWire = await shouldReplaceConflictingOpenClaw(
    existingOpenClaw["plugin"],
    force,
    nonInteractive,
  );
  if (!shouldWire) return;

  const resolved = nonInteractive
    ? await resolveNonInteractiveSetup(opts, existingOpenClaw, context.rawConfig)
    : await resolveInteractiveSetup(opts, existingOpenClaw, context.rawConfig);

  writeOpenClawConfig(context.configPath, resolved, nonInteractive);

  if (!nonInteractive) {
    await runInteractiveSetupProbe(resolved);
  }

  printOpenClawInstructions(nonInteractive, resolved);

  if (!nonInteractive) {
    const clack = await import("@clack/prompts");
    clack.outro(
      `${chalk.green("OpenClaw setup complete!")} AO will send notifications to OpenClaw.\n` +
        chalk.dim("  Test it with: ao notify test --to openclaw --template basic\n") +
        chalk.dim("  Restart AO with 'ao stop && ao start' to activate."),
    );
  } else {
    console.log(chalk.green("\n✓ OpenClaw setup complete."));
    console.log(chalk.dim("Restart AO to activate: ao stop && ao start"));
  }
}
