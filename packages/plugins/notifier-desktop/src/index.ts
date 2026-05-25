import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  buildNotificationPresentation,
  escapeAppleScript,
  getNotificationDataV3,
  isMac,
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

type DesktopBackend = "auto" | "ao-app" | "terminal-notifier" | "osascript";
const PLACEHOLDER_MARKER_NAME = "ao-notifier-placeholder";

interface MacDeliveryOptions {
  backend: DesktopBackend;
  appPath: string;
  useTerminalNotifier: boolean;
}

interface DesktopNotificationContent {
  title: string;
  subtitle?: string;
  body: string;
}

interface NativeActionPayload {
  label: string;
  url?: string;
  callbackEndpoint?: string;
}

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

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatSubtitle(event: OrchestratorEvent): string {
  const data = getNotificationDataV3(event.data);
  const segments = [event.projectId, event.sessionId];
  const pr = data?.subject.pr;
  if (pr) segments.push(`PR #${pr.number}`);
  return truncate(segments.join(" · "), 120);
}

function formatContent(event: OrchestratorEvent): DesktopNotificationContent {
  const presentation = buildNotificationPresentation(event);
  return {
    title: presentation.title,
    subtitle: formatSubtitle(event),
    body: presentation.body,
  };
}

function defaultMacAppPath(): string {
  return join(homedir(), "Applications", "AO Notifier.app");
}

function macAppExecutable(appPath: string): string {
  return join(appPath, "Contents", "MacOS", "ao-notifier");
}

function macAppPlaceholderMarker(appPath: string): string {
  return join(appPath, "Contents", "Resources", PLACEHOLDER_MARKER_NAME);
}

function nativeNotificationId(event: OrchestratorEvent, sequence: number): string {
  return `${event.id}.${Date.now()}.${process.pid}.${sequence}`;
}

function nativeThreadId(): string {
  return "ao.notifications";
}

function detectAoNotifierApp(appPath: string): boolean {
  return existsSync(macAppExecutable(appPath)) && !existsSync(macAppPlaceholderMarker(appPath));
}

function parseBackend(value: unknown): DesktopBackend {
  if (
    value === "auto" ||
    value === "ao-app" ||
    value === "terminal-notifier" ||
    value === "osascript"
  ) {
    return value;
  }
  return "auto";
}

function dashboardSessionUrl(
  dashboardUrl: string | undefined,
  event: OrchestratorEvent,
): string | undefined {
  if (!dashboardUrl) return undefined;
  try {
    const base = new URL(dashboardUrl);
    base.pathname = `/projects/${encodeURIComponent(event.projectId)}/sessions/${encodeURIComponent(event.sessionId)}`;
    base.search = "";
    base.hash = "";
    return base.toString();
  } catch {
    return dashboardUrl;
  }
}

function firstUrlAction(actions: NotifyAction[] | undefined): string | undefined {
  return actions?.find((action) => typeof action.url === "string")?.url;
}

function isAbsoluteHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveCallbackEndpoint(
  callbackEndpoint: string | undefined,
  dashboardUrl: string | undefined,
): string | undefined {
  if (isAbsoluteHttpUrl(callbackEndpoint)) return callbackEndpoint;
  if (!callbackEndpoint || !dashboardUrl) return undefined;
  try {
    const resolved = new URL(callbackEndpoint, dashboardUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function nativeActionPayload(
  action: NotifyAction,
  dashboardUrl: string | undefined,
): NativeActionPayload | undefined {
  if (typeof action.url === "string") {
    return { label: action.label, url: action.url };
  }
  const callbackEndpoint = resolveCallbackEndpoint(action.callbackEndpoint, dashboardUrl);
  return callbackEndpoint ? { label: action.label, callbackEndpoint } : undefined;
}

function nativeActionPayloads(
  actions: NotifyAction[] | undefined,
  dashboardUrl: string | undefined,
): NativeActionPayload[] {
  return (actions ?? [])
    .map((action) => nativeActionPayload(action, dashboardUrl))
    .filter((action): action is NativeActionPayload => Boolean(action))
    .slice(0, 4);
}

function firstActionTarget(
  actions: NotifyAction[] | undefined,
  dashboardUrl: string | undefined,
): string | undefined {
  for (const action of actions ?? []) {
    const target = action.url ?? resolveCallbackEndpoint(action.callbackEndpoint, dashboardUrl);
    if (target) return target;
  }
  return undefined;
}

function primaryOpenUrl(
  event: OrchestratorEvent,
  dashboardUrl: string | undefined,
  actions?: NotifyAction[],
): string | undefined {
  return (
    dashboardSessionUrl(dashboardUrl, event) ??
    getNotificationDataV3(event.data)?.subject.pr?.url ??
    firstUrlAction(actions) ??
    firstActionTarget(actions, dashboardUrl)
  );
}

/** Check once at create() time whether terminal-notifier is available. */
function detectTerminalNotifier(): boolean {
  try {
    execFileSync("terminal-notifier", ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
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
  content: DesktopNotificationContent,
  event: OrchestratorEvent,
  options: {
    sound: boolean;
    isUrgent: boolean;
    mac: MacDeliveryOptions;
    notificationId: string;
    openUrl?: string;
    actions?: NativeActionPayload[];
    fallbackContent?: DesktopNotificationContent;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const os = platform();

    if (os === "darwin") {
      const backend =
        options.mac.backend === "auto"
          ? detectAoNotifierApp(options.mac.appPath)
            ? "ao-app"
            : options.mac.useTerminalNotifier
              ? "terminal-notifier"
              : "osascript"
          : options.mac.backend;

      if (backend === "ao-app") {
        if (!detectAoNotifierApp(options.mac.appPath)) {
          reject(new Error("AO Notifier.app is not installed. Run: ao setup desktop"));
          return;
        }

        const payload = {
          notificationId: options.notificationId,
          threadId: nativeThreadId(),
          title: content.title,
          subtitle: content.subtitle,
          body: content.body,
          sound: options.sound,
          defaultOpenUrl: options.openUrl,
          event: {
            id: event.id,
            type: event.type,
            priority: event.priority,
            sessionId: event.sessionId,
            projectId: event.projectId,
            timestamp: event.timestamp.toISOString(),
          },
          actions: (options.actions ?? []).map((action) => ({
            label: action.label,
            url: action.url,
            callbackEndpoint: action.callbackEndpoint,
          })),
        };
        const encoded = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
        execFile(macAppExecutable(options.mac.appPath), ["--notify-base64", encoded], (err) => {
          if (err) reject(err);
          else resolve();
        });
      } else if (backend === "terminal-notifier") {
        const fallbackContent = options.fallbackContent ?? content;
        const args = ["-title", fallbackContent.title, "-message", fallbackContent.body];
        if (fallbackContent.subtitle) {
          args.push("-subtitle", fallbackContent.subtitle);
        }
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
        const fallbackContent = options.fallbackContent ?? content;
        const safeTitle = escapeAppleScript(fallbackContent.title);
        const safeSubtitle = fallbackContent.subtitle
          ? ` subtitle "${escapeAppleScript(fallbackContent.subtitle)}"`
          : "";
        const safeMessage = escapeAppleScript(fallbackContent.body);
        const soundClause = options.sound ? ' sound name "default"' : "";
        const script = `display notification "${safeMessage}" with title "${safeTitle}"${safeSubtitle}${soundClause}`;
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
      const fallbackContent = options.fallbackContent ?? content;
      args.push(fallbackContent.title, fallbackContent.body);
      execFile("notify-send", args, (err) => {
        if (err) reject(err);
        else resolve();
      });
    } else if (os === "win32") {
      // WinRT toast via PowerShell — no third-party deps. Encode the script
      // as UTF-16LE base64 so we never fight with PowerShell's argument
      // tokenizer over quotes, special chars, or newlines in the toast XML.
      const fallbackContent = options.fallbackContent ?? content;
      const script = buildWindowsToastScript(
        fallbackContent.subtitle ?? fallbackContent.title,
        fallbackContent.body,
        options.sound,
      );
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
            console.warn(`[notifier-desktop] Windows toast failed: ${(err as Error).message}`);
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
  let nativeNotificationSequence = 0;
  const soundEnabled = typeof config?.sound === "boolean" ? config.sound : true;
  const dashboardUrl = typeof config?.dashboardUrl === "string" ? config.dashboardUrl : undefined;
  const backend = parseBackend(config?.backend);
  const appPath = typeof config?.appPath === "string" ? config.appPath : defaultMacAppPath();
  const hasTerminalNotifier =
    isMac() && (backend === "auto" || backend === "terminal-notifier")
      ? detectTerminalNotifier()
      : false;
  const mac = {
    backend,
    appPath,
    useTerminalNotifier: hasTerminalNotifier,
  };
  const nextNativeNotificationId = (event: OrchestratorEvent): string => {
    nativeNotificationSequence += 1;
    return nativeNotificationId(event, nativeNotificationSequence);
  };

  return {
    name: "desktop",

    async notify(event: OrchestratorEvent): Promise<void> {
      const content = formatContent(event);
      const sound = shouldPlaySound(event.priority, soundEnabled);
      const isUrgent = event.priority === "urgent";
      await sendNotification(content, event, {
        sound,
        isUrgent,
        mac,
        notificationId: nextNativeNotificationId(event),
        openUrl: primaryOpenUrl(event, dashboardUrl),
      });
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      const nativeActions = nativeActionPayloads(actions, dashboardUrl);
      const content = formatContent(event);
      const sound = shouldPlaySound(event.priority, soundEnabled);
      const isUrgent = event.priority === "urgent";
      await sendNotification(content, event, {
        sound,
        isUrgent,
        mac,
        notificationId: nextNativeNotificationId(event),
        openUrl: primaryOpenUrl(event, dashboardUrl, actions),
        actions: nativeActions,
      });
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
