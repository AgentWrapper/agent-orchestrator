import { appI18n } from "../i18n";

/** Compact relative time — ported from agent-orchestrator session-detail-utils. */
export function formatTimeCompact(isoDate: string | null | undefined): string {
	if (!isoDate) return appI18n.t("time.justNow");
	const ts = new Date(isoDate).getTime();
	if (!Number.isFinite(ts)) return appI18n.t("time.justNow");
	const diffMs = Date.now() - ts;
	if (diffMs <= 0) return appI18n.t("time.justNow");
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMins / 60);
	if (diffMins < 1) return appI18n.t("time.justNow");
	if (diffMins < 60) return appI18n.t("time.minutesAgo", { n: diffMins });
	if (diffHours < 24) return appI18n.t("time.hoursAgo", { n: diffHours });
	return appI18n.t("time.daysAgo", { n: Math.floor(diffHours / 24) });
}
