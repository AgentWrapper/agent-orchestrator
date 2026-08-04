// Presentation rules for the notification history list. Pure — no React Native
// or Expo imports — so the wording and the routing decision are unit-testable,
// the same split as pushStatus.ts / push.ts.
import { DEFAULT_LOCALE, enT, type AppLocale, type TFunction } from "./i18n";
import type { Theme } from "./theme";

export type NotificationVisual = {
	icon: "message-circle" | "git-merge" | "git-pull-request" | "x-circle" | "bell";
	color: string;
	label: string;
};

/** Icon, colour and short label for one notification type. */
export function notificationVisual(t: Theme, type: string, tr: TFunction = enT): NotificationVisual {
	switch (type) {
		case "needs_input":
			return { icon: "message-circle", color: t.amber, label: tr("notifications.type.needsInput") };
		case "ready_to_merge":
			return { icon: "git-merge", color: t.green, label: tr("notifications.type.readyToMerge") };
		case "pr_merged":
			return { icon: "git-merge", color: t.blue, label: tr("notifications.type.merged") };
		case "pr_closed_unmerged":
			return { icon: "x-circle", color: t.red, label: tr("notifications.type.closed") };
		default:
			return { icon: "bell", color: t.textTertiary, label: type || tr("notifications.type.generic") };
	}
}

/**
 * Where tapping a notification should land. Mirrors the routing PushManager
 * already applies to a notification tap, so opening an item from history and
 * opening it from the tray agree — the rule lives here rather than being written
 * twice.
 */
export function notificationTarget(n: { type: string; sessionId?: string }): string {
	return n.type === "needs_input" && n.sessionId ? `/session/${n.sessionId}` : "/prs";
}

const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();

function relativeFormatter(locale: AppLocale): Intl.RelativeTimeFormat {
	let fmt = relativeFormatters.get(locale);
	if (!fmt) {
		fmt = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "narrow" });
		relativeFormatters.set(locale, fmt);
	}
	return fmt;
}

/**
 * Localized relative stamp ("3m ago" / "3分钟前" / …).
 * Returns "" for an unparseable timestamp. Sub-minute ages use `time.now`.
 */
export function relativeTime(
	iso: string,
	now: number = Date.now(),
	tr: TFunction = enT,
	locale: AppLocale = DEFAULT_LOCALE,
): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const secs = Math.max(0, Math.round((now - then) / 1000));
	if (secs < 60) return tr("time.now");
	const mins = Math.floor(secs / 60);
	if (mins < 60) return relativeFormatter(locale).format(-mins, "minute");
	const hours = Math.floor(mins / 60);
	if (hours < 24) return relativeFormatter(locale).format(-hours, "hour");
	const days = Math.floor(hours / 24);
	if (days < 7) return relativeFormatter(locale).format(-days, "day");
	return relativeFormatter(locale).format(-Math.floor(days / 7), "week");
}
