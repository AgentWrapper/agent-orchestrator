#!/usr/bin/env node
/**
 * Standalone entry point for the Telegram inbound listener.
 *
 * Reads `notifiers.telegram.*` from the AO config (or $AO_CONFIG_PATH) and
 * long-polls for replies / button presses, routing each into its session via
 * `ao send`. Run directly (`ao-telegram-listen`) or auto-spawned by the notifier.
 */
import { runListener } from "./listener.js";

runListener().catch((err) => {
  console.error(`[telegram-listener] fatal: ${(err as Error).message}`);
  process.exit(1);
});
