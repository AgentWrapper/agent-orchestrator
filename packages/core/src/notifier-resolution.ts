import type { OrchestratorConfig } from "./types.js";

export interface ResolvedNotifierTarget {
  reference: string;
  pluginName: string;
}

/**
 * Resolve a notifier reference from config.
 *
 * Notification routing can point at either a notifier config key
 * (`alerts`) or a raw plugin name (`slack`). Built-in registry lookups
 * use the plugin name, so alias-based references must be resolved first.
 */
export function resolveNotifierTarget(
  config: OrchestratorConfig,
  reference: string,
): ResolvedNotifierTarget {
  const configured = config.notifiers?.[reference];
  if (configured?.plugin) {
    return {
      reference,
      pluginName: configured.plugin,
    };
  }

  return {
    reference,
    pluginName: reference,
  };
}
