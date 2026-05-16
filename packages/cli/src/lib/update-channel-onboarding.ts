/**
 * Update-channel onboarding helpers.
 *
 * On first `ao start`, prompt the user once for an `updateChannel` and persist
 * it to ~/.agent-orchestrator/config.yaml. Never re-prompt — if they dismiss
 * (Ctrl+C / Esc), default to `manual` so we don't surprise-install anything.
 *
 * Spec: release-process.html §08 (Onboarding integration).
 */

import { existsSync } from "node:fs";
import chalk from "chalk";
import {
  createDefaultGlobalConfig,
  getGlobalConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
  UpdateChannelSchema,
  type GlobalConfig,
  type UpdateChannel,
} from "@aoagents/ao-core";
import { promptSelect } from "./prompts.js";
import { isHumanCaller } from "./caller-context.js";

interface PromptDeps {
  /** Test seam — defaults to the real prompt. */
  prompt?: (
    message: string,
    options: { value: UpdateChannel | "skip"; label: string; hint?: string }[],
  ) => Promise<UpdateChannel | "skip">;
  /** Test seam — defaults to `isHumanCaller()`. */
  isInteractive?: () => boolean;
}

/**
 * Has the user already been asked about update channels?
 *
 * True when:
 *   - The global config exists AND has `updateChannel` set.
 *
 * False when:
 *   - The global config does not exist yet (first run — prompt fires immediately).
 *   - The global config exists but `updateChannel` is unset (existing user, pre-onboarding).
 */
export function hasChosenUpdateChannel(): boolean {
  if (!existsSync(getGlobalConfigPath())) return false;
  try {
    const config = loadGlobalConfig();
    return Boolean(config?.updateChannel);
  } catch {
    return true; // Don't pester users when config can't be read.
  }
}

/**
 * Persist the chosen channel to the global config.
 *
 * No-op when the global config doesn't exist — autoCreateConfig() handles
 * bootstrap during first run. When the file exists but can't be parsed,
 * falls back to a fresh default config.
 */
export function persistUpdateChannel(channel: UpdateChannel): void {
  const path = getGlobalConfigPath();
  // Don't create an empty global config here — autoCreateConfig() handles
  // bootstrap (with project registration) during first run. Writing an empty
  // husk poisons the dashboard, which loads the global config and finds
  // zero projects.
  if (!existsSync(path)) return;
  const existing = loadGlobalConfig(path) ?? createDefaultGlobalConfig();
  const next: GlobalConfig = { ...existing, updateChannel: channel };
  saveGlobalConfig(next, path);
}

/**
 * Prompt the user once and persist the chosen channel.
 *
 * Skipped silently when:
 *   - The choice was already made (idempotent — never re-prompts).
 *   - The caller is not interactive (CI, scripted ao start).
 *
 * On dismissal, persists `manual` so we don't ask again — surprise auto-installs
 * are worse than a quiet manual default.
 */
export async function maybePromptForUpdateChannel(deps: PromptDeps = {}): Promise<void> {
  const isInteractive = deps.isInteractive ?? isHumanCaller;
  if (!isInteractive()) return;
  if (hasChosenUpdateChannel()) return;

  // No global config yet — skip. autoCreateConfig() handles full bootstrap
  // (creating the global config and registering the project) during first run.
  // On the next `ao start` the global config will exist and the prompt fires.
  // Skipping here avoids writing an empty husk that poisons the dashboard.
  if (!existsSync(getGlobalConfigPath())) return;

  console.log(chalk.bold("\nHow do you want to receive updates?"));
  console.log(
    chalk.dim(
      "  Stable ships every Thursday. Nightly ships daily Fri–Tue. Manual stays put.",
    ),
  );
  console.log(
    chalk.dim(
      "  You can switch later with `ao config set updateChannel <value>` —\n  the next `ao update` will prompt before installing the other channel's build.\n",
    ),
  );

  const promptFn = deps.prompt ?? defaultPrompt;
  let raw: UpdateChannel | "skip" | undefined;
  try {
    raw = await promptFn("Update channel:", [
      { value: "stable", label: "Stable — weekly releases. Recommended for most users.", hint: "@latest" },
      { value: "nightly", label: "Nightly — daily builds. Bleeding edge.", hint: "@nightly" },
      { value: "manual", label: "Manual — no checks. Run `ao update` yourself.", hint: "default if dismissed" },
    ]);
  } catch {
    raw = "manual";
  }

  // Never re-prompt: the absence of `updateChannel` is the signal we use to
  // know we haven't asked yet, so even on dismissal we must persist *something*.
  // Validate against the schema before writing — never persist `undefined` or
  // an unrecognized string (which would corrupt the config and re-trigger
  // every Zod parse path with `.catch(undefined)` fallbacks).
  const candidate = raw === "skip" || raw === undefined ? "manual" : raw;
  const parsed = UpdateChannelSchema.safeParse(candidate);
  const channel: UpdateChannel = parsed.success ? parsed.data : "manual";
  persistUpdateChannel(channel);
  console.log(chalk.green(`  ✓ Update channel set to ${chalk.bold(channel)}`));
  console.log(
    chalk.dim(`  Change it later with: ao config set updateChannel <stable|nightly|manual>\n`),
  );
}

async function defaultPrompt(
  message: string,
  options: { value: UpdateChannel | "skip"; label: string; hint?: string }[],
): Promise<UpdateChannel | "skip"> {
  return promptSelect<UpdateChannel | "skip">(message, options);
}
