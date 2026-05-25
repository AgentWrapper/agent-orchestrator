import type { EventPriority, OrchestratorConfig } from "./types.js";

export interface ResolvedNotifierTarget {
  reference: string;
  pluginName: string;
}

const DESKTOP_IMPLICIT_PRIORITIES = new Set<EventPriority>(["urgent", "warning"]);

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Resolve notifier enablement for a notification priority.
 *
 * Explicit `notificationRouting.<priority>` entries are authoritative. When a
 * priority has no explicit route, AO applies its built-in default policy over
 * `defaults.notifiers`: dashboard receives all priorities, desktop receives
 * urgent + warning, and custom default notifiers keep the historical
 * all-priorities fallback behavior.
 */
export function resolveNotificationRoute(
  config: Pick<OrchestratorConfig, "defaults" | "notificationRouting">,
  priority: EventPriority,
): string[] {
  const routing = (config.notificationRouting ?? {}) as Record<string, unknown>;
  if (hasOwn(routing, priority)) {
    return unique(asStringArray(routing[priority]));
  }

  const defaultNotifiers = unique(asStringArray(config.defaults?.notifiers));
  const resolved: string[] = [];

  if (DESKTOP_IMPLICIT_PRIORITIES.has(priority) && defaultNotifiers.includes("desktop")) {
    resolved.push("desktop");
  }

  for (const notifierName of defaultNotifiers) {
    if (notifierName === "desktop") continue;
    resolved.push(notifierName);
  }

  return unique(resolved);
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
