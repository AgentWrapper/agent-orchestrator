import { execFile, execFileSync } from "node:child_process";
import { platform } from "node:os";
import {
  escapeAppleScript,
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type EventPriority,
} from "@aoagents/ao-core";

export const manifest = {
  name: "desktop",
  slot: "notifier" as const,
  description: "Notifier plugin: OS desktop notifications",
  version: "0.1.0",
};

// Re-export for backwards compatibility
export { escapeAppleScript } from "@aoagents/ao-core";

/**
 * Map event priority to notification urgency:
 * - urgent: sound alert
 * - action: normal notification
 * - info/warning: silent
 */
function shouldPlaySound(priority: EventPriority, soundEnabled: boolean): boolean {
  if (!soundEnabled) return false;
  return priority === "urgent";
}

function formatTitle(event: OrchestratorEvent): string {
  const prefix = event.priority === "urgent" ? "URGENT" : "Agent Orchestrator";
  return `${prefix} [${event.sessionId}]`;
}

function formatMessage(event: OrchestratorEvent): string {
  return event.message;
}

function formatActionsMessage(event: OrchestratorEvent, actions: NotifyAction[]): string {
  const actionLabels = actions.map((a) => a.label).join(" | ");
  return `${event.message}\n\nActions: ${actionLabels}`;
}

/** Check once at create() time whether terminal-notifier is available. */
function detectTerminalNotifier(): boolean {
  try {
    execFileSync("which", ["terminal-notifier"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a desktop notification using terminal-notifier / osascript (macOS) or
 * notify-send (Linux). Falls back gracefully if neither is available.
 *
 * On macOS, when `terminal-notifier` is installed, notifications support
 * click-to-open: clicking the banner opens `openUrl` in the default browser.
 * Without it, the osascript fallback is used (no click-through).
 */
function sendNotification(
  title: string,
  message: string,
  options: {
    sound: boolean;
    isUrgent: boolean;
    useTerminalNotifier: boolean;
    openUrl?: string;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const os = platform();

    if (os === "darwin") {
      if (options.useTerminalNotifier) {
        const args = ["-title", title, "-message", message];
        if (options.openUrl) {
          args.push("-open", options.openUrl);
        }
        if (options.sound) {
          args.push("-sound", "default");
        }
        execFile("terminal-notifier", args, (err) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        const safeTitle = escapeAppleScript(title);
        const safeMessage = escapeAppleScript(message);
        const soundClause = options.sound ? ' sound name "default"' : "";
        const script = `display notification "${safeMessage}" with title "${safeTitle}"${soundClause}`;
        execFile("osascript", ["-e", script], (err) => {
          if (err) reject(err);
          else resolve();
        });
      }
    } else if (os === "linux") {
      // Linux urgency is driven by event priority, not the macOS sound config
      const args: string[] = [];
      if (options.isUrgent) {
        args.push("--urgency=critical");
      }
      args.push(title, message);
      execFile("notify-send", args, (err) => {
        if (err) reject(err);
        else resolve();
      });
    } else {
      console.warn(`[notifier-desktop] Desktop notifications not supported on ${os}`);
      resolve();
    }
  });
}

export function create(config?: Record<string, unknown>): Notifier {
  const soundEnabled = typeof config?.sound === "boolean" ? config.sound : true;
  const dashboardUrl = typeof config?.dashboardUrl === "string" ? config.dashboardUrl : undefined;
  const hasTerminalNotifier = platform() === "darwin" && detectTerminalNotifier();

  return {
    name: "desktop",

    async notify(event: OrchestratorEvent): Promise<void> {
      const title = formatTitle(event);
      const message = formatMessage(event);
      const sound = shouldPlaySound(event.priority, soundEnabled);
      const isUrgent = event.priority === "urgent";
      await sendNotification(title, message, {
        sound,
        isUrgent,
        useTerminalNotifier: hasTerminalNotifier,
        openUrl: dashboardUrl,
      });
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      // Desktop notifications cannot display interactive action buttons.
      // Actions are rendered as text labels in the notification body as a fallback.
      const title = formatTitle(event);
      const message = formatActionsMessage(event, actions);
      const sound = shouldPlaySound(event.priority, soundEnabled);
      const isUrgent = event.priority === "urgent";
      await sendNotification(title, message, {
        sound,
        isUrgent,
        useTerminalNotifier: hasTerminalNotifier,
        openUrl: dashboardUrl,
      });
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
