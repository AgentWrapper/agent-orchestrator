import { execFile } from "node:child_process";
import { platform } from "node:os";
import {
  escapeAppleScript,
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type EventPriority,
} from "@aoagents/ao-core";

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildWindowsToastScript(title: string, message: string, sound: boolean): string {
  // Build the toast XML — both fields are user content, so XML-escape them.
  const safeTitle = xmlEscape(title);
  const safeMessage = xmlEscape(message);
  const audioNode = sound ? "" : '<audio silent="true" />';
  const xml = `<toast>${audioNode}<visual><binding template="ToastGeneric"><text>${safeTitle}</text><text>${safeMessage}</text></binding></visual></toast>`;

  // PowerShell script — uses WinRT directly (no BurntToast dep). The XML is
  // injected as a single-quoted PS string with embedded apostrophes doubled.
  const psSafeXml = xml.replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
    "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml('${psSafeXml}')`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Agent Orchestrator').Show($toast)",
  ].join("; ");
}

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

/**
 * Send a desktop notification using osascript (macOS) or notify-send (Linux).
 * Falls back gracefully if neither is available.
 *
 * Note: Desktop notifications do not support click-through URLs natively.
 * On macOS, osascript's `display notification` lacks URL support.
 * Consider `terminal-notifier` for click-to-open if needed in the future.
 */
function sendNotification(
  title: string,
  message: string,
  options: { sound: boolean; isUrgent: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const os = platform();

    if (os === "darwin") {
      const safeTitle = escapeAppleScript(title);
      const safeMessage = escapeAppleScript(message);
      const soundClause = options.sound ? ' sound name "default"' : "";
      const script = `display notification "${safeMessage}" with title "${safeTitle}"${soundClause}`;
      execFile("osascript", ["-e", script], (err) => {
        if (err) reject(err);
        else resolve();
      });
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
    } else if (os === "win32") {
      // WinRT toast via PowerShell — no third-party deps. Encode the script
      // as UTF-16LE base64 so we never fight with PowerShell's argument
      // tokenizer over quotes, special chars, or newlines in the toast XML.
      const script = buildWindowsToastScript(title, message, options.sound);
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { windowsHide: true, timeout: 10_000 },
        (err) => {
          if (err) {
            // Don't crash the lifecycle on toast failures — log and resolve.
            // Common causes: stripped-down Windows SKU without WinRT, locked
            // group policy, or the user disabled toast notifications.
            console.warn(
              `[notifier-desktop] Windows toast failed: ${(err as Error).message}`,
            );
          }
          resolve();
        },
      );
    } else {
      console.warn(`[notifier-desktop] Desktop notifications not supported on ${os}`);
      resolve();
    }
  });
}

export function create(config?: Record<string, unknown>): Notifier {
  const soundEnabled = typeof config?.sound === "boolean" ? config.sound : true;

  return {
    name: "desktop",

    async notify(event: OrchestratorEvent): Promise<void> {
      const title = formatTitle(event);
      const message = formatMessage(event);
      const sound = shouldPlaySound(event.priority, soundEnabled);
      const isUrgent = event.priority === "urgent";
      await sendNotification(title, message, { sound, isUrgent });
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      // Desktop notifications cannot display interactive action buttons.
      // Actions are rendered as text labels in the notification body as a fallback.
      const title = formatTitle(event);
      const message = formatActionsMessage(event, actions);
      const sound = shouldPlaySound(event.priority, soundEnabled);
      const isUrgent = event.priority === "urgent";
      await sendNotification(title, message, { sound, isUrgent });
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
