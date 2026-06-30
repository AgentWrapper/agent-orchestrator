import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionInspector } from "./SessionInspector";
import type { PRState, PullRequestFacts, WorkspaceSession } from "../types/workspace";

const { getMock, postMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: getMock,
		POST: postMock,
	},
	apiErrorMessage: (error: unknown, fallback = "Request failed") => {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error) {
			return String((error as { message: unknown }).message);
		}
		return fallback;
	},
}));

const pr = (n: number, state: PRState): PullRequestFacts => ({
	url: `https://example.com/pr/${n}`,
	number: n,
	state,
	ci: "passing",
	review: "approved",
	mergeability: "mergeable",
	reviewComments: false,
	updatedAt: "2026-06-15T00:00:00Z",
});

const session = (prs: PullRequestFacts[]): WorkspaceSession => ({
	id: "sess-1",
	workspaceId: "ws-1",
	workspaceName: "my-app",
	title: "do the thing",
	provider: "claude-code",
	kind: "worker",
	branch: "feat/ns",
	status: "review_pending",
	updatedAt: "2026-06-15T00:00:00Z",
	prs,
});

function renderWithQuery(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

function mockCommonGets(_unusedRuns: unknown[] = [], reviewerHandleId = "", reviews: unknown[] = []) {
	getMock.mockImplementation(async (path: string) => {
		if (path === "/api/v1/sessions/{sessionId}/reviews") {
			return { data: { reviewerHandleId, reviews } };
		}
		if (path === "/api/v1/projects/{id}") {
			return {
				data: {
					status: "ok",
					project: {
						id: "ws-1",
						kind: "git",
						name: "my-app",
						path: "/repo",
						repo: "my-app",
						defaultBranch: "main",
						config: { reviewers: [{ harness: "codex" }] },
					},
				},
			};
		}
		return { data: undefined };
	});
}

const approvedReview = {
	id: "run-1",
	reviewId: "review-1",
	sessionId: "sess-1",
	harness: "codex",
	status: "complete",
	verdict: "approved",
	body: "Looks good.",
	prUrl: "https://example.com/pr/3",
	targetSha: "abc123",
	createdAt: "2026-06-16T10:06:00Z",
};

const failedReview = {
	...approvedReview,
	id: "run-failed",
	status: "failed",
	verdict: "",
	body: "reviewer crashed",
};

const reviewState = (n: number, status: string, targetSha = `sha-${n}`) => ({
	prUrl: `https://example.com/pr/${n}`,
	prNumber: n,
	title: `Reviewable change ${n}`,
	targetSha,
	status,
	latestRun:
		status === "up_to_date" ? { ...approvedReview, prUrl: `https://example.com/pr/${n}`, targetSha } : undefined,
});

beforeEach(() => {
	getMock.mockReset();
	postMock.mockReset();
	getMock.mockResolvedValue({ data: { reviewerHandleId: "", reviews: [] }, error: undefined });
	postMock.mockResolvedValue({ data: { ok: true, sessionId: "sess-1" }, error: undefined });
});

describe("SessionInspector PR section", () => {
	// Scope assertions to the PR section: the activity timeline also renders
	// "Opened PR #n", so an unscoped query matches both the card and the event.
	const prSection = (title: string) =>
		within(screen.getByText(title).closest("section.inspector-section") as HTMLElement);

	it("renders one card per PR, ordered actionable-first, when a session owns a stack", () => {
		renderWithQuery(<SessionInspector session={session([pr(40, "merged"), pr(41, "open"), pr(42, "draft")])} />);

		expect(screen.getByText("Pull requests (3)")).toBeInTheDocument();
		const cards = prSection("Pull requests (3)")
			.getAllByText(/^PR #\d+$/)
			.map((el) => el.textContent);
		// open (41), draft (42), merged (40)
		expect(cards).toEqual(["PR #41", "PR #42", "PR #40"]);
	});

	it("uses the singular heading and shows enriched facts for a single PR", () => {
		renderWithQuery(<SessionInspector session={session([pr(7, "open")])} />);

		expect(screen.getByText("Pull request")).toBeInTheDocument();
		expect(screen.queryByText(/Pull requests \(/)).not.toBeInTheDocument();
		expect(prSection("Pull request").getByText("PR #7")).toBeInTheDocument();
		// CI/Merge/Review facts surface per card.
		expect(prSection("Pull request").getAllByText("Passing").length).toBeGreaterThan(0);
	});

	it("shows the empty state when there are no PRs", () => {
		renderWithQuery(<SessionInspector session={session([])} />);
		expect(screen.getByText("No pull request opened yet.")).toBeInTheDocument();
	});

	it("links each PR to its url", () => {
		renderWithQuery(<SessionInspector session={session([pr(41, "open"), pr(42, "draft")])} />);
		const links = screen.getAllByRole("link", { name: /Open/ });
		expect(links.map((a) => a.getAttribute("href"))).toEqual([
			"https://example.com/pr/41",
			"https://example.com/pr/42",
		]);
	});
});

describe("SessionInspector tabs", () => {
	it("exposes Summary, Reviews, and Browser as the three inspector tabs", () => {
		renderWithQuery(<SessionInspector session={session([pr(1, "open")])} />);
		const tabs = screen.getAllByRole("tab").map((el) => el.textContent?.trim());
		expect(tabs).toEqual(["Summary", "Reviews", "Browser"]);
	});
});

describe("SessionInspector reviews tab", () => {
	const openReviewsTab = async () => userEvent.click(screen.getByRole("tab", { name: /Reviews/ }));

	it("triggers a review and opens the returned reviewer terminal", async () => {
		mockCommonGets([], "", [reviewState(3, "needs_review")]);
		const runningReview = { ...approvedReview, status: "running", verdict: "", body: "" };
		postMock.mockResolvedValue({
			response: { status: 201 },
			data: {
				reviewerHandleId: "reviewer-pane",
				reviews: [{ ...reviewState(3, "running"), latestRun: runningReview }],
			},
		});
		const onOpenReviewerTerminal = vi.fn();

		renderWithQuery(
			<SessionInspector onOpenReviewerTerminal={onOpenReviewerTerminal} session={session([pr(3, "open")])} />,
		);
		await openReviewsTab();

		await userEvent.click(await screen.findByRole("button", { name: /run review/i }));

		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/reviews/trigger", {
				params: { path: { sessionId: "sess-1" } },
			}),
		);
		expect(onOpenReviewerTerminal).toHaveBeenCalledWith({ handleId: "reviewer-pane", harness: "codex" });
	});

	it("shows eligible and up-to-date PR review rows", async () => {
		mockCommonGets([approvedReview], "reviewer-pane", [
			reviewState(3, "needs_review", "abc123"),
			reviewState(4, "up_to_date", "def456"),
		]);

		renderWithQuery(<SessionInspector session={session([pr(3, "open"), pr(4, "open")])} />);
		await openReviewsTab();

		expect(await screen.findByText("Reviewable change 3")).toBeInTheDocument();
		expect(screen.getByText("#3")).toBeInTheDocument();
		expect(screen.getByText("Reviewable change 4")).toBeInTheDocument();
		expect(screen.getByText("#4")).toBeInTheDocument();
		expect(screen.getAllByText("Not run")).not.toHaveLength(0);
		expect(screen.getAllByText("Approved")).not.toHaveLength(0);
		expect(screen.getByRole("button", { name: "Re-run review" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Re-run" })).not.toBeInTheDocument();
	});

	it("shows a no-needed-reviews notice instead of opening the terminal when the backend reuses runs", async () => {
		mockCommonGets([approvedReview], "reviewer-pane", [reviewState(3, "up_to_date")]);
		postMock.mockResolvedValue({
			response: { status: 200 },
			data: {
				reviewerHandleId: "reviewer-pane",
				reviews: [],
			},
		});
		const onOpenReviewerTerminal = vi.fn();

		renderWithQuery(
			<SessionInspector onOpenReviewerTerminal={onOpenReviewerTerminal} session={session([pr(3, "open")])} />,
		);
		await openReviewsTab();

		await userEvent.click(await screen.findByRole("button", { name: /re-run review/i }));

		expect(await screen.findByText("No needed reviews were started.")).toBeInTheDocument();
		expect(onOpenReviewerTerminal).not.toHaveBeenCalled();
	});

	it("shows one shared terminal action", async () => {
		mockCommonGets([approvedReview], "reviewer-pane", [
			reviewState(3, "running", "abc123"),
			reviewState(4, "up_to_date", "def456"),
		]);
		const onOpenReviewerTerminal = vi.fn();

		renderWithQuery(
			<SessionInspector onOpenReviewerTerminal={onOpenReviewerTerminal} session={session([pr(3, "open")])} />,
		);
		await openReviewsTab();

		await waitFor(() => expect(screen.getAllByText("Open terminal")).toHaveLength(1));
		expect(screen.getAllByRole("button", { name: /review/i })).toHaveLength(1);
		await userEvent.click(screen.getByRole("button", { name: /open terminal/i }));

		expect(onOpenReviewerTerminal).toHaveBeenCalledWith({ handleId: "reviewer-pane", harness: "codex" });
	});

	it("shows the reviewer identity and aggregate verdict", async () => {
		mockCommonGets([approvedReview], "reviewer-pane", [reviewState(3, "changes_requested", "abc123")]);

		renderWithQuery(<SessionInspector session={session([pr(3, "open")])} />);
		await openReviewsTab();

		expect(await screen.findByText("codex")).toBeInTheDocument();
		expect(screen.getByText("reviewer")).toBeInTheDocument();
		expect(screen.queryByText("sess-1")).not.toBeInTheDocument();
		expect(screen.queryByText("review session")).not.toBeInTheDocument();
		expect(screen.getAllByText("Changes requested")).not.toHaveLength(0);
	});

	it("shows failed latest runs as failed and still allows rerun", async () => {
		mockCommonGets([failedReview], "reviewer-pane", [
			{ ...reviewState(3, "needs_review", "abc123"), latestRun: failedReview },
		]);

		renderWithQuery(<SessionInspector session={session([pr(3, "open")])} />);
		await openReviewsTab();

		expect(await screen.findAllByText("Failed")).not.toHaveLength(0);
		expect(screen.getByRole("button", { name: "Re-run review" })).toBeEnabled();
	});

	it("shows the no-PR empty state when the session has no PRs", async () => {
		mockCommonGets();
		renderWithQuery(<SessionInspector session={session([])} />);
		await userEvent.click(screen.getByRole("tab", { name: /Reviews/ }));

		expect(await screen.findByText("No pull request opened yet.")).toBeInTheDocument();
	});
});
