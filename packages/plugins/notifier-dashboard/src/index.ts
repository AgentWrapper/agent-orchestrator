import {
  appendDashboardNotification,
  normalizeDashboardNotificationLimit,
  type Notifier,
  type NotifyAction,
  type OrchestratorEvent,
  type PluginModule,
} from "@aoagents/ao-core";

export const manifest = {
  name: "dashboard",
  slot: "notifier" as const,
  description: "Notifier plugin: AO dashboard notifications",
  version: "0.1.0",
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function create(config?: Record<string, unknown>): Notifier {
  const configPath = stringValue(config?.configPath);
  const limit = normalizeDashboardNotificationLimit(config?.limit);
  let warnedMissingConfigPath = false;

  function persist(event: OrchestratorEvent, actions?: NotifyAction[]): void {
    if (!configPath) {
      if (!warnedMissingConfigPath) {
        console.warn(
          "[notifier-dashboard] No configPath available - dashboard notifications will be no-ops",
        );
        warnedMissingConfigPath = true;
      }
      return;
    }

    appendDashboardNotification(configPath, event, actions, { limit });
  }

  return {
    name: "dashboard",

    async notify(event: OrchestratorEvent): Promise<void> {
      persist(event);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      persist(event, actions);
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
