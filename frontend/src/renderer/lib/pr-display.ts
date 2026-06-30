import type { SessionPRSummary } from "../hooks/useSessionScmSummary";
import { sortedPRs, type PRState, type PullRequestFacts, type WorkspaceSession } from "../types/workspace";

const prStateRank: Record<PRState, number> = { open: 0, draft: 1, merged: 2, closed: 3 };
const ciStates = new Set<SessionPRSummary["ci"]["state"]>(["unknown", "pending", "passing", "failing"]);
const reviewDecisions = new Set<SessionPRSummary["review"]["decision"]>([
	"none",
	"approved",
	"changes_requested",
	"review_required",
]);
const mergeabilityStates = new Set<SessionPRSummary["mergeability"]["state"]>([
	"unknown",
	"mergeable",
	"conflicting",
	"blocked",
	"unstable",
]);

export type PRDisplayTone = "neutral" | "passive" | "success" | "warning" | "error";

export type PRStatusRow = {
	key: "ci" | "review" | "merge";
	label: string;
	value: string;
	detail?: string;
	tone: PRDisplayTone;
};

export type PRAttentionLink = {
	label: string;
	href?: string;
	title?: string;
};

export type PRAttentionItem = {
	kind: "draft" | "ci_failing" | "review_changes_requested" | "review_pending" | "merge_conflict" | "merge_blocked";
	title: string;
	summary?: string;
	links: PRAttentionLink[];
	overflowLabel?: string;
	tone: PRDisplayTone;
};

export function comparePRDisplaySummaries(a: SessionPRSummary, b: SessionPRSummary): number {
	return prStateRank[a.state] - prStateRank[b.state] || a.number - b.number;
}

export function prBrowserUrl(pr: SessionPRSummary): string {
	return prBaseUrl(pr) ?? pr.htmlUrl ?? pr.url;
}

export function sessionPRDisplaySummaries(
	session: WorkspaceSession,
	summaries: SessionPRSummary[] = [],
): SessionPRSummary[] {
	const summariesByNumber = new Map(summaries.map((summary) => [summary.number, summary]));
	const seen = new Set<number>();
	const fromFacts = sortedPRs(session).map((pr) => {
		seen.add(pr.number);
		return summariesByNumber.get(pr.number) ?? sessionPRFactToSummary(session, pr);
	});
	const summaryOnly = summaries.filter((summary) => !seen.has(summary.number));
	return [...fromFacts, ...summaryOnly].sort(comparePRDisplaySummaries);
}

function sessionPRFactToSummary(session: WorkspaceSession, pr: PullRequestFacts): SessionPRSummary {
	return {
		url: pr.url,
		htmlUrl: pr.url,
		number: pr.number,
		title: session.title,
		state: pr.state,
		provider: "github",
		repo: session.workspaceName,
		author: "",
		sourceBranch: session.branch,
		targetBranch: "",
		headSha: "",
		additions: 0,
		deletions: 0,
		changedFiles: 0,
		ci: {
			state: toCIState(pr.ci),
			failingChecks: [],
		},
		review: {
			decision: toReviewDecision(pr.review),
			hasUnresolvedHumanComments: pr.reviewComments,
			unresolvedBy: [],
		},
		mergeability: {
			state: toMergeabilityState(pr.mergeability),
			reasons: [],
			prUrl: pr.url,
			conflictFiles: [],
		},
		updatedAt: pr.updatedAt,
		observedAt: pr.updatedAt,
		ciObservedAt: pr.updatedAt,
		reviewObservedAt: pr.updatedAt,
	};
}

export function prStatusRows(pr: SessionPRSummary): PRStatusRow[] {
	return [
		{
			key: "ci",
			label: "CI",
			value: ciLabel(pr.ci.state),
			tone: ciTone(pr.ci.state),
		},
		{
			key: "review",
			label: "Review",
			value: reviewLabel(pr.review.decision),
			tone: reviewTone(pr.review.decision, pr.review.hasUnresolvedHumanComments),
		},
		{
			key: "merge",
			label: "Merge",
			value: mergeabilityLabel(pr.mergeability.state),
			detail: formatDiffSummary(pr),
			tone: mergeabilityTone(pr.mergeability.state),
		},
	];
}

export function prDiffSummary(pr: SessionPRSummary): string | undefined {
	const parts: string[] = [];
	if (pr.changedFiles > 0) {
		parts.push(`${pr.changedFiles} ${pluralize("file", pr.changedFiles)}`);
	}
	const lineDelta = formatLineDelta(pr.additions, pr.deletions);
	if (lineDelta) {
		parts.push(lineDelta);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function prAttentionItems(pr: SessionPRSummary): PRAttentionItem[] {
	if (pr.state === "merged" || pr.state === "closed") {
		return [];
	}
	if (pr.state === "draft") {
		return [
			{
				kind: "draft",
				title: "Draft PR",
				summary: "Not ready for review",
				links: [],
				tone: "passive",
			},
		];
	}

	const items: PRAttentionItem[] = [];
	if (pr.mergeability.state === "conflicting") {
		items.push(
			mergeAttention(pr, "merge_conflict", "Resolve merge conflict", "Conflicts with the base branch", "error"),
		);
	} else if (pr.mergeability.state === "blocked" || pr.mergeability.state === "unstable") {
		items.push(mergeAttention(pr, "merge_blocked", "Merge blocked", "Provider reports merge is blocked", "warning"));
	}
	if (pr.ci.state === "failing") {
		const links = pr.ci.failingChecks.slice(0, 3).map((check) => ({
			label: check.name,
			href: check.url || undefined,
			title: check.conclusion || check.status,
		}));
		items.push({
			kind: "ci_failing",
			title: "Fix failing CI",
			summary: links.length === 0 ? "No failing check link observed" : undefined,
			links,
			overflowLabel: overflowLabel(pr.ci.failingChecks.length, 3, "check"),
			tone: "error",
		});
	}
	if (pr.review.decision === "changes_requested" || pr.review.hasUnresolvedHumanComments) {
		const reviewers = pr.review.unresolvedBy.slice(0, 3);
		const links = reviewers.map((reviewer) => reviewAttentionLink(pr, reviewer));
		if (links.length === 0 && pr.review.decision === "changes_requested") {
			links.push({ label: "PR", href: prBrowserUrl(pr), title: "Open pull request" });
		}
		items.push({
			kind: "review_changes_requested",
			title: "Address requested changes",
			summary: links.length === 0 ? "Requested changes still active" : undefined,
			links,
			overflowLabel: overflowLabel(pr.review.unresolvedBy.length, 3, "reviewer"),
			tone: "warning",
		});
	} else if (pr.review.decision === "review_required") {
		items.push({
			kind: "review_pending",
			title: "Review pending",
			summary: "Required review not submitted",
			links: [],
			tone: "neutral",
		});
	}
	return items;
}

function toCIState(value: string): SessionPRSummary["ci"]["state"] {
	return ciStates.has(value as SessionPRSummary["ci"]["state"])
		? (value as SessionPRSummary["ci"]["state"])
		: "unknown";
}

function toReviewDecision(value: string): SessionPRSummary["review"]["decision"] {
	return reviewDecisions.has(value as SessionPRSummary["review"]["decision"])
		? (value as SessionPRSummary["review"]["decision"])
		: "none";
}

function toMergeabilityState(value: string): SessionPRSummary["mergeability"]["state"] {
	return mergeabilityStates.has(value as SessionPRSummary["mergeability"]["state"])
		? (value as SessionPRSummary["mergeability"]["state"])
		: "unknown";
}

function ciLabel(state: SessionPRSummary["ci"]["state"]): string {
	switch (state) {
		case "passing":
			return "Passing";
		case "failing":
			return "Failing";
		case "pending":
			return "Pending";
		case "unknown":
			return "Checking";
	}
}

function ciTone(state: SessionPRSummary["ci"]["state"]): PRDisplayTone {
	switch (state) {
		case "passing":
			return "success";
		case "failing":
			return "error";
		case "pending":
			return "neutral";
		case "unknown":
			return "passive";
	}
}

function reviewLabel(decision: SessionPRSummary["review"]["decision"]): string {
	switch (decision) {
		case "approved":
			return "Approved";
		case "changes_requested":
			return "Changes requested";
		case "review_required":
			return "Pending";
		case "none":
			return "None";
	}
}

function reviewTone(
	decision: SessionPRSummary["review"]["decision"],
	hasUnresolvedHumanComments: boolean,
): PRDisplayTone {
	switch (decision) {
		case "approved":
			return "success";
		case "changes_requested":
			return "warning";
		case "review_required":
			return "neutral";
		case "none":
			return hasUnresolvedHumanComments ? "warning" : "passive";
	}
}

function mergeabilityLabel(state: SessionPRSummary["mergeability"]["state"]): string {
	switch (state) {
		case "mergeable":
			return "Mergeable";
		case "conflicting":
			return "Conflict";
		case "blocked":
			return "Blocked";
		case "unstable":
			return "Unstable";
		case "unknown":
			return "Checking";
	}
}

function mergeabilityTone(state: SessionPRSummary["mergeability"]["state"]): PRDisplayTone {
	switch (state) {
		case "mergeable":
			return "success";
		case "conflicting":
			return "error";
		case "blocked":
		case "unstable":
			return "warning";
		case "unknown":
			return "passive";
	}
}

function formatDiffSummary(pr: SessionPRSummary): string | undefined {
	if (pr.changedFiles > 0) {
		return `${pr.changedFiles} ${pluralize("file", pr.changedFiles)}`;
	}
	const changedLines = pr.additions + pr.deletions;
	if (changedLines > 0) {
		return `${changedLines} ${pluralize("line", changedLines)}`;
	}
	return undefined;
}

function formatLineDelta(additions: number, deletions: number): string | undefined {
	const parts: string[] = [];
	if (additions > 0) {
		parts.push(`+${additions}`);
	}
	if (deletions > 0) {
		parts.push(`-${deletions}`);
	}
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function mergeAttention(
	pr: SessionPRSummary,
	kind: Extract<PRAttentionItem["kind"], "merge_conflict" | "merge_blocked">,
	title: string,
	fallback: string,
	tone: PRDisplayTone,
): PRAttentionItem {
	const href =
		kind === "merge_conflict" ? mergeConflictUrl(pr) : pr.mergeability.prUrl || pr.htmlUrl || pr.url || undefined;
	const fileLinks = (pr.mergeability.conflictFiles ?? []).slice(0, 3).map((file) => ({
		label: file.path,
		href: file.url || href,
		title: kind === "merge_conflict" ? "Open merge conflicts" : undefined,
	}));
	const reasonLinks =
		fileLinks.length > 0 || kind === "merge_conflict"
			? []
			: pr.mergeability.reasons.slice(0, 3).map((reason) => ({
					label: mergeReasonLabel(reason),
					href,
				}));
	const fallbackLink =
		kind === "merge_conflict" && href ? [{ label: "conflicts", href, title: "Open merge conflicts" }] : [];
	const links = fileLinks.length > 0 ? fileLinks : reasonLinks.length > 0 ? reasonLinks : fallbackLink;
	return {
		kind,
		title,
		summary: links.length === 0 ? fallback : undefined,
		links,
		overflowLabel:
			fileLinks.length > 0
				? overflowLabel(pr.mergeability.conflictFiles?.length ?? 0, 3, "file")
				: overflowLabel(pr.mergeability.reasons.length, 3, "reason"),
		tone,
	};
}

function mergeConflictUrl(pr: SessionPRSummary): string | undefined {
	return prSubpageUrl(pr, "conflicts") ?? pr.mergeability.prUrl ?? prBrowserUrl(pr);
}

function prBaseUrl(pr: SessionPRSummary): string | undefined {
	return prURL(pr);
}

function prSubpageUrl(pr: SessionPRSummary, subpage: "conflicts"): string | undefined {
	const base = prURL(pr);
	return base ? `${base}/${subpage}` : undefined;
}

function prURL(pr: SessionPRSummary): string | undefined {
	const raw = pr.htmlUrl || pr.mergeability.prUrl || pr.url;
	if (!raw) {
		return undefined;
	}
	try {
		const url = new URL(raw);
		const match = url.pathname.match(/^(\/[^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)(?:\/.*)?$/);
		if (!match) {
			return undefined;
		}
		url.pathname = `${match[1]}/pull/${match[2]}`;
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

function reviewerLabel(reviewer: SessionPRSummary["review"]["unresolvedBy"][number]): string {
	const name = reviewerDisplayName(reviewer);
	if (reviewer.count <= 1) {
		return name;
	}
	return `${name} +${reviewer.count - 1}`;
}

function reviewerDisplayName(reviewer: SessionPRSummary["review"]["unresolvedBy"][number]): string {
	return reviewer.isBot ? `${reviewer.reviewerId} bot` : reviewer.reviewerId;
}

function reviewAttentionLink(
	pr: SessionPRSummary,
	reviewer: SessionPRSummary["review"]["unresolvedBy"][number],
): PRAttentionLink {
	const inlineURL = reviewer.links.find((link) => link.url)?.url;
	if (reviewer.reviewUrl) {
		return {
			label: reviewerLabel(reviewer),
			href: reviewer.reviewUrl,
			title: `Open requested-changes review from ${reviewerDisplayName(reviewer)}`,
		};
	}
	if (inlineURL) {
		return {
			label: reviewerLabel(reviewer),
			href: inlineURL,
			title:
				reviewer.count > 0
					? `${reviewer.count} unresolved ${pluralize("comment", reviewer.count)} from ${reviewerDisplayName(reviewer)}`
					: `Open review comments from ${reviewerDisplayName(reviewer)}`,
		};
	}
	return {
		label: reviewerLabel(reviewer),
		href: prBrowserUrl(pr),
		title: `Open pull request for ${reviewerDisplayName(reviewer)}`,
	};
}

function mergeReasonLabel(reason: string): string {
	switch (reason) {
		case "behind_base":
			return "branch behind base";
		case "ci_failing":
			return "CI failing";
		case "changes_requested":
			return "changes requested";
		case "review_required":
			return "review required";
		case "blocked_by_provider":
			return "provider blocked";
		default:
			return reason.replaceAll("_", " ");
	}
}

function overflowLabel(total: number, shown: number, noun: string): string | undefined {
	const extra = total - shown;
	if (extra <= 0) {
		return undefined;
	}
	return `+${extra} ${pluralize(noun, extra)}`;
}

function pluralize(noun: string, count: number): string {
	return count === 1 ? noun : `${noun}s`;
}
