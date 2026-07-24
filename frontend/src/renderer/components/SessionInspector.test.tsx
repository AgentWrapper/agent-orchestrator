import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const pr = (n: number, state: PRState, overrides: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
	url: `https://example.com/pr/${n}`,
	number: n,
	state,
	ci: "passing",
	review: "approved",
	mergeability: "mergeable",
	reviewComments: false,
	updatedAt: "2026-06-15T00:00:00Z",
	...overrides,
});

const session = (prs: PullRequestFacts[], overrides: Partial<WorkspaceSession> = {}): WorkspaceSession => ({
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
	...overrides,
});

const sessionWithProvider = (prs: PullRequestFacts[], provider: WorkspaceSession["provider"]): WorkspaceSession => ({
	...session(prs),
	provider,
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

afterEach(() => {
	vi.useRealTimers();
});

describe("SessionInspector tabs", () => {
	it("sizes rail tabs to their labels instead of stretching across the inspector", () => {
		renderWithQuery(<SessionInspector session={session([])} />);

		const summaryTab = screen.getByRole("tab", { name: "Summary" });

		expect(summaryTab).not.toHaveClass("flex-1");
	});

	it("renders the supplied files view when the Files tab opens", async () => {
		const onOpenFiles = vi.fn();
		renderWithQuery(
			<SessionInspector filesView={<div>workspace file review</div>} onOpenFiles={onOpenFiles} session={session([])} />,
		);

		await userEvent.click(screen.getByRole("tab", { name: "Files" }));

		expect(onOpenFiles).toHaveBeenCalledTimes(1);
		expect(screen.getByText("workspace file review")).toBeInTheDocument();
	});
});

describe("SessionInspector PR section", () => {
	// Scope assertions to the PR section so the card order is explicit.
	const prSection = (title: string) =>
		within(screen.getByText(title).closest("[data-testid='inspector-section']") as HTMLElement);

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

describe("SessionInspector Activity section", () => {
	const activitySection = () =>
		within(screen.getByText("Activity").closest("[data-testid='inspector-section']") as HTMLElement);

	it.each([
		["idle", "Idle"],
		["active", "Working"],
		["waiting_input", "Input Needed"],
		["exited", "Exited"],
	] as const)("renders %s from raw session activity", (state, label) => {
		renderWithQuery(
			<SessionInspector
				session={session([pr(7, "open")], {
					status: "review_pending",
					activity: { state, lastActivityAt: "2026-06-15T10:00:00Z" },
				})}
			/>,
		);

		expect(activitySection().getByText(label)).toBeInTheDocument();
	});

	it("renders unknown activity through the shared activity label", () => {
		renderWithQuery(
			<SessionInspector
				session={session([], {
					status: "working",
					activity: { state: "unknown", lastActivityAt: "2026-06-15T10:00:00Z" },
				})}
			/>,
		);

		expect(activitySection().getByText("Unknown")).toBeInTheDocument();
		expect(activitySection().queryByText("Activity Unavailable")).not.toBeInTheDocument();
	});

	it("falls back to unknown when no activity has been reported", () => {
		renderWithQuery(<SessionInspector session={session([], { status: "working" })} />);

		expect(activitySection().getByText("Unknown")).toBeInTheDocument();
	});

	it("keeps the last known activity visible when the daemon reports no signal", () => {
		renderWithQuery(
			<SessionInspector
				session={session([], {
					status: "no_signal",
					activity: { state: "idle", lastActivityAt: "2026-06-15T10:00:00Z" },
				})}
			/>,
		);

		const activityRow = activitySection()
			.getByText("Idle")
			.closest("[data-testid='inspector-timeline-event']") as HTMLElement;
		expect(within(activityRow).getByText("No Signal")).toBeInTheDocument();
	});

	it("does not derive the Activity label from PR-oriented session status", () => {
		renderWithQuery(
			<SessionInspector
				session={session([], {
					status: "review_pending",
					activity: { state: "idle", lastActivityAt: "2026-06-15T10:00:00Z" },
				})}
			/>,
		);

		expect(activitySection().getByText("Idle")).toBeInTheDocument();
		expect(activitySection().queryByText("Input Needed")).not.toBeInTheDocument();
	});

	it.each([
		["ci_failed", "CI Failed"],
		["changes_requested", "Changes Requested"],
	] as const)("renders %s as an SCM state in the current Activity row", (status, label) => {
		renderWithQuery(
			<SessionInspector
				session={session([], {
					status,
					activity: { state: "idle", lastActivityAt: "2026-06-15T10:00:00Z" },
				})}
			/>,
		);

		const activityRow = activitySection()
			.getByText("Idle")
			.closest("[data-testid='inspector-timeline-event']") as HTMLElement;
		expect(within(activityRow).getByText(label)).toBeInTheDocument();
	});

	it("renders PR conflicts as an SCM state in the current Activity row", () => {
		renderWithQuery(
			<SessionInspector
				session={session([pr(7, "open", { mergeability: "conflicting" })], {
					status: "working",
					activity: { state: "idle", lastActivityAt: "2026-06-15T10:00:00Z" },
				})}
			/>,
		);

		const activityRow = activitySection()
			.getByText("Idle")
			.closest("[data-testid='inspector-timeline-event']") as HTMLElement;
		expect(within(activityRow).getByText("Conflict")).toBeInTheDocument();
	});

	it("uses activity.lastActivityAt for the Activity timestamp", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));

		renderWithQuery(
			<SessionInspector
				session={session([], {
					status: "working",
					updatedAt: "2026-06-15T11:55:00Z",
					activity: { state: "active", lastActivityAt: "2026-06-15T10:00:00Z" },
				})}
			/>,
		);

		const activityRow = activitySection()
			.getByText("Working")
			.closest("[data-testid='inspector-timeline-event']") as HTMLElement;
		expect(within(activityRow).getByText("2h ago")).toBeInTheDocument();
	});

	it("aligns text-row dots lower while keeping the Activity chip dot centered", () => {
		renderWithQuery(
			<SessionInspector
				session={session([pr(7, "open")], {
					status: "working",
					createdAt: "2026-06-15T09:00:00Z",
					activity: { state: "idle", lastActivityAt: "2026-06-15T10:00:00Z" },
				})}
			/>,
		);

		const workspaceRow = activitySection()
			.getByText(/Created workspace/)
			.closest("[data-testid='inspector-timeline-event']") as HTMLElement;
		const workspaceMarker = workspaceRow.querySelector("span[aria-hidden='true'].rounded-full") as HTMLElement;
		expect(workspaceMarker.parentElement).toHaveClass("relative", "flex", "items-center");
		expect(workspaceMarker).toHaveClass("top-1.5");
		expect(workspaceMarker).not.toHaveClass("top-1/2", "-translate-y-1/2");

		const activityRow = activitySection()
			.getByText("Idle")
			.closest("[data-testid='inspector-timeline-event']") as HTMLElement;
		const activityMarker = activityRow.querySelector("span[aria-hidden='true'].rounded-full") as HTMLElement;
		expect(activityMarker.parentElement).toHaveClass("relative", "flex", "items-center");
		expect(activityMarker).toHaveClass("top-1/2", "-translate-y-1/2");
	});

	it("keeps workspace, PR, and SCM context rows in the Activity timeline", () => {
		renderWithQuery(
			<SessionInspector
				session={session([pr(7, "open", { ci: "failing", review: "changes_requested" })], {
					status: "ci_failed",
					activity: { state: "idle", lastActivityAt: "2026-06-15T10:00:00Z" },
				})}
			/>,
		);

		expect(activitySection().getByText(/Created workspace/)).toBeInTheDocument();
		expect(activitySection().getByText("Opened")).toBeInTheDocument();
		expect(activitySection().getByText("PR #7")).toBeInTheDocument();
		const activityRow = activitySection()
			.getByText("Idle")
			.closest("[data-testid='inspector-timeline-event']") as HTMLElement;
		expect(within(activityRow).getByText("CI Failed")).toBeInTheDocument();
		expect(within(activityRow).getByText("Changes Requested")).toBeInTheDocument();
	});

	it("orders timeline milestones around the combined current state row", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));

		renderWithQuery(
			<SessionInspector
				session={session([pr(42, "draft"), pr(41, "open"), pr(40, "merged")], {
					status: "merged",
					createdAt: "2026-06-15T09:00:00Z",
					updatedAt: "2026-06-15T11:55:00Z",
					activity: { state: "idle", lastActivityAt: "2026-06-15T10:00:00Z" },
				})}
			/>,
		);

		const section = screen.getByText("Activity").closest("[data-testid='inspector-section']") as HTMLElement;
		const rows = Array.from(section.querySelectorAll("[data-testid='inspector-timeline-event']"), (row) =>
			row.textContent?.replace(/\s+/g, " ").trim(),
		);
		expect(rows).toEqual([
			"Created workspace3h ago",
			"Draft PR #42",
			"Opened PR #41",
			"Opened PR #40",
			"Idle2h ago",
			"Merged PR #40",
			"Done5m ago",
		]);
	});
});

describe("SessionInspector tabs", () => {
	it("exposes Summary, Reviews, Browser, and Files as inspector tabs", () => {
		renderWithQuery(<SessionInspector session={session([pr(1, "open")])} />);
		const tabs = screen.getAllByRole("tab").map((el) => el.textContent?.trim());
		expect(tabs).toEqual(["Summary", "Reviews", "Browser", "Files"]);
	});

	it("shows the intake issue id in the summary overview when present", () => {
		renderWithQuery(<SessionInspector session={{ ...session([]), issueId: "github:acme/project-one#42" }} />);

		expect(screen.getByText("Issue")).toBeInTheDocument();
		expect(screen.getByText("github:acme/project-one#42")).toBeInTheDocument();
	});

	it("omits the branch overview row when the session has no branch", () => {
		renderWithQuery(<SessionInspector session={session([], { branch: undefined })} />);

		expect(screen.queryByText("Branch")).not.toBeInTheDocument();
		expect(screen.queryByText("session/sess-1")).not.toBeInTheDocument();
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

	it("shows claude-code as the default reviewer before a run exists", async () => {
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/sessions/{sessionId}/reviews") {
				return { data: { reviewerHandleId: "", reviews: [] } };
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
							config: {},
						},
					},
				};
			}
			return { data: undefined };
		});

		renderWithQuery(<SessionInspector session={sessionWithProvider([pr(3, "open")], "codex")} />);
		await openReviewsTab();

		expect(await screen.findByText("claude-code")).toBeInTheDocument();
	});

	it("shows eligible and up-to-date open PR review rows", async () => {
		mockCommonGets([approvedReview], "reviewer-pane", [
			reviewState(3, "needs_review", "abc123"),
			reviewState(4, "up_to_date", "def456"),
			reviewState(5, "ineligible", "ghi789"),
		]);

		renderWithQuery(<SessionInspector session={session([pr(3, "open"), pr(4, "open"), pr(5, "draft")])} />);
		await openReviewsTab();

		expect(screen.getByText("Pull requests")).toBeInTheDocument();
		expect(await screen.findByText("Reviewable change 3")).toBeInTheDocument();
		expect(screen.getByText("#3")).toBeInTheDocument();
		expect(screen.getByText("Reviewable change 4")).toBeInTheDocument();
		expect(screen.getByText("#4")).toBeInTheDocument();
		expect(screen.queryByText("Reviewable change 5")).not.toBeInTheDocument();
		expect(screen.getAllByText("Not run")).not.toHaveLength(0);
		expect(screen.getAllByText("Approved")).not.toHaveLength(0);
		expect(screen.getByRole("button", { name: "Re-run review" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Re-run" })).not.toBeInTheDocument();
	});

	it.each([
		["needs_review", "changes_requested", "Changes requested", "Not run", "Run review"],
		["running", "approved", "Approved", "Reviewing...", "Cancel review"],
	] as const)(
		"shows the previous verdict while the current head is %s without changing its current status",
		async (status, previousVerdict, previousLabel, currentLabel, actionLabel) => {
			const current = {
				...reviewState(3, status, "sha-current"),
				previousRun: {
					...approvedReview,
					id: "run-previous",
					status: "delivered",
					verdict: previousVerdict,
					targetSha: "sha-previous",
				},
			};
			if (status === "running") {
				current.latestRun = {
					...approvedReview,
					id: "run-current",
					status: "running",
					verdict: "",
					targetSha: "sha-current",
				};
			}
			mockCommonGets([], "reviewer-pane", [current]);

			renderWithQuery(<SessionInspector session={session([pr(3, "open")])} />);
			await openReviewsTab();

			const previous = await screen.findByText(`Previous: ${previousLabel}`);
			expect(within(previous.parentElement as HTMLElement).getByText(currentLabel)).toBeInTheDocument();
			expect(screen.getByRole("button", { name: actionLabel })).toBeInTheDocument();
		},
	);

	it("hides the previous verdict after the current head review completes", async () => {
		const current = {
			...reviewState(3, "up_to_date", "sha-current"),
			previousRun: {
				...approvedReview,
				id: "run-previous",
				status: "delivered",
				verdict: "changes_requested",
				targetSha: "sha-previous",
			},
		};
		mockCommonGets([], "reviewer-pane", [current]);

		renderWithQuery(<SessionInspector session={session([pr(3, "open")])} />);
		await openReviewsTab();

		expect(await screen.findAllByText("Approved")).not.toHaveLength(0);
		expect(screen.queryByText(/Previous:/)).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Re-run review" })).toBeInTheDocument();
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

	it("cancels the running review instead of allowing rerun", async () => {
		mockCommonGets([approvedReview], "reviewer-pane", [
			reviewState(3, "running", "abc123"),
			reviewState(4, "up_to_date", "def456"),
		]);
		const onOpenReviewerTerminal = vi.fn();

		renderWithQuery(
			<SessionInspector onOpenReviewerTerminal={onOpenReviewerTerminal} session={session([pr(3, "open")])} />,
		);
		await openReviewsTab();

		await waitFor(() => expect(screen.getByRole("button", { name: "Cancel review" })).toBeEnabled());
		expect(screen.queryByRole("button", { name: /re-run review/i })).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /cancel review/i }));

		await waitFor(() => {
			expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/reviews/cancel", {
				params: { path: { sessionId: "sess-1" } },
			});
		});
		expect(onOpenReviewerTerminal).not.toHaveBeenCalled();
	});

	it("shows cancelled review runs without marking them failed", async () => {
		mockCommonGets([], "reviewer-pane", [
			{ ...reviewState(3, "needs_review", "abc123"), latestRun: { ...failedReview, status: "cancelled" } },
		]);

		renderWithQuery(<SessionInspector session={session([pr(3, "open")])} />);
		await openReviewsTab();

		expect(await screen.findAllByText("Cancelled")).toHaveLength(2);
		expect(screen.queryByText("Failed")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Re-run review" })).toBeEnabled();
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
