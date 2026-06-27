/**
 * `ao models list [--json]` — enumerate the built-in model registry.
 *
 * Single source of truth = packages/core/src/model-registry.ts (MODEL_REGISTRY).
 * This command is purely DESCRIPTIVE: it does not touch provider dispatch, spawn,
 * or runtime selection — it only reports what the registry already knows plus the
 * current credential/availability state.
 *
 * The `--json` envelope is VERSIONED ({@link MODELS_LIST_SCHEMA_VERSION}) because
 * the Maestro app reads it as the authoritative model list (replacing the app's
 * hardcoded presets). The field names below are therefore a FROZEN CONTRACT for
 * the Swift side — add fields additively, bump the schema version for breaking
 * changes.
 *
 * `auth.configured` and `available` mirror the SAME config → key resolution the
 * runtime-sdk plugin performs today (the zhipu/mimo config blocks, or a pre-set
 * AO_*_API_KEY env override). OpenAI has no config block yet, so it always
 * reports `configured: false`.
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  MODEL_REGISTRY,
  modelAvailability,
  loadGlobalConfig,
  type GlobalConfig,
  type ModelDescriptor,
  type ModelCapabilities,
  type ProviderId,
  type RuntimeDriver,
} from "@aoagents/ao-core";

/** Bump when the JSON element shape changes in a NON-additive way. */
export const MODELS_LIST_SCHEMA_VERSION = 1;

/** Credential state for a model's provider. */
export interface ModelAuthView {
  /** Provider requires an API key (false for Anthropic — ambient auth). */
  needsKey: boolean;
  /** A usable credential is present (config block apiKey or AO_*_API_KEY env). */
  configured: boolean;
}

/** One model as exposed to consumers (the Swift app, scripts). */
export interface ModelListEntry {
  /** Canonical id sent to the provider API (Claude ids are SDK aliases). */
  id: string;
  /** Human-facing name for the picker. */
  displayName: string;
  provider: ProviderId;
  runtimeDriver: RuntimeDriver;
  /** UI grouping header (mirrors the app's preset sections). */
  section: string;
  /** Extra UX aliases that resolve to this model. */
  aliases: string[];
  /** Default-selection hint by session role, if any. */
  defaultFor?: ModelDescriptor["defaultFor"];
  capabilities: ModelCapabilities;
  auth: ModelAuthView;
  /** Usable given the current global config (enabled + key present). */
  available: boolean;
  /** Human-readable reason when `available === false`. */
  reason?: string;
}

/** Versioned envelope so the Swift contract stays stable across changes. */
export interface ModelsListPayload {
  schemaVersion: number;
  models: ModelListEntry[];
}

/**
 * Whether the provider credential is present, mirroring the runtime-sdk plugin's
 * config→env bridge: the config block's `apiKey` OR a pre-set AO_*_API_KEY env
 * var. Anthropic (configKey null) authenticates ambiently → always "configured".
 */
function isProviderConfigured(
  descriptor: ModelDescriptor,
  config: GlobalConfig | null | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const { configKey, envKey } = descriptor.auth;
  if (!configKey) return true;
  const block = (config as Record<string, unknown> | null | undefined)?.[configKey] as
    | { apiKey?: string }
    | undefined;
  if (block?.apiKey && block.apiKey.trim().length > 0) return true;
  if (envKey) {
    const fromEnv = env[envKey];
    if (fromEnv && fromEnv.trim().length > 0) return true;
  }
  return false;
}

/**
 * Build the versioned JSON payload from the registry. Pure (config + env in,
 * payload out) so it is unit-testable without spawning a process.
 */
export function buildModelsListPayload(
  config: GlobalConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ModelsListPayload {
  const models: ModelListEntry[] = MODEL_REGISTRY.map((d) => {
    const availability = modelAvailability(d, config);
    const entry: ModelListEntry = {
      id: d.id,
      displayName: d.label,
      provider: d.provider,
      runtimeDriver: d.runtimeDriver,
      section: d.section,
      aliases: [...d.aliases],
      capabilities: { ...d.capabilities },
      auth: {
        needsKey: d.auth.configKey !== null,
        configured: isProviderConfigured(d, config, env),
      },
      available: availability.available,
    };
    if (d.defaultFor) entry.defaultFor = d.defaultFor;
    if (!availability.available && availability.reason) entry.reason = availability.reason;
    return entry;
  });
  return { schemaVersion: MODELS_LIST_SCHEMA_VERSION, models };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** Render the human-readable table, grouped by section in registry order. */
export function renderModelsTable(payload: ModelsListPayload): string {
  if (payload.models.length === 0) return chalk.dim("(no models in registry)");

  const idW = Math.max(...payload.models.map((m) => m.id.length), "ID".length);
  const nameW = Math.max(...payload.models.map((m) => m.displayName.length), "NAME".length);
  const provW = Math.max(...payload.models.map((m) => m.provider.length), "PROVIDER".length);
  const drvW = Math.max(...payload.models.map((m) => m.runtimeDriver.length), "DRIVER".length);

  const lines: string[] = [];
  let currentSection: string | null = null;
  for (const m of payload.models) {
    if (m.section !== currentSection) {
      if (currentSection !== null) lines.push("");
      lines.push(chalk.bold(m.section));
      currentSection = m.section;
    }
    const dot = m.available ? chalk.green("●") : chalk.dim("○");
    const caps = m.capabilities.tools ? "agent" : "chat-only";
    const key = !m.auth.needsKey
      ? chalk.dim("ambient")
      : m.auth.configured
        ? chalk.green("configured")
        : chalk.yellow("missing");
    const status = m.available
      ? chalk.green("available")
      : chalk.yellow(`unavailable${m.reason ? ` (${m.reason})` : ""}`);
    lines.push(
      `  ${dot} ${pad(m.id, idW)}  ${pad(m.displayName, nameW)}  ${chalk.dim(
        pad(m.provider, provW),
      )}  ${chalk.dim(pad(m.runtimeDriver, drvW))}  ${pad(caps, 9)}  ${pad(key, 11)}  ${status}`,
    );
  }
  return lines.join("\n");
}

export function registerModels(program: Command): void {
  const models = program
    .command("models")
    .description(
      "Inspect the built-in model registry (provider, runtime driver, capabilities, availability)",
    );

  models
    .command("list")
    .description("List all known models. Use --json for the versioned machine-readable envelope.")
    .option("--json", "Output the versioned JSON envelope { schemaVersion, models[] }")
    .action((opts: { json?: boolean }) => {
      const config = loadGlobalConfig();
      const payload = buildModelsListPayload(config);
      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(renderModelsTable(payload));
    });
}
