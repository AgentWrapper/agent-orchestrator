import type { SupportedLocale } from "../../shared/locale";
import { i18n } from "../i18n";

function currentLocale(): SupportedLocale {
	return i18n.resolvedLanguage?.startsWith("zh") ? "zh-CN" : "en";
}

function justNow(locale: SupportedLocale): string {
	return i18n.getFixedT(locale)("time.justNow");
}

/** Compact relative time — ported from agent-orchestrator session-detail-utils. */
export function formatTimeCompact(
	isoDate: string | null | undefined,
	locale: SupportedLocale = currentLocale(),
	now = Date.now(),
): string {
	if (!isoDate) return justNow(locale);
	const ts = Date.parse(isoDate);
	if (!Number.isFinite(ts)) return justNow(locale);
	const diffMs = now - ts;
	if (diffMs <= 0) return justNow(locale);
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMins / 60);
	if (diffMins < 1) return justNow(locale);
	const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "narrow" });
	if (diffMins < 60) return formatter.format(-diffMins, "minute");
	if (diffHours < 24) return formatter.format(-diffHours, "hour");
	return formatter.format(-Math.floor(diffHours / 24), "day");
}

export function formatDateTime(
	isoDate: string | null | undefined,
	locale: SupportedLocale = currentLocale(),
	options: Intl.DateTimeFormatOptions = {},
): string {
	if (!isoDate) return justNow(locale);
	const timestamp = Date.parse(isoDate);
	if (!Number.isFinite(timestamp)) return justNow(locale);
	return new Intl.DateTimeFormat(locale, {
		dateStyle: "medium",
		timeStyle: "short",
		...options,
	}).format(timestamp);
}
