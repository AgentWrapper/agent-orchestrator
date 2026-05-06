/**
 * `ao setup openclaw` — interactive wizard + non-interactive mode
 * for wiring AO notifications to an OpenClaw gateway.
 *
 * Interactive:  ao setup openclaw          (human in terminal)
 * Programmatic: ao setup openclaw --url X --token Y --non-interactive
 *               (OpenClaw agent calling via exec tool)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { parse as yamlParse, parseDocument } from "yaml";
import { CONFIG_SCHEMA_URL, findConfigFile, isCanonicalGlobalConfigPath } from "@aoagents/ao-core";
import {
  probeGateway,
  validateToken,
  detectOpenClawInstallation,
  DEFAULT_OPENCLAW_URL,
  HOOKS_PATH,
} from "../lib/openclaw-probe.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export class SetupAbortedError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "SetupAbortedError";
  }
}

interface SetupOptions {
  url?: string;
  token?: string;
  nonInteractive?: boolean;
  routingPreset?: OpenClawRoutingPreset;
}

type OpenClawRoutingPreset = "urgent-only" | "urgent-action" | "all";

interface ResolvedConfig {
  url: string;
  token: string;
  routingPreset: OpenClawRoutingPreset;
}

const OPENCLAW_ROUTING_PRESETS = {
  "urgent-only": ["urgent"],
  "urgent-action": ["urgent", "action"],
  all: ["urgent", "action", "warning", "info"],
} as const;

const NOTIFICATION_PRIORITIES = ["urgent", "action", "warning", "info"] as const;

function isRoutingPreset(value: string | undefined): value is OpenClawRoutingPreset {
  return value === "urgent-only" || value === "urgent-action" || value === "all";
}

function normalizeOpenClawHooksUrl(url: string): string {
  const normalized = url.trim().replace(/\/+$/, "");
  return normalized.endsWith(HOOKS_PATH) ? normalized : `${normalized}${HOOKS_PATH}`;
}

// ---------------------------------------------------------------------------
// Interactive prompts (dynamic import to keep @clack/prompts optional)
// ---------------------------------------------------------------------------

async function interactiveSetup(existingUrl?: string): Promise<ResolvedConfig> {
  const clack = await import("@clack/prompts");

  clack.intro(chalk.bgCyan(chalk.black(" ao setup openclaw ")));

  // --- Step 1: Gateway URL ---------------------------------------------------
  const defaultUrl = `${DEFAULT_OPENCLAW_URL}${HOOKS_PATH}`;
  let detectedUrl: string | undefined;

  const spin = clack.spinner();
  spin.start("Detecting OpenClaw gateway on localhost...");

  const probe = await probeGateway(DEFAULT_OPENCLAW_URL);
  if (probe.reachable) {
    detectedUrl = defaultUrl;
    spin.stop(`Found OpenClaw gateway at ${DEFAULT_OPENCLAW_URL}`);
  } else {
    spin.stop("No OpenClaw gateway detected on localhost");
  }

  const urlInput = await clack.text({
    message: "OpenClaw webhook URL:",
    placeholder: defaultUrl,
    initialValue: existingUrl ?? detectedUrl ?? defaultUrl,
    validate: (v) => {
      if (!v) return "URL is required";
      if (!v.startsWith("http://") && !v.startsWith("https://"))
        return "Must start with http:// or https://";
    },
  });

  if (clack.isCancel(urlInput)) {
    clack.cancel("Setup cancelled.");
    throw new SetupAbortedError("Setup cancelled.", 0);
  }

  // Normalize: ensure URL ends with /hooks/agent
  const url = normalizeOpenClawHooksUrl(urlInput as string);

  // --- Step 2: Token ---------------------------------------------------------
  const envToken = process.env["OPENCLAW_HOOKS_TOKEN"];
  let tokenValue: string;

  if (envToken) {
    const useEnv = await clack.confirm({
      message: `Found OPENCLAW_HOOKS_TOKEN in environment. Use it?`,
      initialValue: true,
    });

    if (clack.isCancel(useEnv)) {
      clack.cancel("Setup cancelled.");
      throw new SetupAbortedError("Setup cancelled.", 0);
    }

    if (useEnv) {
      tokenValue = envToken;
    } else {
      const input = await clack.password({
        message: "Enter your OpenClaw hooks token:",
        validate: (v) => (!v ? "Token is required" : undefined),
      });
      if (clack.isCancel(input)) {
        clack.cancel("Setup cancelled.");
        throw new SetupAbortedError("Setup cancelled.", 0);
      }
      tokenValue = input as string;
    }
  } else {
    const generatedToken = randomBytes(32).toString("base64url");
    const tokenChoice = await clack.select({
      message: "How would you like to set the hooks token?",
      options: [
        { value: "generate", label: "Auto-generate a secure token (recommended)" },
        { value: "manual", label: "Enter an existing token manually" },
      ],
    });

    if (clack.isCancel(tokenChoice)) {
      clack.cancel("Setup cancelled.");
      throw new SetupAbortedError("Setup cancelled.", 0);
    }

    if (tokenChoice === "manual") {
      const input = await clack.password({
        message: "Enter your OpenClaw hooks token:",
        validate: (v) => (!v ? "Token is required" : undefined),
      });
      if (clack.isCancel(input)) {
        clack.cancel("Setup cancelled.");
        throw new SetupAbortedError("Setup cancelled.", 0);
      }
      tokenValue = input as string;
    } else {
      tokenValue = generatedToken;
      clack.log.success(`Generated token: ${chalk.dim(tokenValue.slice(0, 8))}...`);
    }
  }

  // --- Step 3: Validate ------------------------------------------------------
  spin.start("Validating token against gateway...");

  const validation = await validateToken(url, tokenValue);
  if (validation.valid) {
    spin.stop("Token validated — connection works!");
  } else {
    spin.stop(`Validation failed: ${validation.error}`);

    const cont = await clack.confirm({
      message: "Save config anyway? (you can fix the token later)",
      initialValue: false,
    });

    if (clack.isCancel(cont) || !cont) {
      clack.cancel("Setup cancelled. Fix the issue and retry.");
      throw new SetupAbortedError("Setup cancelled. Fix the issue and retry.");
    }
  }

  const routingPreset = await clack.select({
    message: "Which notifications should OpenClaw receive?",
    initialValue: "urgent-action",
    options: [
      { value: "urgent-action", label: "Urgent + action (recommended)" },
      { value: "urgent-only", label: "Urgent only" },
      { value: "all", label: "All priorities" },
    ],
  });

  if (clack.isCancel(routingPreset)) {
    clack.cancel("Setup cancelled.");
    throw new SetupAbortedError("Setup cancelled.", 0);
  }

  return {
    url,
    token: tokenValue,
    routingPreset: routingPreset as OpenClawRoutingPreset,
  };
}

// ---------------------------------------------------------------------------
// Non-interactive path
// ---------------------------------------------------------------------------

async function nonInteractiveSetup(opts: SetupOptions): Promise<ResolvedConfig> {
  let rawUrl = opts.url ?? process.env["OPENCLAW_GATEWAY_URL"];
  const token = opts.token ?? process.env["OPENCLAW_HOOKS_TOKEN"];

  // Auto-detect OpenClaw if no URL was given explicitly
  if (!rawUrl) {
    const installation = await detectOpenClawInstallation();
    if (installation.state === "running") {
      rawUrl = `${installation.gatewayUrl}${HOOKS_PATH}`;
      console.log(chalk.dim(`Auto-detected OpenClaw gateway at ${installation.gatewayUrl}`));
    } else {
      throw new SetupAbortedError(
        "Error: OpenClaw gateway not reachable and no --url provided.\n" +
          "  Start OpenClaw first, or pass --url explicitly:\n" +
          "  Example: ao setup openclaw --url http://127.0.0.1:18789/hooks/agent --token YOUR_TOKEN --non-interactive",
      );
    }
  }

  let url = rawUrl;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new SetupAbortedError("Error: --url must start with http:// or https://");
  }

  // Normalize: ensure URL ends with /hooks/agent
  url = normalizeOpenClawHooksUrl(url);

  const resolvedToken = token ?? randomBytes(32).toString("base64url");
  if (!token) {
    console.log(chalk.dim("No token provided — auto-generated a secure token."));
  }

  // Skip pre-write validation — on fresh installs the gateway won't have the
  // token yet. We write both configs first, then the user restarts the gateway.
  console.log(chalk.dim("Skipping pre-validation (token will be written to both configs)."));

  const routingPreset = isRoutingPreset(opts.routingPreset) ? opts.routingPreset : "urgent-action";

  return { url, token: resolvedToken, routingPreset };
}

// ---------------------------------------------------------------------------
// Config writer
// ---------------------------------------------------------------------------

function writeOpenClawConfig(
  configPath: string,
  resolved: ResolvedConfig,
  nonInteractive: boolean,
): void {
  const rawYaml = readFileSync(configPath, "utf-8");

  // Use parseDocument to preserve YAML comments during round-trip
  const doc = parseDocument(rawYaml);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawConfig = (doc.toJS() as Record<string, any>) ?? {};

  // Write the env-var placeholder so the raw token is never committed to
  // version control. ao setup openclaw exports the real value to the shell
  // profile; the notifier plugin resolves it at runtime (env var → openclaw.json
  // fallback for daemon contexts where the shell profile isn't sourced).
  if (!rawConfig.notifiers) rawConfig.notifiers = {};
  rawConfig.notifiers.openclaw = {
    plugin: "openclaw",
    url: resolved.url,
    token: "$" + "{OPENCLAW_HOOKS_TOKEN}", // env-var placeholder, not a JS template
    retries: 3,
    retryDelayMs: 1000,
    wakeMode: "now",
  };

  // Add "openclaw" to defaults.notifiers if not already present
  if (!rawConfig.defaults) rawConfig.defaults = {};
  if (!rawConfig.defaults.notifiers) rawConfig.defaults.notifiers = [];
  if (!Array.isArray(rawConfig.defaults.notifiers)) {
    rawConfig.defaults.notifiers = [rawConfig.defaults.notifiers];
  }
  if (!rawConfig.defaults.notifiers.includes("openclaw")) {
    rawConfig.defaults.notifiers.push("openclaw");
  }

  const defaultsWithoutOpenClaw = (rawConfig.defaults.notifiers as string[]).filter(
    (name) => name !== "openclaw",
  );

  // AO routes notifications by priority. Preserve existing notifiers and only
  // adjust OpenClaw membership across the standard priority buckets.
  if (!rawConfig.notificationRouting) {
    const base = [...new Set(defaultsWithoutOpenClaw)];
    rawConfig.notificationRouting = {
      urgent: [...base],
      action: [...base],
      warning: [...base],
      info: [...base],
    };
  } else if (typeof rawConfig.notificationRouting === "object") {
    for (const priority of NOTIFICATION_PRIORITIES) {
      if (!Array.isArray(rawConfig.notificationRouting[priority])) {
        rawConfig.notificationRouting[priority] = [];
      }
    }
  }

  const selectedPriorities = new Set(OPENCLAW_ROUTING_PRESETS[resolved.routingPreset]);
  for (const priority of NOTIFICATION_PRIORITIES) {
    const list = rawConfig.notificationRouting[priority] as string[];
    rawConfig.notificationRouting[priority] = list.filter((name) => name !== "openclaw");
    if (selectedPriorities.has(priority)) {
      rawConfig.notificationRouting[priority].push("openclaw");
    }
  }

  // Update the document tree from the modified plain object while preserving comments
  if (!isCanonicalGlobalConfigPath(configPath)) {
    const currentSchema = doc.get("$schema");
    if (!(typeof currentSchema === "string" && currentSchema.trim().length > 0)) {
      doc.set("$schema", CONFIG_SCHEMA_URL);
    }
  }
  doc.setIn(["notifiers"], rawConfig.notifiers);
  doc.setIn(["defaults"], rawConfig.defaults);
  doc.setIn(["notificationRouting"], rawConfig.notificationRouting);

  writeFileSync(configPath, doc.toString({ indent: 2 }));

  if (nonInteractive) {
    console.log(chalk.green(`✓ Config written to ${configPath}`));
  }
}

/**
 * Write the hooks block into ~/.openclaw/openclaw.json.
 * Returns true on success, false on failure (caller should fall back to
 * printing manual instructions).
 */
function writeOpenClawJsonConfig(token: string): boolean {
  try {
    const openclawDir = join(homedir(), ".openclaw");
    const openclawJsonPath = join(openclawDir, "openclaw.json");

    let config: Record<string, unknown> = {};
    if (existsSync(openclawJsonPath)) {
      const raw = readFileSync(openclawJsonPath, "utf-8");
      config = JSON.parse(raw) as Record<string, unknown>;
    } else if (!existsSync(openclawDir)) {
      mkdirSync(openclawDir, { recursive: true });
    }

    // Merge the hooks block (preserve other existing keys in hooks if any)
    const existingHooks = (config.hooks as Record<string, unknown> | undefined) ?? {};
    const existingPrefixes = Array.isArray(existingHooks.allowedSessionKeyPrefixes)
      ? existingHooks.allowedSessionKeyPrefixes.filter(
          (prefix): prefix is string => typeof prefix === "string",
        )
      : [];
    const allowedSessionKeyPrefixes = existingPrefixes.includes("hook:")
      ? existingPrefixes
      : [...existingPrefixes, "hook:"];

    config.hooks = {
      ...existingHooks,
      enabled: true,
      token,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes,
    };

    writeFileSync(openclawJsonPath, JSON.stringify(config, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * Append `export OPENCLAW_HOOKS_TOKEN=...` to the user's shell profile
 * (~/.zshrc or ~/.bashrc). Skips if the export line already exists.
 * Returns the profile path on success, undefined on failure.
 */
function writeShellExport(token: string): string | undefined {
  try {
    const shell = process.env["SHELL"] ?? "";
    const profileName = shell.endsWith("/zsh") ? ".zshrc" : ".bashrc";
    const profilePath = join(homedir(), profileName);

    // Sanitize token: escape shell-special characters to prevent injection
    // when the profile is sourced. Single-quote the value and escape any
    // embedded single quotes (the only character that breaks '...' quoting).
    const safeToken = token.replace(/'/g, "'\\''");
    const exportLine = `export OPENCLAW_HOOKS_TOKEN='${safeToken}'`;

    // Check if it already exists (use the same regex for detection and replacement
    // to avoid silent no-ops when the line is commented, lacks the export prefix,
    // or has leading whitespace)
    // Negative lookahead excludes commented lines (e.g. # export OPENCLAW_HOOKS_TOKEN=...)
    const existingExportRegex = /^(?!\s*#)\s*(?:export\s+)?OPENCLAW_HOOKS_TOKEN=.*$/m;
    if (existsSync(profilePath)) {
      const content = readFileSync(profilePath, "utf-8");
      if (existingExportRegex.test(content)) {
        // Replace the existing line
        const updated = content.replace(existingExportRegex, exportLine);
        writeFileSync(profilePath, updated);
        return profilePath;
      }
    }

    // Append
    const prefix = existsSync(profilePath) ? "\n" : "";
    writeFileSync(profilePath, `${prefix}# Added by ao setup openclaw\n${exportLine}\n`, {
      flag: "a",
    });
    return profilePath;
  } catch {
    return undefined;
  }
}

function printOpenClawInstructions(
  nonInteractive: boolean,
  openclawConfigWritten: boolean,
  shellProfilePath: string | undefined,
): void {
  if (openclawConfigWritten) {
    // Both configs written automatically
    if (nonInteractive) {
      console.log(
        chalk.green("✓ Both configs written (agent-orchestrator.yaml + ~/.openclaw/openclaw.json)"),
      );
      if (shellProfilePath) {
        console.log(chalk.green(`✓ OPENCLAW_HOOKS_TOKEN exported in ${shellProfilePath}`));
      }
      console.log("Restart OpenClaw gateway to apply.");
    } else {
      console.log(`\n${chalk.green.bold("Done — both configs written.")}`);
      console.log(chalk.dim("  agent-orchestrator.yaml  — notifiers.openclaw block"));
      console.log(chalk.dim("  ~/.openclaw/openclaw.json — hooks block"));
      if (shellProfilePath) {
        console.log(chalk.dim(`  ${shellProfilePath} — OPENCLAW_HOOKS_TOKEN export`));
      }
      console.log(`\n${chalk.yellow("Restart OpenClaw gateway to apply.")}`);
    }
  } else {
    // Fallback: could not write OpenClaw config, print manual instructions
    const instructions = `
${chalk.bold("OpenClaw-side config required")}

AO config was written successfully. Add this to your OpenClaw config (${chalk.dim("~/.openclaw/openclaw.json")}):

  ${chalk.cyan(`{
    "hooks": {
      "enabled": true,
      "token": "<same-token-you-entered-above>",
      "allowRequestSessionKey": true,
      "allowedSessionKeyPrefixes": ["hook:"]
    }
  }`)}
`;

    if (nonInteractive) {
      console.log("\nOpenClaw-side config required:");
      console.log("AO config was written successfully. Add to ~/.openclaw/openclaw.json:");
      console.log("  hooks.enabled: true");
      console.log('  hooks.token: "<your-token>"');
      console.log("  hooks.allowRequestSessionKey: true");
      console.log('  hooks.allowedSessionKeyPrefixes: ["hook:"]');
    } else {
      console.log(instructions);
    }
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerSetup(program: Command): void {
  const setup = program.command("setup").description("Set up integrations with external services");

  setup
    .command("openclaw")
    .description("Connect AO notifications to an OpenClaw gateway")
    .option("--url <url>", "OpenClaw webhook URL (e.g. http://127.0.0.1:18789/hooks/agent)")
    .option("--token <token>", "OpenClaw hooks auth token")
    .option(
      "--routing-preset <preset>",
      "OpenClaw routing preset: urgent-only | urgent-action | all",
    )
    .option(
      "--non-interactive",
      "Skip prompts — auto-detects OpenClaw if --url not provided (token auto-generated if not provided)",
    )
    .action(async (opts: SetupOptions) => {
      try {
        await runSetupAction(opts);
      } catch (err) {
        if (err instanceof SetupAbortedError) {
          console.error(err.message);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });
}

export async function runSetupAction(opts: SetupOptions): Promise<void> {
  const nonInteractive = opts.nonInteractive || !process.stdin.isTTY;

  // --- Find existing config ------------------------------------------------
  let configPath: string | undefined;
  try {
    const found = findConfigFile();
    configPath = found ?? undefined;
  } catch {
    // no config found
  }

  if (!configPath) {
    throw new SetupAbortedError(
      "No agent-orchestrator.yaml found. Run 'ao start' first to create one.",
    );
  }

  // --- Check for existing openclaw config ----------------------------------
  const rawYaml = readFileSync(configPath, "utf-8");
  const rawConfig = yamlParse(rawYaml) ?? {};
  const existingOpenClaw = rawConfig?.notifiers?.openclaw;
  const existingUrl = existingOpenClaw?.url as string | undefined;

  if (existingOpenClaw && !nonInteractive) {
    const clack = await import("@clack/prompts");
    const reconfigure = await clack.confirm({
      message: "OpenClaw is already configured. Reconfigure?",
      initialValue: false,
    });

    if (clack.isCancel(reconfigure) || !reconfigure) {
      console.log(chalk.dim("Keeping existing config."));
      return;
    }
  }

  // --- Run setup -----------------------------------------------------------
  let resolved: ResolvedConfig;

  if (nonInteractive) {
    resolved = await nonInteractiveSetup(opts);
  } else {
    resolved = await interactiveSetup(existingUrl);
  }

  // --- Write AO config -----------------------------------------------------
  writeOpenClawConfig(configPath, resolved, nonInteractive);

  // --- Write OpenClaw config -----------------------------------------------
  const openclawConfigWritten = writeOpenClawJsonConfig(resolved.token);
  if (openclawConfigWritten && nonInteractive) {
    console.log(chalk.green("✓ Wrote hooks config to ~/.openclaw/openclaw.json"));
  }

  // --- Write shell export --------------------------------------------------
  const shellProfilePath = writeShellExport(resolved.token);
  if (shellProfilePath && nonInteractive) {
    console.log(chalk.green(`✓ Exported OPENCLAW_HOOKS_TOKEN in ${shellProfilePath}`));
  }

  // --- Print instructions --------------------------------------------------
  printOpenClawInstructions(nonInteractive, openclawConfigWritten, shellProfilePath);

  // --- Done ----------------------------------------------------------------
  if (!nonInteractive) {
    const clack = await import("@clack/prompts");
    clack.outro(
      `${chalk.green("Setup complete!")} AO will send notifications to OpenClaw.\n` +
        chalk.dim("  Run 'ao doctor' to verify the full setup.\n") +
        chalk.dim("  Restart AO with 'ao stop && ao start' to activate."),
    );
  } else {
    console.log(chalk.green("\n✓ OpenClaw setup complete."));
    console.log(chalk.dim("Restart AO to activate: ao stop && ao start"));
  }
}
