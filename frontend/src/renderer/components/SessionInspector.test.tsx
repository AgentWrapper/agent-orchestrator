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

function mockCommonGets(reviews: unknown[] = [], reviewerHandleId = "") {
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
	batchId: "batch-1",
	harness: "codex",
	status: "complete",
	verdict: "approved",
	body: "Looks good.",
	prUrl: "https://example.com/pr/3",
	targetSha: "abc123",
	createdAt: "2026-06-16T10:06:00Z",
};

const reviewState = (latestRun = approvedReview) => ({
	prUrl: latestRun.prUrl,
	prNumber: 3,
	targetSha: latestRun.targetSha,
	status: latestRun.status === "running" ? "running" : "up_to_date",
	latestRun,
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
		mockCommonGets();
		postMock.mockResolvedValue({
			response: { status: 201 },
			data: {
				reviewerHandleId: "reviewer-pane",
				reviews: [reviewState({ ...approvedReview, status: "running", verdict: "", body: "" })],
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

	it("shows an up-to-date notice instead of opening the terminal when the backend reuses a run", async () => {
		mockCommonGets([reviewState()], "reviewer-pane");
		postMock.mockResolvedValue({
			response: { status: 200 },
			data: { reviewerHandleId: "reviewer-pane", reviews: [reviewState()] },
		});
		const onOpenReviewerTerminal = vi.fn();

		renderWithQuery(
			<SessionInspector onOpenReviewerTerminal={onOpenReviewerTerminal} session={session([pr(3, "open")])} />,
		);
		await openReviewsTab();

		await userEvent.click(await screen.findByRole("button", { name: /re-run review/i }));

		expect(await screen.findByText("Review is already up to date for this commit.")).toBeInTheDocument();
		expect(onOpenReviewerTerminal).not.toHaveBeenCalled();
	});

	it("shows an approved review and opens its terminal", async () => {
		mockCommonGets([reviewState()], "reviewer-pane");
		const onOpenReviewerTerminal = vi.fn();

		renderWithQuery(
			<SessionInspector onOpenReviewerTerminal={onOpenReviewerTerminal} session={session([pr(3, "open")])} />,
		);
		await openReviewsTab();

		await waitFor(() => expect(screen.getAllByText("Approved").length).toBeGreaterThan(0));
		await userEvent.click(screen.getByRole("button", { name: /open terminal/i }));

		expect(onOpenReviewerTerminal).toHaveBeenCalledWith({ handleId: "reviewer-pane", harness: "codex" });
	});

	it("shows the no-PR empty state when the session has no PRs", async () => {
		mockCommonGets();
		renderWithQuery(<SessionInspector session={session([])} />);
		await userEvent.click(screen.getByRole("tab", { name: /Reviews/ }));

		expect(await screen.findByText("No pull request opened yet.")).toBeInTheDocument();
	});
});
