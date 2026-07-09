export const FINAL_REVIEW_CONTEXT = "final-review";
export const CLEAN_VERDICT = "clean";
export const PARKED_VERDICT = "parked";

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const REVIEWER_FAMILY_RE = /^[A-Za-z0-9_.-]{1,48}$/;
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function assertFullSHA(sha) {
	if (!FULL_SHA_RE.test(String(sha ?? ""))) {
		throw new Error("final-review status requires a full 40-character head SHA");
	}
	return String(sha).toLowerCase();
}

export function normalizeVerdict(verdict) {
	if (verdict === CLEAN_VERDICT || verdict === PARKED_VERDICT) return verdict;
	throw new Error("final-review verdict must be clean or parked");
}

export function normalizeReviewerFamily(reviewerFamily) {
	const value = String(reviewerFamily ?? "").trim();
	if (!REVIEWER_FAMILY_RE.test(value)) {
		throw new Error("reviewer family must be 1-48 chars of letters, numbers, dot, underscore, or dash");
	}
	return value;
}

export function normalizeRepoSlug(repo) {
	const value = String(repo ?? "").trim();
	if (!REPO_SLUG_RE.test(value)) {
		throw new Error("repo must be in owner/name form");
	}
	return value;
}

export function buildStatusDescription({ sha, verdict, reviewerFamily }) {
	const normalizedSHA = assertFullSHA(sha);
	const normalizedVerdict = normalizeVerdict(verdict);
	const normalizedReviewer = normalizeReviewerFamily(reviewerFamily);
	const description = `verdict=${normalizedVerdict} reviewer_family=${normalizedReviewer} head=${normalizedSHA}`;
	if (description.length > 140) {
		throw new Error("final-review status description exceeds GitHub's 140-character limit");
	}
	return description;
}

export function buildStatusPayload({ sha, verdict, reviewerFamily, targetUrl = "" }) {
	const normalizedVerdict = normalizeVerdict(verdict);
	const payload = {
		context: FINAL_REVIEW_CONTEXT,
		description: buildStatusDescription({ sha, verdict: normalizedVerdict, reviewerFamily }),
		state: normalizedVerdict === CLEAN_VERDICT ? "success" : "failure",
	};
	const trimmedTargetUrl = String(targetUrl ?? "").trim();
	if (trimmedTargetUrl) payload.target_url = trimmedTargetUrl;
	return payload;
}

export function parseStatusDescription(description) {
	const raw = String(description ?? "").trim();
	if (!raw) return {};

	const values = {};
	for (const token of raw.split(/\s+/)) {
		const idx = token.indexOf("=");
		if (idx <= 0) continue;
		values[token.slice(0, idx)] = token.slice(idx + 1);
	}

	const verdict = values.verdict;
	if (verdict !== CLEAN_VERDICT && verdict !== PARKED_VERDICT) return {};

	const parsed = { verdict };
	if (FULL_SHA_RE.test(values.head ?? "")) parsed.head = values.head.toLowerCase();
	if (REVIEWER_FAMILY_RE.test(values.reviewer_family ?? "")) {
		parsed.reviewerFamily = values.reviewer_family;
	}
	return parsed;
}

function statusTimestamp(status) {
	const value = Date.parse(status?.updated_at ?? status?.created_at ?? "");
	return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function latestFinalReviewStatus(statuses) {
	return (Array.isArray(statuses) ? statuses : [])
		.filter((status) => status?.context === FINAL_REVIEW_CONTEXT)
		.reduce((latest, status) => {
			if (!latest) return status;
			const candidateTime = statusTimestamp(status);
			const latestTime = statusTimestamp(latest);
			if (candidateTime > latestTime) return status;
			if (candidateTime === latestTime && latest.state === "success" && status.state !== "success") return status;
			return latest;
		}, null);
}

export function evaluateFinalReviewStatuses(statuses, expectedHead) {
	const normalizedHead = assertFullSHA(expectedHead);
	const latest = latestFinalReviewStatus(statuses);

	if (!latest) {
		return { ok: false, reason: "missing-final-review-status", head: normalizedHead };
	}

	const parsed = parseStatusDescription(latest.description);
	if (!parsed.verdict) {
		return {
			ok: false,
			reason: "invalid-final-review-status",
			head: normalizedHead,
			state: latest.state ?? "",
		};
	}

	if (parsed.head !== normalizedHead) {
		return {
			ok: false,
			reason: "stale-head",
			verdict: parsed.verdict,
			reviewerFamily: parsed.reviewerFamily ?? "",
			head: parsed.head ?? "",
			expectedHead: normalizedHead,
			state: latest.state ?? "",
		};
	}

	if (!parsed.reviewerFamily) {
		return {
			ok: false,
			reason: "missing-reviewer-family",
			verdict: parsed.verdict,
			head: normalizedHead,
			state: latest.state ?? "",
		};
	}

	if (latest.state !== "success" || parsed.verdict !== CLEAN_VERDICT) {
		return {
			ok: false,
			reason: "unclean-final-review",
			verdict: parsed.verdict,
			reviewerFamily: parsed.reviewerFamily,
			head: normalizedHead,
			state: latest.state ?? "",
		};
	}

	return {
		ok: true,
		reason: CLEAN_VERDICT,
		verdict: parsed.verdict,
		reviewerFamily: parsed.reviewerFamily,
		head: normalizedHead,
		state: latest.state,
	};
}
