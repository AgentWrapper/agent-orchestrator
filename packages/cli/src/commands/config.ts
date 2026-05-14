/**
 * `ao config` — read/write fields in ~/.agent-orchestrator/config.yaml.
 *
 * Today this only manages `updateChannel` and `installMethod`, which are the
 * two settings the release pipeline depends on. We deliberately resist adding
 * a generic key/value writer — the global config has Zod validation and most
 * fields are not safe to set blindly from a flag.
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  createDefaultGlobalConfig,
  getGlobalConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
  UpdateChannelSchema,
  InstallMethodOverrideSchema,
  type GlobalConfig,
  type UpdateChannel,
  type InstallMethodOverride,
} from "@aoagents/ao-core";
import { existsSync } from "node:fs";

const SUPPORTED_KEYS = ["updateChannel", "installMethod"] as const;
type SupportedKey = (typeof SUPPORTED_KEYS)[number];

function isSupportedKey(value: string): value is SupportedKey {
  return (SUPPORTED_KEYS as readonly string[]).includes(value);
}

function loadOrInit(): GlobalConfig {
  const path = getGlobalConfigPath();
  if (existsSync(path)) {
    const config = loadGlobalConfig(path);
    if (config) return config;
  }
  return createDefaultGlobalConfig();
}

function setUpdateChannel(value: string): void {
  const parsed = UpdateChannelSchema.safeParse(value);
  if (!parsed.success) {
    console.error(
      chalk.red(`Invalid value for updateChannel: "${value}". Expected: stable | nightly | manual`),
    );
    process.exit(1);
  }
  const channel: UpdateChannel = parsed.data;
  const config = loadOrInit();
  saveGlobalConfig({ ...config, updateChannel: channel }, getGlobalConfigPath());
  console.log(chalk.green(`✓ updateChannel set to ${chalk.bold(channel)}`));
}

function setInstallMethod(value: string): void {
  const parsed = InstallMethodOverrideSchema.safeParse(value);
  if (!parsed.success) {
    console.error(
      chalk.red(
        `Invalid value for installMethod: "${value}". Expected: git | npm-global | pnpm-global | bun-global | homebrew | unknown`,
      ),
    );
    process.exit(1);
  }
  const method: InstallMethodOverride = parsed.data;
  const config = loadOrInit();
  saveGlobalConfig({ ...config, installMethod: method }, getGlobalConfigPath());
  console.log(chalk.green(`✓ installMethod set to ${chalk.bold(method)}`));
}

function showGet(key: SupportedKey): void {
  const path = getGlobalConfigPath();
  if (!existsSync(path)) {
    console.log(chalk.dim("(unset)"));
    return;
  }
  const config = loadGlobalConfig(path);
  const value = config?.[key];
  console.log(value === undefined ? chalk.dim("(unset)") : String(value));
}

export function registerConfig(program: Command): void {
  const config = program
    .command("config")
    .description("Read or write global AO config (~/.agent-orchestrator/config.yaml)");

  config
    .command("set <key> <value>")
    .description(`Set a config value. Keys: ${SUPPORTED_KEYS.join(", ")}`)
    .action((key: string, value: string) => {
      if (!isSupportedKey(key)) {
        console.error(
          chalk.red(`Unsupported config key: "${key}". Supported: ${SUPPORTED_KEYS.join(", ")}`),
        );
        process.exit(1);
      }
      switch (key) {
        case "updateChannel":
          setUpdateChannel(value);
          break;
        case "installMethod":
          setInstallMethod(value);
          break;
      }
    });

  config
    .command("get <key>")
    .description(`Read a config value. Keys: ${SUPPORTED_KEYS.join(", ")}`)
    .action((key: string) => {
      if (!isSupportedKey(key)) {
        console.error(
          chalk.red(`Unsupported config key: "${key}". Supported: ${SUPPORTED_KEYS.join(", ")}`),
        );
        process.exit(1);
      }
      showGet(key);
    });
}
