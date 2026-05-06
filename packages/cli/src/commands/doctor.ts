import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import {
  createPluginRegistry,
  findConfigFile,
  getObservabilityBaseDir,
  loadConfig,
  resolveNotifierTarget,
  type Notifier,
  type OrchestratorConfig,
  type PluginRegistry,
  type PluginSlot,
} from "@aoagents/ao-core";
import { runRepoScript } from "../lib/script-runner.js";
import { detectOpenClawInstallation, validateToken } from "../lib/openclaw-probe.js";
import { importPluginModuleFromSource } from "../lib/plugin-store.js";
import { getCurrentVersion, isVersionOutdated, readCachedUpdateInfo } from "../lib/update-check.js";

// ---------------------------------------------------------------------------
// Helpers — match the PASS / WARN / FAIL style of ao-doctor.sh
// ---------------------------------------------------------------------------

function pass(msg: string): void {
  console.log(`${chalk.green("PASS")} ${msg}`);
}

function warn(msg: string): void {
  console.log(`${chalk.yellow("WARN")} ${msg}`);
}

/** Returns a fail() recorder and a count() getter — local per invocation, no shared state. */
function makeFailCounter(): { fail: (msg: string) => void; count: () => number } {
  let n = 0;
  return {
    fail(msg: string): void {
      n++;
      console.log(`${chalk.red("FAIL")} ${msg}`);
    },
    count(): number {
      return n;
    },
  };
}

type CheckedPluginSlot = Extract<
  PluginSlot,
  "runtime" | "agent" | "workspace" | "tracker" | "scm" | "notifier"
>;

interface PluginReference {
  slot: CheckedPluginSlot;
  pluginName: string;
  source: string;
}

async function loadPluginRegistry(config: OrchestratorConfig): Promise<PluginRegistry> {
  const registry = createPluginRegistry();
  await registry.loadFromConfig(config, importPluginModuleFromSource);
  return registry;
}

function addPluginReference(
  refs: PluginReference[],
  slot: CheckedPluginSlot,
  pluginName: string | undefined,
  source: string,
): void {
  if (!pluginName) return;
  refs.push({ slot, pluginName, source });
}

function collectPluginReferences(config: OrchestratorConfig): PluginReference[] {
  const refs: PluginReference[] = [];

  addPluginReference(refs, "runtime", config.defaults.runtime, "defaults.runtime");
  addPluginReference(refs, "agent", config.defaults.agent, "defaults.agent");
  addPluginReference(refs, "workspace", config.defaults.workspace, "defaults.workspace");
  addPluginReference(refs, "agent", config.defaults.orchestrator?.agent, "defaults.orchestrator.agent");
  addPluginReference(refs, "agent", config.defaults.worker?.agent, "defaults.worker.agent");

  for (const notifierName of config.defaults.notifiers ?? []) {
    const target = resolveNotifierTarget(config, notifierName);
    addPluginReference(
      refs,
      "notifier",
      target.pluginName,
      `defaults.notifiers: ${target.reference} (plugin: ${target.pluginName})`,
    );
  }

  for (const [priority, notifierNames] of Object.entries(config.notificationRouting ?? {})) {
    for (const notifierName of notifierNames) {
      const target = resolveNotifierTarget(config, notifierName);
      addPluginReference(
        refs,
        "notifier",
        target.pluginName,
        `notificationRouting.${priority}: ${target.reference} (plugin: ${target.pluginName})`,
      );
    }
  }

  for (const [name, notifierConfig] of Object.entries(config.notifiers ?? {})) {
    addPluginReference(
      refs,
      "notifier",
      notifierConfig.plugin,
      `notifiers.${name} (plugin: ${notifierConfig.plugin})`,
    );
  }

  for (const [projectId, project] of Object.entries(config.projects)) {
    addPluginReference(refs, "runtime", project.runtime, `projects.${projectId}.runtime`);
    addPluginReference(refs, "agent", project.agent, `projects.${projectId}.agent`);
    addPluginReference(refs, "workspace", project.workspace, `projects.${projectId}.workspace`);
    addPluginReference(
      refs,
      "agent",
      project.orchestrator?.agent,
      `projects.${projectId}.orchestrator.agent`,
    );
    addPluginReference(refs, "agent", project.worker?.agent, `projects.${projectId}.worker.agent`);
    addPluginReference(
      refs,
      "tracker",
      project.tracker?.plugin,
      `projects.${projectId}.tracker.plugin`,
    );
    addPluginReference(refs, "scm", project.scm?.plugin, `projects.${projectId}.scm.plugin`);
  }

  return refs;
}

async function checkPluginResolution(
  config: OrchestratorConfig,
  fail: (msg: string) => void,
): Promise<PluginRegistry> {
  console.log("");
  console.log("Plugin resolution:");

  const registry = await loadPluginRegistry(config);
  const loadedBySlot = new Map<CheckedPluginSlot, Set<string>>();
  const slots: CheckedPluginSlot[] = [
    "runtime",
    "agent",
    "workspace",
    "tracker",
    "scm",
    "notifier",
  ];

  for (const slot of slots) {
    loadedBySlot.set(
      slot,
      new Set(registry.list(slot).map((manifest) => manifest.name)),
    );
  }

  const references = collectPluginReferences(config);
  if (references.length === 0) {
    warn("No plugin references found in config.");
    return registry;
  }

  for (const ref of references) {
    const loaded = loadedBySlot.get(ref.slot);
    if (loaded?.has(ref.pluginName)) {
      pass(`${ref.source} -> ${ref.slot} plugin "${ref.pluginName}"`);
    } else {
      fail(
        `${ref.source} references ${ref.slot} plugin "${ref.pluginName}", but it could not be loaded. ` +
          `Fix: install the plugin or correct the config value.`,
      );
    }
  }

  return registry;
}

// ---------------------------------------------------------------------------
// Notifier connectivity checks (Gap 2)
// ---------------------------------------------------------------------------

interface OpenClawHealthSummary {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureError: string | null;
  totalSent: number;
  totalFailed: number;
}

function formatTimestamp(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

function readOpenClawHealth(config: OrchestratorConfig): OpenClawHealthSummary | null {
  if (!config.configPath) return null;
  const healthPath = join(getObservabilityBaseDir(config.configPath), "openclaw-health.json");
  if (!existsSync(healthPath)) return null;

  try {
    const raw = readFileSync(healthPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      lastSuccessAt: typeof parsed.lastSuccessAt === "string" ? parsed.lastSuccessAt : null,
      lastFailureAt: typeof parsed.lastFailureAt === "string" ? parsed.lastFailureAt : null,
      lastFailureError: typeof parsed.lastFailureError === "string" ? parsed.lastFailureError : null,
      totalSent: typeof parsed.totalSent === "number" ? parsed.totalSent : 0,
      totalFailed: typeof parsed.totalFailed === "number" ? parsed.totalFailed : 0,
    };
  } catch {
    return null;
  }
}

async function checkOpenClawNotifier(
  config: OrchestratorConfig,
  fail: (msg: string) => void,
): Promise<void> {
  const openclawConfig = config.notifiers?.["openclaw"];
  if (!openclawConfig || openclawConfig.plugin !== "openclaw") {
    warn("OpenClaw notifier is not configured. Fix: run ao setup openclaw");
    return;
  }

  const url =
    (typeof openclawConfig["url"] === "string" ? openclawConfig["url"] : undefined) ??
    "http://127.0.0.1:18789";
  // Resolve ${ENV_VAR} placeholders written by `ao setup openclaw` — the config
  // stores the literal string "${OPENCLAW_HOOKS_TOKEN}" which is truthy but wrong.
  const rawToken = typeof openclawConfig["token"] === "string" ? openclawConfig["token"] : undefined;
  const envVarMatch = rawToken?.match(/^\$\{([^}]+)\}$/);
  const token = (envVarMatch ? process.env[envVarMatch[1]] : rawToken) ?? process.env["OPENCLAW_HOOKS_TOKEN"];

  const installation = await detectOpenClawInstallation(url);
  if (installation.state === "running") {
    pass(
      `OpenClaw gateway detected at ${installation.gatewayUrl} (HTTP ${installation.probe.httpStatus})`,
    );
  } else if (installation.state === "installed-but-stopped") {
    const installHint = installation.binaryPath
      ? `installed at ${installation.binaryPath}`
      : "configured on this machine";
    fail(`OpenClaw is ${installHint} but the gateway is not running at ${installation.gatewayUrl}`);
  } else {
    fail(
      `OpenClaw is not installed locally and the gateway is not reachable at ${installation.gatewayUrl}. ` +
        `Fix: install/start OpenClaw or update the notifier URL`,
    );
  }

  // Step 2: Validate auth token if present
  if (!token) {
    warn(
      "OpenClaw token is not set. Fix: set OPENCLAW_HOOKS_TOKEN env var or add token to notifiers.openclaw in config",
    );
  } else if (installation.state === "running") {
    const tokenResult = await validateToken(installation.gatewayUrl, token);
    if (!tokenResult.valid) {
      fail(`OpenClaw token validation failed: ${tokenResult.error}`);
    } else {
      pass("OpenClaw token is valid");
    }
  }

  const health = readOpenClawHealth(config);
  if (!health) {
    warn("No OpenClaw notification history recorded yet");
    return;
  }

  const lastSuccess = formatTimestamp(health.lastSuccessAt);
  if (lastSuccess) {
    pass(`OpenClaw last successful notification: ${lastSuccess}`);
  } else {
    warn("OpenClaw has not recorded a successful notification yet");
  }

  if (health.lastFailureAt) {
    const lastFailure = formatTimestamp(health.lastFailureAt);
    warn(
      `OpenClaw last failure: ${lastFailure ?? health.lastFailureAt} (${health.lastFailureError ?? "unknown error"})`,
    );
  }

  pass(`OpenClaw notification totals: ${health.totalSent} sent, ${health.totalFailed} failed`);
}

async function checkNotifierConnectivity(
  config: OrchestratorConfig,
  fail: (msg: string) => void,
): Promise<void> {
  console.log(""); // blank line before notifier section
  console.log("Notifier connectivity:");

  const configuredNotifiers = Object.keys(config.notifiers ?? {});
  if (configuredNotifiers.length === 0) {
    warn("No notifiers are configured. Fix: add notifiers to your agent-orchestrator.yaml");
    return;
  }

  // Check OpenClaw specifically (it's the only one we can probe without side effects)
  if (config.notifiers?.["openclaw"]) {
    await checkOpenClawNotifier(config, fail);
  }

  // Report other configured notifiers as present (we can't health-check Slack/desktop/webhook without sending)
  for (const [name, notifierConfig] of Object.entries(config.notifiers ?? {})) {
    if (name === "openclaw") continue; // already checked above
    const plugin = notifierConfig.plugin;
    pass(`${name} notifier is configured (plugin: ${plugin})`);
  }
}

// ---------------------------------------------------------------------------
// Test-notify (Gap 3)
// ---------------------------------------------------------------------------

async function sendTestNotifications(
  config: OrchestratorConfig,
  registry: PluginRegistry,
  fail: (msg: string) => void,
): Promise<void> {
  const activeNotifierNames = config.defaults?.notifiers ?? [];
  const targets = new Map<string, ReturnType<typeof resolveNotifierTarget>>();

  for (const name of Object.keys(config.notifiers ?? {})) {
    targets.set(name, resolveNotifierTarget(config, name));
  }

  for (const name of activeNotifierNames) {
    const target = resolveNotifierTarget(config, name);
    if (!targets.has(target.reference)) {
      targets.set(target.reference, target);
    }
  }

  if (targets.size === 0) {
    warn("No notifiers to test. Fix: configure notifiers in your agent-orchestrator.yaml");
    return;
  }

  console.log(`\nSending test notification to ${targets.size} notifier(s)...\n`);

  for (const target of targets.values()) {
    const notifier =
      registry.get<Notifier>("notifier", target.reference) ??
      registry.get<Notifier>("notifier", target.pluginName);
    if (!notifier) {
      warn(`${target.reference}: plugin "${target.pluginName}" not loaded (may not be installed)`);
      continue;
    }

    try {
      const testEvent = {
        id: `doctor-test-${Date.now()}`,
        type: "summary.all_complete" as const,
        priority: "info" as const,
        sessionId: "doctor-test",
        projectId: "doctor",
        timestamp: new Date(),
        message: "Test notification from ao doctor --test-notify",
        data: { source: "ao-doctor" },
      };

      await notifier.notify(testEvent);
      pass(`${target.reference}: test notification sent`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fail(`${target.reference}: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Version freshness (cache-only — no network call)
// ---------------------------------------------------------------------------

function checkVersionFreshness(): void {
  console.log("");
  console.log("Version:");

  const current = getCurrentVersion();
  const cached = readCachedUpdateInfo();

  if (!cached) {
    pass(`ao v${current} installed (run any ao command to check for updates)`);
    return;
  }

  if (isVersionOutdated(current, cached.latestVersion)) {
    warn(`ao v${current} is outdated (latest: v${cached.latestVersion}). Run: ao update`);
  } else {
    pass(`ao v${current} is the latest version`);
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Run install, environment, and runtime health checks")
    .option("--fix", "Apply safe fixes for launcher and stale temp issues")
    .option("--test-notify", "Send a test notification through each configured notifier")
    .action(async (opts: { fix?: boolean; testNotify?: boolean }) => {
      const { fail, count: failCount } = makeFailCounter();

      // 1. Run shell checks
      const scriptArgs: string[] = [];
      if (opts.fix) {
        scriptArgs.push("--fix");
      }

      let shellExitCode: number;
      try {
        shellExitCode = await runRepoScript("ao-doctor.sh", scriptArgs);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        shellExitCode = 1;
      }

      // 2. Version freshness (cache-only, no network dependency)
      checkVersionFreshness();

      // 3. Run TypeScript-based notifier checks if a config file exists
      const configPath = findConfigFile();
      if (configPath) {
        let config: ReturnType<typeof loadConfig> | undefined;
        let registry: PluginRegistry | undefined;
        try {
          config = loadConfig(configPath);
          registry = await checkPluginResolution(config, fail);
          await checkNotifierConnectivity(config, fail);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          fail(`Config-aware doctor checks failed: ${message}`);
        }

        // 4. Send test notifications if requested (separate catch for accurate errors)
        if (opts.testNotify && config && registry) {
          try {
            await sendTestNotifications(config, registry, fail);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            fail(`Sending test notifications failed: ${message}`);
          }
        }
      } else if (opts.testNotify) {
        fail("No config file found. Cannot test notifiers without agent-orchestrator.yaml");
      }

      // Exit non-zero if shell checks or notifier checks failed
      if (shellExitCode !== 0 || failCount() > 0) {
        process.exit(shellExitCode || 1);
      }
    });
}
