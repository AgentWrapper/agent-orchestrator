// Derived session status, split out of api.ts so pure view-model modules can
// use it — api.ts chains through config.ts into AsyncStorage and react-native,
// so nothing importing a value from it is unit-testable.
//
// Re-exported from api.ts, so existing call sites are unchanged.
import type { DashboardSession } from "./api";
import type { AttentionLevel } from "./theme";

const TERMINAL_STATUSES = new Set(["killed", "terminated", "done", "cleanup", "errored", "merged"]);

export function isTerminalStatus(status?: string | null): boolean {
	return !!status && TERMINAL_STATUSES.has(status);
}

// Fallback attention bucket when the server didn't compute attentionLevel.
export function attentionOf(s: DashboardSession): AttentionLevel {
	if (s.attentionLevel) return s.attentionLevel as AttentionLevel;
	const pr = s.pr ?? s.prs?.[0];
	if (s.status === "merged" || s.status === "done" || isTerminalStatus(s.status)) return "done";
	if (pr?.mergeability?.mergeable || s.status === "mergeable" || s.status === "approved") return "merge";
	if (s.status === "needs_input" || s.status === "stuck" || s.status === "errored") return "respond";
	if (
		pr?.ciStatus === "failing" ||
		pr?.reviewDecision === "changes_requested" ||
		s.status === "ci_failed" ||
		s.status === "changes_requested"
	)
		return "review";
	if (s.status === "pr_open" || s.status === "review_pending") return "pending";
	return "working";
}
