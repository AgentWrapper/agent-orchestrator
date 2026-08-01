import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import {
	isPRMergeable,
	mergeDisabledReason,
	useMergePR,
	type MergePRInput,
} from "./pr-actions";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import {
	sessionScmSummaryQueryKey,
	type SessionPRSummary,
} from "../hooks/useSessionScmSummary";
import { apiClient } from "./api-client";

vi.mock("./api-client", () => ({
	apiClient: { POST: vi.fn() },
	apiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

const PR_URL = "https://github.com/acme/widgets/pull/42";

function ci(state: SessionPRSummary["ci"]["state"], checkCount = 0): SessionPRSummary["ci"] {
	return {
		state,
		checkCount,
		failingChecks: [],
	};
}

function review(
	decision: SessionPRSummary["review"]["decision"],
	hasUnresolvedHumanComments = false,
): SessionPRSummary["review"] {
	return {
		decision,
		hasUnresolvedHumanComments,
		unresolvedBy: [],
	};
}

function mergeability(
	state: SessionPRSummary["mergeability"]["state"],
): SessionPRSummary["mergeability"] {
	return {
		state,
		prUrl: PR_URL,
		reasons: [],
	};
}

function pr(overrides: Partial<SessionPRSummary> = {}): SessionPRSummary {
	return {
		number: 42,
		repo: "acme/widgets",
		url: PR_URL,
		state: "open",
		ci: ci("passing"),
		review: review("approved"),
		mergeability: mergeability("mergeable"),
		...overrides,
	} as SessionPRSummary;
}

describe("isPRMergeable", () => {
	it("is true for an open, passing, approved, mergeable PR", () => {
		expect(isPRMergeable(pr())).toBe(true);
	});

    it("is true when CI is unknown and no checks were ever observed", () => {
		expect(isPRMergeable(pr({ ci: ci("unknown", 0) }))).toBe(true);
	});

	it("is false when CI is unknown but checks exist and haven't resolved (incomplete/paginated rollup)", () => {
		expect(isPRMergeable(pr({ ci: ci("unknown", 3) }))).toBe(false);
	});

	it("is false when the PR is not open", () => {
		expect(isPRMergeable(pr({ state: "draft" }))).toBe(false);
		expect(isPRMergeable(pr({ state: "merged" }))).toBe(false);
		expect(isPRMergeable(pr({ state: "closed" }))).toBe(false);
	});

	it("is false when CI is failing or pending", () => {
		expect(isPRMergeable(pr({ ci: ci("failing") }))).toBe(false);
		expect(isPRMergeable(pr({ ci: ci("pending") }))).toBe(false);
	});

	it("is true when CI is unknown but everything else is ready (no-checks-configured case)", () => {
		expect(isPRMergeable(pr({ ci: ci("unknown") }))).toBe(true);
	});

	it("is false on changes requested or unresolved human comments", () => {
		expect(
			isPRMergeable(
				pr({
					review: review("changes_requested"),
				}),
			),
		).toBe(false);

		expect(
			isPRMergeable(
				pr({
					review: review("approved", true),
				}),
			),
		).toBe(false);
	});

	it("is false unless mergeability.state is exactly mergeable", () => {
		expect(isPRMergeable(pr({ mergeability: mergeability("conflicting") }))).toBe(false);
		expect(isPRMergeable(pr({ mergeability: mergeability("blocked") }))).toBe(false);
		expect(isPRMergeable(pr({ mergeability: mergeability("unstable") }))).toBe(false);
		expect(isPRMergeable(pr({ mergeability: mergeability("unknown") }))).toBe(false);
	});
});

describe("mergeDisabledReason", () => {
	it("explains draft vs other non-open states", () => {
		expect(mergeDisabledReason(pr({ state: "draft" }))).toBe(
			"Draft PRs can't be merged yet",
		);

		expect(mergeDisabledReason(pr({ state: "merged" }))).toBe(
			"PR is already merged",
		);
	});

	it("explains failing, pending, and unknown CI distinctly", () => {
		expect(mergeDisabledReason(pr({ ci: ci("failing") }))).toBe(
			"CI is failing",
		);

		expect(mergeDisabledReason(pr({ ci: ci("pending") }))).toBe(
			"CI checks are still running",
		);

		expect(mergeDisabledReason(pr({ ci: ci("unknown") }))).toBe(
			"No CI status reported for this PR yet",
		);
	});

	it("explains unresolved review feedback", () => {
		expect(
			mergeDisabledReason(
				pr({
					review: review("changes_requested"),
				}),
			),
		).toBe("Has unresolved review feedback");
	});

    it("explains failing, pending, and unknown CI distinctly", () => {
		expect(mergeDisabledReason(pr({ ci: ci("failing") }))).toBe("CI is failing");
		expect(mergeDisabledReason(pr({ ci: ci("pending") }))).toBe("CI checks are still running");
		expect(mergeDisabledReason(pr({ ci: ci("unknown", 0) }))).toBe(
			"No CI status reported for this PR yet",
		);
		expect(mergeDisabledReason(pr({ ci: ci("unknown", 4) }))).toBe(
			"CI checks haven't finished reporting for this PR",
		);
	});

	it("explains each non-mergeable mergeability state", () => {
		expect(
			mergeDisabledReason(
				pr({
					mergeability: mergeability("conflicting"),
				}),
			),
		).toBe("Has merge conflicts with the base branch");

		expect(
			mergeDisabledReason(
				pr({
					mergeability: mergeability("blocked"),
				}),
			),
		).toBe("Blocked by required checks or reviews");

		expect(
			mergeDisabledReason(
				pr({
					mergeability: mergeability("unstable"),
				}),
			),
		).toBe("Checks are unstable — not safe to merge yet");

		expect(
			mergeDisabledReason(
				pr({
					mergeability: mergeability("unknown"),
				}),
			),
		).toBe("Mergeability not yet determined");
	});
});

describe("useMergePR", () => {
	beforeEach(() => {
		vi.mocked(apiClient.POST).mockReset();
	});

	function wrapper(queryClient: QueryClient) {
		return ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client: queryClient }, children);
	}

	it("POSTs to the merge endpoint with the PR number and repo", async () => {
		vi.mocked(apiClient.POST).mockResolvedValue({
			error: undefined,
			response: { status: 200 },
		} as any);

		const queryClient = new QueryClient();

		const { result } = renderHook(() => useMergePR(), {
			wrapper: wrapper(queryClient),
		});

		const input: MergePRInput = {
			pr: pr(),
			sessionId: "sess-1",
		};

		result.current.mutate(input);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/prs/{id}/merge", {
			params: {
				path: { id: "42" },
				query: { repo: "acme/widgets" },
			},
		});
	});

	it("invalidates the workspace and session PR summary caches on success", async () => {
		vi.mocked(apiClient.POST).mockResolvedValue({
			error: undefined,
			response: { status: 200 },
		} as any);

		const queryClient = new QueryClient();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(() => useMergePR(), {
			wrapper: wrapper(queryClient),
		});

		result.current.mutate({
			pr: pr(),
			sessionId: "sess-1",
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: workspaceQueryKey,
		});

		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: sessionScmSummaryQueryKey("sess-1"),
		});
	});

	it("surfaces an error message on failure so the UI can show 'Retry merge'", async () => {
		vi.mocked(apiClient.POST).mockResolvedValue({
			error: {
				message: "not mergeable",
			},
			response: {
				status: 405,
			},
		} as any);

		const queryClient = new QueryClient();

		const { result } = renderHook(() => useMergePR(), {
			wrapper: wrapper(queryClient),
		});

		result.current.mutate({
			pr: pr(),
			sessionId: "sess-1",
		});

		await waitFor(() => expect(result.current.isError).toBe(true));

		expect(result.current.error).toBeInstanceOf(Error);
	});
});