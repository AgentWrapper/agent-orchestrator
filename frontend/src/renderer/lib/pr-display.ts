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

/**
 * Tones map onto the PR card palette (see `--color-text-pr-*` in tokens.css):
 *   value   → the neutral value tier, for any state the provider has reported
 *   muted   → the label/empty tier, for "nothing here yet" and unknown states
 *   blocked → the single blocker hue, for a negative verdict that stops the merge
 * There is deliberately no success or warning tone: green and amber are retired
 * in this card, and hue is reserved for links and blockers only.
 */
export type PRDisplayTone = "value" | "muted" | "blocked";

export type PRStatusRow = {
	key: PRSummaryPartKey;
	label: string;
	value: string;
	detail?: string;
	tone: PRDisplayTone;
};

export type PRSummaryPartKey = "status" | "ci" | "review" | "merge";

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
	overflowNoun?: string;
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
	const dedupedSummaries = deduplicateSummaries(summaries);
	const summariesByIdentity = new Map<string, SessionPRSummary>();
	const summaryNumberCounts = countPRNumbers(dedupedSummaries);
	const summariesByUniqueNumber = new Map<number, SessionPRSummary>();
	for (const summary of dedupedSummaries) {
		for (const key of prDisplayIdentities(summary)) {
			if (!summariesByIdentity.has(key)) {
				summariesByIdentity.set(key, summary);
			}
		}
		if (summaryNumberCounts.get(summary.number) === 1) {
			summariesByUniqueNumber.set(summary.number, summary);
		}
	}
	const facts = sortedPRs(session);
	const factNumberCounts = countPRNumbers(facts);
	const seen = new Set<string>();
	const consumedSummaries = new Set<SessionPRSummary>();
	const fromFacts: SessionPRSummary[] = [];
	for (const pr of facts) {
		const key = prDisplayIdentity(pr);
		if (seen.has(key)) continue;
		seen.add(key);
		const summary = summariesByIdentity.get(key) ?? uniqueNumberSummary(pr, factNumberCounts, summariesByUniqueNumber);
		if (summary) {
			for (const summaryKey of prDisplayIdentities(summary)) {
				seen.add(summaryKey);
			}
			consumedSummaries.add(summary);
		}
		fromFacts.push(summary ?? sessionPRFactToSummary(session, pr));
	}
	const summaryOnly: SessionPRSummary[] = [];
	for (const summary of dedupedSummaries) {
		const keys = prDisplayIdentities(summary);
		if (keys.some((key) => seen.has(key))) continue;
		if (consumedSummaries.has(summary)) continue;
		for (const key of keys) {
			seen.add(key);
		}
		summaryOnly.push(summary);
	}
	return [...fromFacts, ...summaryOnly].sort(comparePRDisplaySummaries);
}

function deduplicateSummaries(summaries: SessionPRSummary[]): SessionPRSummary[] {
	const seen = new Set<string>();
	const out: SessionPRSummary[] = [];
	for (const summary of summaries) {
		const keys = prDisplayIdentities(summary);
		if (keys.some((key) => seen.has(key))) continue;
		for (const key of keys) {
			seen.add(key);
		}
		out.push(summary);
	}
	return out;
}

function countPRNumbers(prs: Array<Pick<SessionPRSummary, "number"> | PullRequestFacts>): Map<number, number> {
	const counts = new Map<number, number>();
	for (const pr of prs) {
		counts.set(pr.number, (counts.get(pr.number) ?? 0) + 1);
	}
	return counts;
}

function uniqueNumberSummary(
	pr: PullRequestFacts,
	factNumberCounts: Map<number, number>,
	summariesByUniqueNumber: Map<number, SessionPRSummary>,
): SessionPRSummary | undefined {
	if (factNumberCounts.get(pr.number) !== 1) return undefined;
	return summariesByUniqueNumber.get(pr.number);
}

function prDisplayIdentity(pr: Pick<SessionPRSummary, "number" | "url" | "htmlUrl" | "repo"> | PullRequestFacts): string {
	const url = "htmlUrl" in pr ? pr.htmlUrl || pr.url : pr.url;
	const github = githubPRIdentity(url, pr.number);
	if (github) return github;
	const repo = "repo" in pr ? pr.repo.trim().toLowerCase() : "";
	if (repo) return `repo:${repo}#${pr.number}`;
	return `number:${pr.number}`;
}

function prDisplayIdentities(pr: SessionPRSummary): string[] {
	const keys = [prDisplayIdentity(pr)];
	const alias = prTransferAliasIdentity(pr);
	if (alias) keys.push(alias);
	return keys;
}

function githubPRIdentity(rawURL: string, expectedNumber: number): string | undefined {
	try {
		const url = new URL(rawURL);
		const host = url.hostname.toLowerCase();
		if (host !== "github.com" && !host.endsWith(".github.com")) return undefined;
		const [, owner, repoName, kind, number] = url.pathname.split("/");
		if ((kind !== "pull" && kind !== "issues") || !owner || !repoName || !number) return undefined;
		if (Number(number) !== expectedNumber) return undefined;
		return `github:${host}/${owner.toLowerCase()}/${repoName.toLowerCase()}#${number}`;
	} catch {
		return undefined;
	}
}

function prTransferAliasIdentity(pr: SessionPRSummary): string | undefined {
	const github = githubPRAliasParts(pr.htmlUrl || pr.url, pr.number);
	if (!github) return undefined;
	const sourceBranch = normalizedAliasPart(pr.sourceBranch);
	const headSha = normalizedAliasPart(pr.headSha);
	if (!sourceBranch || !headSha) return undefined;
	return [
		"github-transfer",
		github.host,
		github.repoName,
		String(pr.number),
		sourceBranch,
		normalizedAliasPart(pr.targetBranch),
		headSha,
	].join("|");
}

function githubPRAliasParts(rawURL: string, expectedNumber: number): { host: string; repoName: string } | undefined {
	try {
		const url = new URL(rawURL);
		const host = url.hostname.toLowerCase();
		if (host !== "github.com" && !host.endsWith(".github.com")) return undefined;
		const [, owner, repoName, kind, number] = url.pathname.split("/");
		if ((kind !== "pull" && kind !== "issues") || !owner || !repoName || !number) return undefined;
		if (Number(number) !== expectedNumber) return undefined;
		return { host, repoName: repoName.toLowerCase() };
	} catch {
		return undefined;
	}
}

function normalizedAliasPart(value: string): string {
	return value.trim().toLowerCase();
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
		sourceBranch: session.branch ?? "",
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
			key: "status",
			label: "Status",
			status: prStateLabel(pr.state),
			links: [],
			tone: "value",
		},
		{
			key: "ci",
			label: "CI",
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
			label: "Merge",
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
			label: "Review",
			status: reviewLabel(pr.review.decision),
			summary: reviewSummary(pr),
			links: reviewLinks(pr),
			linkTotal: reviewLinkTotal(pr),
			overflowLabel:
				pr.state === "draft" || pr.review.decision === "review_required"
					? undefined
					: overflowLabel(pr.review.unresolvedBy.length, 3, "reviewer"),
			overflowNoun: "reviewer",
			tone: reviewTone(pr.review.decision),
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

function ciSummary(pr: SessionPRSummary): string | undefined {
	if (pr.ci.state === "failing") {
		return pr.ci.failingChecks.length === 0 ? "No failing check link observed" : undefined;
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
		return "Draft PR · Not ready for review";
	}
	if (pr.review.decision === "changes_requested" || pr.review.hasUnresolvedHumanComments) {
		return reviewLinks(pr).length === 0 ? "Requested changes still active" : undefined;
	}
	if (pr.review.decision === "review_required") {
		return "Required review not submitted";
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
		links.push({ label: "PR", href: prBrowserUrl(pr), title: "Open pull request" });
	}
	return links;
}

function mergeSummary(pr: SessionPRSummary): string | undefined {
	if (pr.state === "merged" || pr.state === "closed") {
		return formatDiffSummary(pr);
	}
	if (pr.mergeability.state === "conflicting") {
		return mergeLinks(pr).length === 0 ? "Conflicts with the base branch" : undefined;
	}
	if (pr.mergeability.state === "blocked" || pr.mergeability.state === "unstable") {
		return mergeLinks(pr).length === 0 ? "Provider reports merge is blocked" : undefined;
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

function mergeOverflowNoun(pr: SessionPRSummary): string {
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
		// Failing CI is one of the provider's own merge-blocking reasons, so it
		// earns the blocker hue. Passing and pending are just reported values.
		case "failing":
			return "blocked";
		case "passing":
		case "pending":
			return "value";
		case "unknown":
			return "muted";
	}
}

function prStateLabel(state: SessionPRSummary["state"]): string {
	switch (state) {
		case "open":
			return "Open";
		case "draft":
			return "Draft";
		case "merged":
			return "Merged";
		case "closed":
			return "Closed";
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

function reviewTone(decision: SessionPRSummary["review"]["decision"]): PRDisplayTone {
	switch (decision) {
		// Requested changes is a merge-blocking reason; approved and pending are
		// values. "None" is the empty state, and unresolved comments surface as
		// links rather than by tinting the value.
		case "changes_requested":
			return "blocked";
		case "approved":
		case "review_required":
			return "value";
		case "none":
			return "muted";
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
		case "conflicting":
		case "blocked":
		case "unstable":
			return "blocked";
		case "mergeable":
			return "value";
		case "unknown":
			return "muted";
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

function mergeAttentionLinks(pr: SessionPRSummary, kind: "merge_conflict" | "merge_blocked"): PRSummaryLink[] {
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
	return reviewer.isBot ? `${reviewer.reviewerId} bot` : reviewer.reviewerId;
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
