export const FINAL_REVIEW_CONTEXT = "final-review";
export const REVIEW_PASSED_CONTEXT = "review-passed";
export const MERGE_PARK_CONTEXT = "merge-park";
export const CLEAN_VERDICT = "clean";
export const PARKED_VERDICT = "parked";
export const HUMAN_MERGE_REQUIRED_REASON = "human-required";

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

export function buildStatusPayload(options) {
	if (Object.hasOwn(options ?? {}, "humanMergeRequired")) {
		throw new Error("human merge park status must be built separately with buildHumanMergeRequiredStatusPayload");
	}
	const { sha, verdict, reviewerFamily, targetUrl = "" } = options ?? {};
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

export function buildReviewPassedStatusPayload(options) {
	const payload = buildStatusPayload(options);
	return {
		...payload,
		context: REVIEW_PASSED_CONTEXT,
	};
}

export function buildHumanMergeRequiredStatusPayload({ sha, reviewerFamily, targetUrl = "" }) {
	const normalizedSHA = assertFullSHA(sha);
	const normalizedReviewer = normalizeReviewerFamily(reviewerFamily);
	const description = `reason=${HUMAN_MERGE_REQUIRED_REASON} reviewer_family=${normalizedReviewer} head=${normalizedSHA}`;
	if (description.length > 140) {
		throw new Error("merge park status description exceeds GitHub's 140-character limit");
	}
	const payload = {
		context: MERGE_PARK_CONTEXT,
		description,
		state: "success",
	};
	const trimmedTargetUrl = String(targetUrl ?? "").trim();
	if (trimmedTargetUrl) payload.target_url = trimmedTargetUrl;
	return payload;
}

export function parseStatusDescription(description) {
	const raw = String(description ?? "").trim();
	if (!raw) return {};

	const values = parseKeyValueTokens(raw);

	const verdict = values.verdict;
	if (verdict !== CLEAN_VERDICT && verdict !== PARKED_VERDICT) return {};

	const parsed = { verdict };
	if (FULL_SHA_RE.test(values.head ?? "")) parsed.head = values.head.toLowerCase();
	if (REVIEWER_FAMILY_RE.test(values.reviewer_family ?? "")) {
		parsed.reviewerFamily = values.reviewer_family;
	}
	return parsed;
}

export function parseHumanMergeRequiredDescription(description) {
	const raw = String(description ?? "").trim();
	if (!raw) return {};

	const values = parseKeyValueTokens(raw);

	const parsed = {};
	if (FULL_SHA_RE.test(values.head ?? "")) parsed.head = values.head.toLowerCase();
	if (REVIEWER_FAMILY_RE.test(values.reviewer_family ?? "")) {
		parsed.reviewerFamily = values.reviewer_family;
	}
	if (values.reason !== HUMAN_MERGE_REQUIRED_REASON) return parsed;

	parsed.reason = values.reason;
	return parsed;
}

function parseKeyValueTokens(raw) {
	const values = {};
	for (const token of raw.split(/\s+/)) {
		const idx = token.indexOf("=");
		if (idx <= 0) continue;
		values[token.slice(0, idx)] = token.slice(idx + 1);
	}
	return values;
}

function statusTimestamp(status) {
	const value = Date.parse(status?.updated_at ?? status?.created_at ?? "");
	return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function latestContextStatus(statuses, context) {
	return (Array.isArray(statuses) ? statuses : [])
		.filter((status) => status?.context === context)
		.reduce((latest, status) => {
			if (!latest) return status;
			const candidateTime = statusTimestamp(status);
			const latestTime = statusTimestamp(latest);
			if (candidateTime > latestTime) return status;
			if (candidateTime === latestTime && latest.state === "success" && status.state !== "success") return status;
			return latest;
		}, null);
}

function latestFinalReviewStatus(statuses) {
	return latestContextStatus(statuses, FINAL_REVIEW_CONTEXT);
}

function latestMergeParkStatus(statuses) {
	return latestContextStatus(statuses, MERGE_PARK_CONTEXT);
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

export function evaluateAutonomousMergeStatuses(statuses, expectedHead) {
	const review = evaluateFinalReviewStatuses(statuses, expectedHead);
	if (!review.ok) return review;

	const park = latestMergeParkStatus(statuses);
	if (!park) return review;

	const parsed = parseHumanMergeRequiredDescription(park.description);
	if (parsed.head && parsed.head !== review.head) {
		return {
			ok: false,
			reason: "invalid-merge-park-status",
			head: review.head,
			state: park.state ?? "",
		};
	}

	if (!parsed.reason) {
		return {
			ok: false,
			reason: "invalid-merge-park-status",
			head: review.head,
			state: park.state ?? "",
		};
	}

	if (!parsed.reviewerFamily) {
		return {
			ok: false,
			reason: "missing-merge-park-reviewer-family",
			head: review.head,
			state: park.state ?? "",
		};
	}

	return {
		ok: false,
		reason: "human-merge-required",
		reviewerFamily: parsed.reviewerFamily,
		head: review.head,
		state: park.state ?? "",
	};
}

// Reviews whose state changes a PR's mergeability. COMMENTED and PENDING carry no
// verdict, so they neither block nor clear; DISMISSED is an explicitly withdrawn
// verdict and does the same.
const VERDICT_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED"]);

// Does any independent reviewer have an outstanding CHANGES_REQUESTED on THIS head?
//
// Why this lives here (GH #304): GitHub only enforces CHANGES_REQUESTED as a merge
// blocker when a branch-protection `pull_request` rule exists, and `mainprotect`
// has none — so a requested change is visible and the merge queue merges straight
// over it. Our PRs land through this autonomous gate rather than the GitHub UI, so
// this is the seam where a blocking review can actually block, without touching a
// GitHub-side ruleset that also governs every human merge.
//
// Two rules make the gate CLEARABLE, which matters as much as making it strict:
//
//   1. SHA-pinned. A CHANGES_REQUESTED against an older commit says nothing about
//      the current one. Counting it would leave a PR permanently blocked after it
//      was fixed and re-reviewed — and an unclearable gate is one workers learn to
//      route around, which is precisely the failure #304 exists to end.
//   2. Latest verdict per reviewer wins. A reviewer who requests changes and then
//      approves the same head has cleared it.
//
// The PR author's own reviews never count: a self-review is not independence, and
// author == reviewer is the collapse this whole change exists to prevent. If the
// author cannot be identified we cannot tell the two apart, so we fail CLOSED.
// Every ambiguity here fails CLOSED. This gate's only job is to refuse a merge it
// cannot positively certify, and every "unknown" it waves through is a bypass —
// the same shape as the bug it exists to fix.
export function evaluateBlockingReviews(reviews, { head, prAuthor } = {}) {
	const expectedHead = assertFullSHA(String(head ?? ""));
	const author = String(prAuthor ?? "")
		.trim()
		.toLowerCase();

	// A non-array response (null, an error object, a truncated body) is not "no
	// reviews" — it is "we do not know". Only a real empty array means no reviews.
	if (!Array.isArray(reviews)) {
		return { ok: false, reason: "invalid-reviews-response", head: expectedHead, reviewers: [] };
	}
	// Without the author we cannot distinguish a self-review from an independent
	// one, and author == reviewer is the exact collapse this exists to prevent. That
	// is true even with zero reviews: we still cannot establish independence.
	if (!author) {
		return { ok: false, reason: "unknown-pr-author", head: expectedHead, reviewers: [] };
	}

	// Latest verdict per reviewer, among reviews pinned to THIS head.
	//
	// Ordering uses the API's documented chronological response order, with the
	// review id as a deterministic tie-breaker, rather than submitted_at: a missing
	// or malformed timestamp parsed to 0 would let a LATER requested change lose to
	// an EARLIER approval and silently unblock the merge.
	const latest = new Map();
	for (const [index, review] of reviews.entries()) {
		const state = String(review?.state ?? "")
			.trim()
			.toUpperCase();
		const commit = String(review?.commit_id ?? "")
			.trim()
			.toLowerCase();

		if (commit !== expectedHead) continue; // stale: says nothing about this head
		if (!VERDICT_REVIEW_STATES.has(state)) continue; // no verdict carried

		// A current-head VERDICT whose author we cannot read must not vanish.
		const login = String(review?.user?.login ?? "").trim();
		if (!login) {
			return { ok: false, reason: "unknown-review-author", head: expectedHead, reviewers: [] };
		}
		if (login.toLowerCase() === author) continue; // never self-review

		const order = Number.isFinite(review?.id) ? review.id : index;
		const prev = latest.get(login);
		if (!prev || order >= prev.order) latest.set(login, { state, order });
	}

	const reviewers = [...latest.entries()]
		.filter(([, v]) => v.state === "CHANGES_REQUESTED")
		.map(([login]) => login)
		.sort();

	if (reviewers.length > 0) {
		return { ok: false, reason: "changes-requested", head: expectedHead, reviewers };
	}
	return { ok: true, head: expectedHead, reviewers: [] };
}

// Pick the pull request a head SHA belongs to, for the autonomous merge gate.
//
// Pure because the bug this guards against hid in the untested CLI caller while
// the evaluator's own tests were green: `commits/{sha}/pulls` returns EVERY pull
// associated with a commit — merged and closed ones included — so taking the first
// exact-head match could select a stale PR and miss a CHANGES_REQUESTED on the one
// actually entering the merge queue. A direct bypass.
//
// Only OPEN pulls whose head is exactly this SHA count, and exactly one must
// remain: genuine ambiguity fails closed rather than guessing which PR is real.
export function selectHeadPullRequest(pulls, head) {
	const sha = assertFullSHA(String(head ?? ""));
	const candidates = (Array.isArray(pulls) ? pulls : []).filter(
		(p) => String(p?.head?.sha ?? "").toLowerCase() === sha && String(p?.state ?? "") === "open" && p?.number,
	);
	if (candidates.length === 1) {
		return { pr: candidates[0].number, ambiguous: false, author: String(candidates[0]?.user?.login ?? "") };
	}
	return { pr: null, ambiguous: candidates.length > 1, author: "" };
}

// Flatten `gh api --paginate --slurp` output (an array of per-page arrays).
//
// A non-array response means "we could not read the reviews", NOT "there are
// none" — it is passed through unchanged so evaluateBlockingReviews fails closed
// on it rather than certifying a merge against an unread response.
export function flattenReviewPages(pages) {
	return Array.isArray(pages) ? pages.flat() : pages;
}
