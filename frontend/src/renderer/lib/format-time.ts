import { t } from "../i18n";
import { activeLocale } from "../stores/locale-store";

/** Compact relative time — ported from agent-orchestrator session-detail-utils. */
export function formatTimeCompact(isoDate: string | null | undefined): string {
	const locale = activeLocale();
	if (!isoDate) return t(locale, "time.justNow");
	const ts = new Date(isoDate).getTime();
	if (!Number.isFinite(ts)) return t(locale, "time.justNow");
	const diffMs = Date.now() - ts;
	if (diffMs <= 0) return t(locale, "time.justNow");
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMins / 60);
	if (diffMins < 1) return t(locale, "time.justNow");
	if (diffMins < 60) return t(locale, "time.minutesAgo", { n: diffMins });
	if (diffHours < 24) return t(locale, "time.hoursAgo", { n: diffHours });
	return t(locale, "time.daysAgo", { n: Math.floor(diffHours / 24) });
}
