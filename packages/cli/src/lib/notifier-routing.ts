import type {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  outro,
  password,
  select,
  spinner,
  text,
} from "@clack/prompts";

export const NOTIFICATION_PRIORITIES = ["urgent", "action", "warning", "info"] as const;

export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];
export type NotifierRoutingPreset = "urgent-only" | "urgent-action" | "all";
export type NotifierRoutingSelection = NotifierRoutingPreset | "preserve" | "back";

export interface ClackPrompts {
  cancel: typeof cancel;
  confirm: typeof confirm;
  intro: typeof intro;
  isCancel: typeof isCancel;
  log: typeof log;
  outro: typeof outro;
  password: typeof password;
  select: typeof select;
  spinner: typeof spinner;
  text: typeof text;
}

const ROUTING_PRESET_PRIORITIES: Record<NotifierRoutingPreset, readonly NotificationPriority[]> = {
  "urgent-only": ["urgent"],
  "urgent-action": ["urgent", "action"],
  all: ["urgent", "action", "warning", "info"],
};

export interface NotifierRoutingState {
  preset?: NotifierRoutingPreset;
  priorities: NotificationPriority[];
  hasRouting: boolean;
  isCustom: boolean;
  label: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string") return [value];
  return [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isNotifierRoutingPreset(value: string | undefined): value is NotifierRoutingPreset {
  return value === "urgent-only" || value === "urgent-action" || value === "all";
}

export function parseNotifierRoutingPreset(
  value: string | undefined,
): NotifierRoutingPreset | undefined {
  return isNotifierRoutingPreset(value) ? value : undefined;
}

export function notifierRoutingPresetValues(): string {
  return "urgent-only | urgent-action | all";
}

export function routingLabel(preset: NotifierRoutingPreset): string {
  if (preset === "all") return "All priorities";
  if (preset === "urgent-only") return "Urgent only";
  return "Urgent + action";
}

export function getNotifierRoutingState(
  rawConfig: Record<string, unknown>,
  notifierName: string,
): NotifierRoutingState {
  const routing = isRecord(rawConfig["notificationRouting"])
    ? rawConfig["notificationRouting"]
    : {};
  const priorities = NOTIFICATION_PRIORITIES.filter((priority) =>
    asStringArray(routing[priority]).includes(notifierName),
  );
  const hasRouting = priorities.length > 0;

  for (const [preset, presetPriorities] of Object.entries(ROUTING_PRESET_PRIORITIES) as Array<
    [NotifierRoutingPreset, readonly NotificationPriority[]]
  >) {
    if (
      priorities.length === presetPriorities.length &&
      presetPriorities.every((priority) => priorities.includes(priority))
    ) {
      return {
        preset,
        priorities,
        hasRouting,
        isCustom: false,
        label: routingLabel(preset),
      };
    }
  }

  return {
    priorities,
    hasRouting,
    isCustom: hasRouting,
    label: hasRouting ? priorities.join(" + ") : "not routed",
  };
}

export function ensureNotifierDefault(
  rawConfig: Record<string, unknown>,
  notifierName: string,
): void {
  const defaults = isRecord(rawConfig["defaults"]) ? rawConfig["defaults"] : {};
  defaults["notifiers"] = unique([
    ...asStringArray(defaults["notifiers"]).filter((value) => value !== notifierName),
    notifierName,
  ]);
  rawConfig["defaults"] = defaults;
}

export function applyNotifierRoutingPreset(
  rawConfig: Record<string, unknown>,
  notifierName: string,
  preset: NotifierRoutingPreset | undefined,
): void {
  if (!preset) return;

  const defaults = isRecord(rawConfig["defaults"]) ? rawConfig["defaults"] : {};
  const defaultNotifiers = asStringArray(defaults["notifiers"]);
  rawConfig["defaults"] = defaults;

  const notificationRouting = isRecord(rawConfig["notificationRouting"])
    ? rawConfig["notificationRouting"]
    : {};
  const selectedPriorities = new Set<NotificationPriority>(ROUTING_PRESET_PRIORITIES[preset]);

  for (const priority of NOTIFICATION_PRIORITIES) {
    const base = hasOwn(notificationRouting, priority)
      ? asStringArray(notificationRouting[priority])
      : defaultNotifiers;
    const next = base.filter((name) => name !== notifierName);
    if (selectedPriorities.has(priority)) next.push(notifierName);
    notificationRouting[priority] = unique(next);
  }

  rawConfig["notificationRouting"] = notificationRouting;
}

export function resolveRoutingPresetOption(
  value: string | undefined,
  label: string,
): NotifierRoutingPreset | undefined {
  if (value === undefined) return undefined;
  const parsed = parseNotifierRoutingPreset(value);
  if (parsed) return parsed;
  throw new Error(
    `Invalid ${label} routing preset "${value}". Expected ${notifierRoutingPresetValues()}.`,
  );
}

export async function promptNotifierRoutingPreset(
  clack: ClackPrompts,
  rawConfig: Record<string, unknown>,
  notifierName: string,
  notifierLabel: string,
  cancel: () => never,
): Promise<NotifierRoutingSelection> {
  const current = getNotifierRoutingState(rawConfig, notifierName);
  const choice = await clack.select({
    message: `Which notifications should ${notifierLabel} receive?`,
    initialValue: current.preset ?? "urgent-action",
    options: [
      ...(current.hasRouting
        ? [
            {
              value: "preserve",
              label: `Keep current routing (${current.label})`,
              hint: "Leave notificationRouting unchanged",
            },
          ]
        : []),
      { value: "urgent-action", label: "Urgent + action", hint: "Recommended" },
      { value: "urgent-only", label: "Urgent only" },
      { value: "all", label: "All priorities" },
      { value: "back", label: "Back", hint: "Return to the previous step" },
      { value: "cancel", label: "Cancel setup", hint: "Do not change config" },
    ],
  });

  if (clack.isCancel(choice) || choice === "cancel") {
    cancel();
  }

  if (choice === "preserve" || choice === "back") return choice;
  if (typeof choice === "string" && isNotifierRoutingPreset(choice)) return choice;
  return "urgent-action";
}
