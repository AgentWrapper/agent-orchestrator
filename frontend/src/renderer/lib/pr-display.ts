import type { SessionPRSummary } from "../hooks/useSessionScmSummary";
import { sortedPRs, type PRState, type PullRequestFacts, type WorkspaceSession } from "../types/workspace";
import { t, type MessageKey } from "../i18n";
import { activeLocale } from "../stores/locale-store";

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
	const locale = activeLocale();
	return [
		{
			key: "ci",
			label: t(locale, "pr.section.ci"),
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
			label: t(locale, "pr.section.merge"),
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
			label: t(locale, "pr.section.review"),
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
		return pr.ci.failingChecks.length === 0 ? t(activeLocale(), "pr.ci.noFailingLink") : undefined;
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
	const locale = activeLocale();
	if (pr.state === "merged" || pr.state === "closed") {
		return undefined;
	}
	if (pr.state === "draft") {
		return t(locale, "pr.review.draftNotReady");
	}
	if (pr.review.decision === "changes_requested" || pr.review.hasUnresolvedHumanComments) {
		return reviewLinks(pr).length === 0 ? t(locale, "pr.review.changesActive") : undefined;
	}
	if (pr.review.decision === "review_required") {
		return t(locale, "pr.review.requiredNotSubmitted");
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
		const locale = activeLocale();
		links.push({
			label: t(locale, "pr.short"),
			href: prBrowserUrl(pr),
			title: t(locale, "pr.review.openPR"),
		});
	}
	return links;
}

function mergeSummary(pr: SessionPRSummary): string | undefined {
	const locale = activeLocale();
	if (pr.state === "merged" || pr.state === "closed") {
		return formatDiffSummary(pr);
	}
	if (pr.mergeability.state === "conflicting") {
		return mergeLinks(pr).length === 0 ? t(locale, "pr.merge.conflictsWithBase") : undefined;
	}
	if (pr.mergeability.state === "blocked" || pr.mergeability.state === "unstable") {
		return mergeLinks(pr).length === 0 ? t(locale, "pr.merge.providerBlocked") : undefined;
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
	const locale = activeLocale();
	switch (state) {
		case "passing":
			return t(locale, "pr.ci.passing");
		case "failing":
			return t(locale, "pr.ci.failing");
		case "pending":
			return t(locale, "pr.ci.pending");
		case "unknown":
			return t(locale, "pr.ci.checking");
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
	const locale = activeLocale();
	switch (decision) {
		case "approved":
			return t(locale, "pr.review.approved");
		case "changes_requested":
			return t(locale, "pr.review.changesRequested");
		case "review_required":
			return t(locale, "pr.review.pending");
		case "none":
			return t(locale, "pr.review.none");
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
	const locale = activeLocale();
	switch (state) {
		case "mergeable":
			return t(locale, "pr.merge.mergeable");
		case "conflicting":
			return t(locale, "pr.merge.conflict");
		case "blocked":
			return t(locale, "pr.merge.blocked");
		case "unstable":
			return t(locale, "pr.merge.unstable");
		case "unknown":
			return t(locale, "pr.merge.checking");
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

function mergeAttentionLinks(pr: SessionPRSummary, kind: "merge_conflict" | "merge_blocked"): PRSummaryLink[] {
	const locale = activeLocale();
	const href =
		kind === "merge_conflict" ? mergeConflictUrl(pr) : pr.mergeability.prUrl || pr.htmlUrl || pr.url || undefined;
	const openConflicts = t(locale, "pr.merge.openConflicts");
	const fileLinks = (pr.mergeability.conflictFiles ?? []).slice(0, 3).map((file) => ({
		label: file.path,
		href: file.url || href,
		title: kind === "merge_conflict" ? openConflicts : undefined,
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
			? [{ label: t(locale, "pr.merge.conflicts"), href, title: openConflicts }]
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
	if (!reviewer.isBot) return reviewer.reviewerId;
	return t(activeLocale(), "pr.botSuffix", { name: reviewer.reviewerId });
}

function reviewAttentionLink(
	pr: SessionPRSummary,
	reviewer: SessionPRSummary["review"]["unresolvedBy"][number],
): PRSummaryLink {
	const locale = activeLocale();
	const name = reviewerDisplayName(reviewer);
	const inlineURL = reviewer.links.find((link) => link.url)?.url;
	if (reviewer.reviewUrl) {
		return {
			label: reviewerLabel(reviewer),
			href: reviewer.reviewUrl,
			title: t(locale, "pr.openReviewFrom", { name }),
		};
	}
	if (inlineURL) {
		return {
			label: reviewerLabel(reviewer),
			href: inlineURL,
			title:
				reviewer.count > 0
					? t(locale, "pr.unresolvedComments", {
							count: reviewer.count,
							noun: pluralize("comment", reviewer.count),
							name,
						})
					: t(locale, "pr.openCommentsFrom", { name }),
		};
	}
	return {
		label: reviewerLabel(reviewer),
		href: prBrowserUrl(pr),
		title: t(locale, "pr.openPRFor", { name }),
	};
}

function mergeReasonLabel(reason: string): string {
	const locale = activeLocale();
	switch (reason) {
		case "behind_base":
			return t(locale, "pr.reason.behindBase");
		case "ci_failing":
			return t(locale, "pr.reason.ciFailing");
		case "changes_requested":
			return t(locale, "pr.reason.changesRequested");
		case "review_required":
			return t(locale, "pr.reason.reviewRequired");
		case "blocked_by_provider":
			return t(locale, "pr.reason.providerBlocked");
		default:
			return reason.replaceAll("_", " ");
	}
}

function overflowLabel(total: number, shown: number, noun: string): string | undefined {
	const extra = total - shown;
	if (extra <= 0) {
		return undefined;
	}
	return t(activeLocale(), "pr.overflow", { n: extra, noun: pluralize(noun, extra) });
}

function pluralize(noun: string, count: number): string {
	const locale = activeLocale();
	const key = (count === 1 ? `pr.noun.${noun}` : `pr.noun.${noun}s`) as MessageKey;
	return t(locale, key);
}
