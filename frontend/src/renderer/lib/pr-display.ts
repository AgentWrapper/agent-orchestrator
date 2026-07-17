import type { SessionPRSummary } from "../hooks/useSessionScmSummary";
import { i18n } from "../i18n";
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

export type PRSummaryPartKey = "ci" | "review" | "merge";
export type PRSummaryNoun = "check" | "comment" | "file" | "line" | "reason" | "reviewer";

export type PRSummaryLink = {
	label: string;
	href?: string;
	title?: string;
};

export type PRSummaryPart = {
	key: PRSummaryPartKey;
	label: string;
	status: string;
	summary?: string;
	links: PRSummaryLink[];
	linkTotal?: number;
	overflowLabel?: string;
	overflowNoun?: PRSummaryNoun;
	tone: PRDisplayTone;
};

export function comparePRDisplaySummaries(a: SessionPRSummary, b: SessionPRSummary): number {
	return prStateRank[a.state] - prStateRank[b.state] || a.number - b.number;
}

export function changeRequestShortLabel(pr: Pick<SessionPRSummary, "provider">): "PR" | "MR" {
	return pr.provider === "gitlab" ? "MR" : "PR";
}

export function changeRequestName(pr: Pick<SessionPRSummary, "provider">, count = 1): string {
	return i18n.t(pr.provider === "gitlab" ? "changeRequests.names.gitlab" : "changeRequests.names.github", {
		count,
	});
}

export function changeRequestCollectionName(prs: Pick<SessionPRSummary, "provider">[]): string {
	const providers = new Set(prs.map((pr) => pr.provider));
	if (providers.size === 1 && providers.has("gitlab")) return changeRequestName({ provider: "gitlab" }, prs.length);
	if (providers.size <= 1) return changeRequestName({ provider: "github" }, prs.length);
	return i18n.t("changeRequests.names.mixed");
}

export function changeRequestNumber(pr: Pick<SessionPRSummary, "provider" | "number">): string {
	return `${pr.provider === "gitlab" ? "!" : "#"}${pr.number}`;
}

export function prBrowserUrl(pr: SessionPRSummary): string {
	return prBaseUrl(pr) ?? pr.htmlUrl ?? pr.url;
}

export function sessionPRDisplaySummaries(
	session: WorkspaceSession,
	summaries: SessionPRSummary[] = [],
): SessionPRSummary[] {
	const summariesByURL = new Map(summaries.map((summary) => [summary.url, summary]));
	const summariesByNumber = new Map<number, SessionPRSummary[]>();
	for (const summary of summaries) {
		const matching = summariesByNumber.get(summary.number);
		if (matching) matching.push(summary);
		else summariesByNumber.set(summary.number, [summary]);
	}
	const seen = new Set<string>();
	const fromFacts = sortedPRs(session).map((pr) => {
		const exact = summariesByURL.get(pr.url);
		const numberMatches = summariesByNumber.get(pr.number);
		const matched = exact ?? (numberMatches?.length === 1 ? numberMatches[0] : undefined);
		seen.add(matched?.url ?? pr.url);
		return matched ?? sessionPRFactToSummary(session, pr);
	});
	const summaryOnly = summaries.filter((summary) => !seen.has(summary.url));
	return [...fromFacts, ...summaryOnly].sort(comparePRDisplaySummaries);
}

function sessionPRFactToSummary(session: WorkspaceSession, pr: PullRequestFacts): SessionPRSummary {
	return {
		url: pr.url,
		htmlUrl: pr.url,
		number: pr.number,
		title: session.title,
		state: pr.state,
		provider: inferChangeRequestProvider(pr.url),
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

export function inferChangeRequestProvider(url: string): SessionPRSummary["provider"] {
	try {
		return new URL(url).pathname.includes("/-/merge_requests/") ? "gitlab" : "github";
	} catch {
		return "github";
	}
}

export function prStatusRows(pr: SessionPRSummary): PRStatusRow[] {
	return prSummaryParts(pr).map((part) => ({
		key: part.key,
		label: part.label,
		value: part.status,
		detail: part.key === "merge" ? formatDiffSummary(pr) : undefined,
		tone: part.tone,
	}));
}

export function prSummaryParts(pr: SessionPRSummary): PRSummaryPart[] {
	return [
		{
			key: "ci",
			label: i18n.t("changeRequests.parts.ci"),
			status: ciLabel(pr.ci.state),
			summary: ciSummary(pr),
			links: ciLinks(pr),
			linkTotal: pr.ci.state === "failing" ? pr.ci.failingChecks.length : 0,
			overflowLabel: pr.ci.state === "failing" ? overflowLabel(pr.ci.failingChecks.length, 3, "check") : undefined,
			overflowNoun: "check",
			tone: ciTone(pr.ci.state),
		},
		{
			key: "merge",
			label: i18n.t("changeRequests.parts.merge"),
			status: mergeabilityLabel(pr.mergeability.state),
			summary: mergeSummary(pr),
			links: mergeLinks(pr),
			linkTotal: mergeLinkTotal(pr),
			overflowLabel: mergeOverflowLabel(pr),
			overflowNoun: mergeOverflowNoun(pr),
			tone: mergeabilityTone(pr.mergeability.state),
		},
		{
			key: "review",
			label: i18n.t("changeRequests.parts.review"),
			status: reviewLabel(pr.review.decision),
			summary: reviewSummary(pr),
			links: reviewLinks(pr),
			linkTotal: reviewLinkTotal(pr),
			overflowLabel:
				pr.state === "draft" || pr.review.decision === "review_required"
					? undefined
					: overflowLabel(pr.review.unresolvedBy.length, 3, "reviewer"),
			overflowNoun: "reviewer",
			tone: reviewTone(pr.review.decision, pr.review.hasUnresolvedHumanComments),
		},
	];
}

export function prDiffSummary(pr: SessionPRSummary): string | undefined {
	const parts: string[] = [];
	if (pr.changedFiles > 0) {
		parts.push(countLabel("file", pr.changedFiles));
	}
	const lineDelta = formatLineDelta(pr.additions, pr.deletions);
	if (lineDelta) {
		parts.push(lineDelta);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function ciSummary(pr: SessionPRSummary): string | undefined {
	if (pr.ci.state === "failing") {
		return pr.ci.failingChecks.length === 0 ? i18n.t("changeRequests.summaries.noFailingCheckLink") : undefined;
	}
	return undefined;
}

function ciLinks(pr: SessionPRSummary): PRSummaryLink[] {
	if (pr.ci.state !== "failing") {
		return [];
	}
	return pr.ci.failingChecks.slice(0, 3).map((check) => ({
		label: check.name,
		href: check.url || undefined,
		title: check.conclusion || check.status,
	}));
}

function reviewSummary(pr: SessionPRSummary): string | undefined {
	if (pr.state === "merged" || pr.state === "closed") {
		return undefined;
	}
	if (pr.state === "draft") {
		return i18n.t("changeRequests.summaries.draft", { request: changeRequestShortLabel(pr) });
	}
	if (pr.review.decision === "changes_requested" || pr.review.hasUnresolvedHumanComments) {
		return reviewLinks(pr).length === 0 ? i18n.t("changeRequests.summaries.changesActive") : undefined;
	}
	if (pr.review.decision === "review_required") {
		return i18n.t("changeRequests.summaries.reviewRequired");
	}
	return undefined;
}

function reviewLinks(pr: SessionPRSummary): PRSummaryLink[] {
	if (pr.state === "merged" || pr.state === "closed" || pr.state === "draft") {
		return [];
	}
	if (pr.review.decision !== "changes_requested" && !pr.review.hasUnresolvedHumanComments) {
		return [];
	}
	const links = pr.review.unresolvedBy.slice(0, 3).map((reviewer) => reviewAttentionLink(pr, reviewer));
	if (links.length === 0 && pr.review.decision === "changes_requested") {
		links.push({
			label: changeRequestShortLabel(pr),
			href: prBrowserUrl(pr),
			title: openChangeRequestTitle(pr),
		});
	}
	return links;
}

function mergeSummary(pr: SessionPRSummary): string | undefined {
	if (pr.state === "merged" || pr.state === "closed") {
		return formatDiffSummary(pr);
	}
	if (pr.mergeability.state === "conflicting") {
		return mergeLinks(pr).length === 0 ? i18n.t("changeRequests.summaries.conflicts") : undefined;
	}
	if (pr.mergeability.state === "blocked" || pr.mergeability.state === "unstable") {
		return mergeLinks(pr).length === 0 ? i18n.t("changeRequests.summaries.providerBlocked") : undefined;
	}
	return formatDiffSummary(pr);
}

function mergeLinks(pr: SessionPRSummary): PRSummaryLink[] {
	if (pr.state === "merged" || pr.state === "closed") {
		return [];
	}
	if (pr.mergeability.state === "conflicting") {
		return mergeAttentionLinks(pr, "merge_conflict");
	}
	if (pr.mergeability.state === "blocked" || pr.mergeability.state === "unstable") {
		return mergeAttentionLinks(pr, "merge_blocked");
	}
	return [];
}

function mergeOverflowLabel(pr: SessionPRSummary): string | undefined {
	if (pr.state === "merged" || pr.state === "closed") {
		return undefined;
	}
	const hasFileLinks = (pr.mergeability.conflictFiles ?? []).length > 0;
	if (hasFileLinks) {
		return overflowLabel(pr.mergeability.conflictFiles?.length ?? 0, 3, "file");
	}
	if (pr.mergeability.state === "blocked" || pr.mergeability.state === "unstable") {
		return overflowLabel(pr.mergeability.reasons.length, 3, "reason");
	}
	return undefined;
}

function mergeLinkTotal(pr: SessionPRSummary): number {
	if (pr.state === "merged" || pr.state === "closed") {
		return 0;
	}
	if (pr.mergeability.state === "conflicting") {
		const conflictFileCount = pr.mergeability.conflictFiles?.length ?? 0;
		return conflictFileCount > 0 ? conflictFileCount : mergeLinks(pr).length;
	}
	if (pr.mergeability.state === "blocked" || pr.mergeability.state === "unstable") {
		return pr.mergeability.reasons.length;
	}
	return 0;
}

function mergeOverflowNoun(pr: SessionPRSummary): PRSummaryNoun {
	return (pr.mergeability.conflictFiles ?? []).length > 0 ? "file" : "reason";
}

function reviewLinkTotal(pr: SessionPRSummary): number {
	if (pr.state === "merged" || pr.state === "closed" || pr.state === "draft") {
		return 0;
	}
	if (pr.review.decision !== "changes_requested" && !pr.review.hasUnresolvedHumanComments) {
		return 0;
	}
	return pr.review.unresolvedBy.length > 0 ? pr.review.unresolvedBy.length : reviewLinks(pr).length;
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
			return i18n.t("changeRequests.ci.passing");
		case "failing":
			return i18n.t("changeRequests.ci.failing");
		case "pending":
			return i18n.t("changeRequests.ci.pending");
		case "unknown":
			return i18n.t("changeRequests.ci.checking");
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
			return i18n.t("changeRequests.review.approved");
		case "changes_requested":
			return i18n.t("changeRequests.review.changesRequested");
		case "review_required":
			return i18n.t("changeRequests.review.pending");
		case "none":
			return i18n.t("changeRequests.review.none");
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
			return i18n.t("changeRequests.mergeability.mergeable");
		case "conflicting":
			return i18n.t("changeRequests.mergeability.conflict");
		case "blocked":
			return i18n.t("changeRequests.mergeability.blocked");
		case "unstable":
			return i18n.t("changeRequests.mergeability.unstable");
		case "unknown":
			return i18n.t("changeRequests.mergeability.checking");
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
		return countLabel("file", pr.changedFiles);
	}
	const changedLines = pr.additions + pr.deletions;
	if (changedLines > 0) {
		return countLabel("line", changedLines);
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

function mergeAttentionLinks(pr: SessionPRSummary, kind: "merge_conflict" | "merge_blocked"): PRSummaryLink[] {
	const href =
		kind === "merge_conflict" ? mergeConflictUrl(pr) : pr.mergeability.prUrl || pr.htmlUrl || pr.url || undefined;
	const fileLinks = (pr.mergeability.conflictFiles ?? []).slice(0, 3).map((file) => ({
		label: file.path,
		href: file.url || href,
		title: kind === "merge_conflict" ? i18n.t("changeRequests.links.openMergeConflicts") : undefined,
	}));
	const reasonLinks =
		fileLinks.length > 0 || kind === "merge_conflict"
			? []
			: pr.mergeability.reasons.slice(0, 3).map((reason) => ({
					label: mergeReasonLabel(reason),
					href,
				}));
	const fallbackLink =
		kind === "merge_conflict" && href
			? [
					{
						label: i18n.t("changeRequests.links.conflicts"),
						href,
						title: i18n.t("changeRequests.links.openMergeConflicts"),
					},
				]
			: [];
	return fileLinks.length > 0 ? fileLinks : reasonLinks.length > 0 ? reasonLinks : fallbackLink;
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
	return reviewer.isBot
		? i18n.t("changeRequests.links.botReviewer", { reviewer: reviewer.reviewerId })
		: reviewer.reviewerId;
}

function reviewAttentionLink(
	pr: SessionPRSummary,
	reviewer: SessionPRSummary["review"]["unresolvedBy"][number],
): PRSummaryLink {
	const inlineURL = reviewer.links.find((link) => link.url)?.url;
	if (reviewer.reviewUrl) {
		return {
			label: reviewerLabel(reviewer),
			href: reviewer.reviewUrl,
			title: i18n.t("changeRequests.links.openRequestedChanges", { reviewer: reviewerDisplayName(reviewer) }),
		};
	}
	if (inlineURL) {
		return {
			label: reviewerLabel(reviewer),
			href: inlineURL,
			title:
				reviewer.count > 0
					? i18n.t("changeRequests.links.unresolvedComments", {
							count: reviewer.count,
							reviewer: reviewerDisplayName(reviewer),
						})
					: i18n.t("changeRequests.links.openReviewComments", { reviewer: reviewerDisplayName(reviewer) }),
		};
	}
	return {
		label: reviewerLabel(reviewer),
		href: prBrowserUrl(pr),
		title: i18n.t(
			pr.provider === "gitlab" ? "changeRequests.links.openGitlabFor" : "changeRequests.links.openGithubFor",
			{ reviewer: reviewerDisplayName(reviewer) },
		),
	};
}

function mergeReasonLabel(reason: string): string {
	switch (reason) {
		case "behind_base":
			return i18n.t("changeRequests.reasons.behindBase");
		case "ci_failing":
			return i18n.t("changeRequests.reasons.ciFailing");
		case "changes_requested":
			return i18n.t("changeRequests.reasons.changesRequested");
		case "review_required":
			return i18n.t("changeRequests.reasons.reviewRequired");
		case "blocked_by_provider":
			return i18n.t("changeRequests.reasons.providerBlocked");
		default:
			return reason;
	}
}

function overflowLabel(total: number, shown: number, noun: PRSummaryNoun): string | undefined {
	const extra = total - shown;
	if (extra <= 0) {
		return undefined;
	}
	return `+${countLabel(noun, extra)}`;
}

export function countLabel(noun: PRSummaryNoun, count: number): string {
	switch (noun) {
		case "check":
			return i18n.t("changeRequests.counts.check", { count });
		case "comment":
			return i18n.t("changeRequests.counts.comment", { count });
		case "file":
			return i18n.t("changeRequests.counts.file", { count });
		case "line":
			return i18n.t("changeRequests.counts.line", { count });
		case "reason":
			return i18n.t("changeRequests.counts.reason", { count });
		case "reviewer":
			return i18n.t("changeRequests.counts.reviewer", { count });
	}
}

function openChangeRequestTitle(pr: Pick<SessionPRSummary, "provider">): string {
	return i18n.t(pr.provider === "gitlab" ? "changeRequests.links.openGitlab" : "changeRequests.links.openGithub");
}
