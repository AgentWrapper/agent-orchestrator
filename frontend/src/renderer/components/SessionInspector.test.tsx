import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionInspector } from "./SessionInspector";
import type { SessionPRSummary } from "../hooks/useSessionScmSummary";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import type { PRState, PullRequestFacts, WorkspaceSession, WorkspaceSummary } from "../types/workspace";

const { getMock, navigateMock, patchMock, putMock, postMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	navigateMock: vi.fn(),
	patchMock: vi.fn(),
	putMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: getMock,
		PATCH: patchMock,
		POST: postMock,
		PUT: putMock,
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

const prSummary = (
	number: number,
	state: SessionPRSummary["state"],
	overrides: Partial<SessionPRSummary> = {},
): SessionPRSummary => {
	const url = `https://github.com/acme/repo/pull/${number}`;
	return {
		url: `https://api.github.com/repos/acme/repo/pulls/${number}`,
		htmlUrl: url,
		number,
		title: `PR ${number}`,
		state,
		provider: "github",
		repo: "acme/repo",
		author: "ada",
		sourceBranch: `feat/${number}`,
		targetBranch: "main",
		headSha: `sha-${number}`,
		additions: 4,
		deletions: 1,
		changedFiles: 2,
		ci: { state: "passing", failingChecks: [] },
		review: { decision: "none", hasUnresolvedHumanComments: false, unresolvedBy: [] },
		mergeability: { state: "mergeable", reasons: [], prUrl: url, conflictFiles: [] },
		updatedAt: "2026-06-15T12:00:00Z",
		...overrides,
	};
};

function renderWithQuery(children: ReactNode, workspaces?: WorkspaceSummary[]) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	if (workspaces) client.setQueryData(workspaceQueryKey, workspaces);
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
	navigateMock.mockReset();
	patchMock.mockReset();
	postMock.mockReset();
	putMock.mockReset();
	getMock.mockResolvedValue({ data: { reviewerHandleId: "", reviews: [] }, error: undefined });
	patchMock.mockResolvedValue({ data: { ok: true }, error: undefined, response: { status: 200 } });
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
		expect(summaryTab).toHaveClass("h-control-md", "px-1.5");
		expect(summaryTab).toHaveAttribute("title", "Summary");
		expect(within(summaryTab).getByText("Summary")).toHaveClass("@max-[350px]/inspector:hidden");
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
		expect(prSection("Pull request").getByText("open")).toHaveClass("text-[9px]", "leading-none");
	});

	it("shows the empty state when there are no PRs", () => {
		renderWithQuery(<SessionInspector session={session([])} />);
		expect(screen.getByText("No pull request opened yet.")).toBeInTheDocument();
	});

	it("links each PR to its url", () => {
		renderWithQuery(<SessionInspector session={session([pr(41, "open"), pr(42, "draft")])} />);
		const links = prSection("Pull requests (2)").getAllByRole("link", { name: "Open" });
		expect(links.map((a) => a.getAttribute("href"))).toEqual([
			"https://example.com/pr/41",
			"https://example.com/pr/42",
		]);
	});
});

describe("SessionInspector completion controls", () => {
	it("persists the terminate-on-merge preference", async () => {
		renderWithQuery(<SessionInspector session={session([])} />);

		await userEvent.click(screen.getByRole("switch", { name: "Terminate session when pull requests merge" }));

		await waitFor(() =>
			expect(patchMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/merge-policy", {
				params: { path: { sessionId: "sess-1" } },
				body: { terminateOnPrMerge: true },
			}),
		);
	});

	it("terminates a live merged session and returns to its orchestrator immediately", async () => {
		postMock.mockReturnValue(new Promise(() => {}));
		const worker = session([pr(7, "merged")], { status: "merged" });
		const orchestrator = session([], { id: "orch-1", kind: "orchestrator", title: "orchestrator" });
		renderWithQuery(<SessionInspector session={worker} />, [
			{
				id: "ws-1",
				name: "my-app",
				path: "/repo",
				sessions: [worker, orchestrator],
			},
		]);

		expect(
			screen.queryByRole("switch", { name: "Terminate session when pull requests merge" }),
		).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Terminate session" }));
		expect(screen.getByRole("dialog", { name: "Terminate do the thing?" })).toBeInTheDocument();
		await userEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", { name: "Yes, terminate session" }),
		);

		expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/kill", {
			params: { path: { sessionId: "sess-1" } },
		});
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "ws-1", sessionId: "orch-1" },
		});
	});

	it("keeps the confirmation dismissed after a termination failure", async () => {
		postMock.mockResolvedValueOnce({ error: new Error("runtime teardown failed"), response: { status: 500 } });
		renderWithQuery(<SessionInspector session={session([pr(7, "merged")], { status: "merged" })} />);

		await userEvent.click(screen.getByRole("button", { name: "Terminate session" }));
		await userEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", { name: "Yes, terminate session" }),
		);

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId",
			params: { projectId: "ws-1" },
		});
	});

	it("hides completion controls after the session is terminated", () => {
		renderWithQuery(
			<SessionInspector session={session([pr(7, "merged")], { status: "merged", isTerminated: true })} />,
		);

		expect(screen.queryByText("Completion")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Terminate session" })).not.toBeInTheDocument();
	});

	it("does not show completion controls for orchestrator sessions", () => {
		renderWithQuery(<SessionInspector session={session([], { kind: "orchestrator" })} />);

		expect(screen.queryByText("Completion")).not.toBeInTheDocument();
		expect(screen.queryByRole("switch")).not.toBeInTheDocument();
	});
});

describe("SessionInspector Activity section", () => {
	const activitySection = () =>
		within(screen.getByText("Activity").closest("[data-testid='inspector-section']") as HTMLElement);

	it("offers a managed resume only for an exited, nonterminated agent", async () => {
		renderWithQuery(
			<SessionInspector
				session={session([], {
					status: "exited",
					activity: { state: "exited", lastActivityAt: "2026-06-15T10:00:00Z" },
				})}
			/>,
		);

		await userEvent.click(activitySection().getByRole("button", { name: "Resume agent" }));

		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/resume-agent", {
				params: { path: { sessionId: "sess-1" } },
			}),
		);
	});

	it("does not offer agent resume for a live or terminated session", () => {
		const live = renderWithQuery(
			<SessionInspector
				session={session([], {
					status: "idle",
					activity: { state: "idle", lastActivityAt: "2026-06-15T10:00:00Z" },
				})}
			/>,
		);

		expect(screen.queryByRole("button", { name: "Resume agent" })).not.toBeInTheDocument();

		live.unmount();
		renderWithQuery(
			<SessionInspector
				session={session([], {
					status: "terminated",
					isTerminated: true,
					activity: { state: "exited", lastActivityAt: "2026-06-15T10:00:00Z" },
				})}
			/>,
		);
		expect(screen.queryByRole("button", { name: "Resume agent" })).not.toBeInTheDocument();
	});

	it("keeps resume failures visible beside the action", async () => {
		postMock.mockResolvedValueOnce({ error: new Error("agent restart failed"), response: { status: 500 } });
		renderWithQuery(
			<SessionInspector
				session={session([], {
					status: "exited",
					activity: { state: "exited", lastActivityAt: "2026-06-15T10:00:00Z" },
				})}
			/>,
		);

		await userEvent.click(activitySection().getByRole("button", { name: "Resume agent" }));

		expect(await activitySection().findByText("agent restart failed")).toBeInTheDocument();
	});

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

	it("does not timestamp the live Activity state as a historical event", () => {
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
		expect(within(activityRow).queryByText("2h ago")).not.toBeInTheDocument();
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

	it("links and timestamps draft, opened, and merged PR milestones from backend lifecycle times", async () => {
		const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
		const summaries = [
			prSummary(8, "draft", {
				createdAt: minutesAgo(120),
				stateChangedAt: minutesAgo(120),
			}),
			prSummary(7, "open", {
				createdAt: minutesAgo(60),
				stateChangedAt: minutesAgo(15),
			}),
			prSummary(6, "merged", {
				createdAt: minutesAgo(180),
				stateChangedAt: minutesAgo(30),
			}),
		];
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/sessions/{sessionId}/pr") {
				return { data: { sessionId: "sess-1", prs: summaries }, error: undefined };
			}
			return { data: { reviewerHandleId: "", reviews: [] }, error: undefined };
		});

		renderWithQuery(
			<SessionInspector
				session={session([pr(8, "draft"), pr(7, "open"), pr(6, "merged")], {
					status: "merged",
					activity: { state: "idle", lastActivityAt: "2026-06-15T11:50:00Z" },
				})}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByRole("link", { name: "Draft PR #8" })).toHaveAttribute(
				"href",
				"https://github.com/acme/repo/pull/8",
			);
		});
		const draftLink = screen.getByRole("link", { name: "Draft PR #8" });
		expect(
			within(draftLink.closest("[data-testid='inspector-timeline-event']") as HTMLElement).getByText("2h ago"),
		).toBeInTheDocument();

		const openLink = screen.getByRole("link", { name: "Opened PR #7" });
		expect(
			within(openLink.closest("[data-testid='inspector-timeline-event']") as HTMLElement).getByText("1h ago"),
		).toBeInTheDocument();

		const mergedOpenedLink = screen.getByRole("link", { name: "Opened PR #6" });
		expect(
			within(mergedOpenedLink.closest("[data-testid='inspector-timeline-event']") as HTMLElement).getByText("3h ago"),
		).toBeInTheDocument();

		const mergedLink = screen.getByRole("link", { name: "Merged PR #6" });
		expect(
			within(mergedLink.closest("[data-testid='inspector-timeline-event']") as HTMLElement).getByText("30m ago"),
		).toBeInTheDocument();
		const doneRow = screen.getByText("Done").closest("[data-testid='inspector-timeline-event']") as HTMLElement;
		expect(within(doneRow).getByText("30m ago")).toBeInTheDocument();
	});

	it("renders the current state before reverse-chronological historical milestones", () => {
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
			"Idle",
			"Done",
			"Merged PR #40",
			"Opened PR #40",
			"Opened PR #41",
			"Draft PR #42",
			"Created workspace3h ago",
		]);

		const eventRows = section.querySelectorAll("[data-testid='inspector-timeline-event']");
		expect(section.querySelectorAll("[data-testid='inspector-timeline-connector']")).toHaveLength(eventRows.length - 1);
		expect(
			within(eventRows[eventRows.length - 1] as HTMLElement).queryByTestId("inspector-timeline-connector"),
		).not.toBeInTheDocument();
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
	// PR rows start collapsed, so opening the tab alone shows only their titles.
	// Reveal every row, since these tests are about what a review says.
	const openReviewsTab = async () => {
		await userEvent.click(screen.getByRole("tab", { name: /Reviews/ }));
		// Rows arrive with the reviews query, so wait for them before expanding.
		const rows = await screen.findAllByTestId("review-pr-row").catch(() => []);
		for (const row of rows) {
			if (row.getAttribute("aria-expanded") === "false") await userEvent.click(row);
		}
	};

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

		expect(await screen.findByRole("button", { name: /Select reviewer agent/ })).toHaveTextContent("claude-code");
		expect(screen.queryByText("reviewer")).not.toBeInTheDocument();
	});

	it("places not-run status beside the PR number without an aggregate status chip", async () => {
		mockCommonGets([], "", [reviewState(3, "needs_review", "abc123")]);

		renderWithQuery(<SessionInspector session={session([pr(3, "open")])} />);
		await openReviewsTab();

		expect(await screen.findByText("Reviewable change 3")).toBeInTheDocument();
		expect(screen.getByText("#3 · Not run")).toBeInTheDocument();
		expect(screen.getAllByText("Not run")).toHaveLength(1);
	});

	it("shows eligible and up-to-date open PR review rows", async () => {
		mockCommonGets([approvedReview], "reviewer-pane", [
			reviewState(3, "needs_review", "abc123"),
			reviewState(4, "up_to_date", "def456"),
			reviewState(5, "ineligible", "ghi789"),
		]);

		renderWithQuery(<SessionInspector session={session([pr(3, "open"), pr(4, "open"), pr(5, "draft")])} />);
		await openReviewsTab();

		expect(screen.getByRole("button", { name: /Select reviewer agent/ })).toHaveTextContent("codex");
		expect(await screen.findByText("Reviewable change 3")).toBeInTheDocument();
		expect(screen.getByText("#3 · Not run")).toBeInTheDocument();
		expect(screen.getByText("Reviewable change 4")).toBeInTheDocument();
		expect(screen.queryByText("Reviewable change 5")).not.toBeInTheDocument();
		expect(screen.getAllByText("Not run")).not.toHaveLength(0);
		expect(screen.getAllByText("Approved")).not.toHaveLength(0);
		expect(screen.getByRole("button", { name: "Re-run review" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Re-run" })).not.toBeInTheDocument();
	});

	it.each([
		["needs_review", "changes_requested", "Not run on this commit", "Run review", true],
		["running", "approved", "Reviewing...", "Cancel review", false],
	] as const)(
		"shows only the latest available AO review run while the current head is %s",
		async (status, previousVerdict, runLabel, actionLabel, showsPreviousRun) => {
			const current = {
				...reviewState(3, status, "sha-current"),
				previousRun: {
					...approvedReview,
					id: "run-previous",
					status: "delivered",
					verdict: previousVerdict,
					body: "Previous review summary with actionable detail.",
					githubReviewId: "98765",
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

			expect(await screen.findByText(runLabel)).toBeInTheDocument();
			if (showsPreviousRun) {
				expect(screen.queryByText("#3 · Not run")).not.toBeInTheDocument();
				expect(screen.getByText(/^#3 · /)).toBeInTheDocument();
				// The head moved on, so the old verdict must be labelled as previous
				// rather than presented as the state of the current commit.
				expect(screen.getByText(/Previous:/)).toBeInTheDocument();
				expect(screen.getByText("Changes requested")).toBeInTheDocument();
				expect(screen.getByText("Previous review summary with actionable detail.")).toBeInTheDocument();
				expect(screen.getByRole("link", { name: "View previous review" })).toHaveAttribute(
					"href",
					"https://example.com/pr/3#pullrequestreview-98765",
				);
			} else {
				expect(screen.queryByText("Previous review summary with actionable detail.")).not.toBeInTheDocument();
				expect(screen.queryByRole("link", { name: "View previous review" })).not.toBeInTheDocument();
			}
			// A run in flight gets its own live strip naming the harness, not just a
			// word on the button.
			if (status === "running") {
				expect(screen.getByText("codex is reviewing this change…")).toBeInTheDocument();
			} else {
				expect(screen.queryByText(/is reviewing this change/)).not.toBeInTheDocument();
			}
			expect(screen.getByRole("button", { name: actionLabel })).toBeInTheDocument();
		},
	);

	it("lists PR reviewers and resolves their threads through the session route", async () => {
		mockCommonGets([], "reviewer-pane", [reviewState(3, "up_to_date", "sha-1")]);
		const previous = getMock.getMockImplementation()!;
		getMock.mockImplementation(async (path: string, opts?: unknown) => {
			if (path === "/api/v1/sessions/{sessionId}/pr") {
				return {
					data: {
						prs: [
							{
								number: 3,
								title: "Reviewable change 3",
								url: "https://example.com/pr/3",
								htmlUrl: "https://example.com/pr/3",
								state: "open",
								ci: { state: "passing", failingChecks: [], prUrl: "https://example.com/pr/3" },
								mergeability: {
									state: "mergeable",
									reasons: [],
									prUrl: "https://example.com/pr/3",
									conflictFiles: [],
								},
								review: {
									decision: "changes_requested",
									hasUnresolvedHumanComments: true,
									reviews: [
										{
											reviewerId: "maya",
											verdict: "changes_requested",
											submittedAt: "2026-01-01T00:00:00Z",
											body: "Tear down the listener on unmount.",
											reviewUrl: "https://example.com/pr/3#pullrequestreview-1",
										},
									],
									unresolvedBy: [
										{
											reviewerId: "maya",
											count: 2,
											// Two comments, one thread: the button resolves threads, not comments.
											links: [
												{ threadId: "T1", file: "a.ts", line: 3 },
												{ threadId: "T1", file: "a.ts", line: 9 },
											],
										},
									],
								},
							},
						],
					},
				};
			}
			return previous(path, opts);
		});
		renderWithQuery(<SessionInspector session={session([pr(3, "open")])} />);
		await openReviewsTab();

		// Both sources sit in one panel now, so the PR reviews need no navigation.
		expect(await screen.findByText("maya")).toBeInTheDocument();
		expect(screen.getByText("Tear down the listener on unmount.")).toBeInTheDocument();
		expect(screen.getByText(/2 unresolved/)).toBeInTheDocument();

		postMock.mockResolvedValue({ data: { ok: true, resolved: 1 } });
		await userEvent.click(screen.getByRole("button", { name: "Resolve 1 thread" }));
		expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/prs/{prNumber}/resolve-comments", {
			params: { path: { sessionId: "sess-1", prNumber: 3 } },
			body: { commentIds: ["T1"] },
		});
	});

	it("sends the chosen reviewer as a one-off override", async () => {
		mockCommonGets([], "reviewer-pane", [reviewState(3, "needs_review", "sha-1")]);
		postMock.mockResolvedValue({ data: { reviewerHandleId: "", reviews: [] }, response: { status: 201 } });

		renderWithQuery(<SessionInspector session={session([pr(3, "open")])} />);
		await openReviewsTab();

		await userEvent.click(await screen.findByRole("button", { name: /Select reviewer agent/ }));
		await userEvent.click(await screen.findByRole("menuitem", { name: /opencode/ }));
		await userEvent.click(screen.getByRole("button", { name: "Run review" }));

		expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/reviews/trigger", {
			params: { path: { sessionId: "sess-1" } },
			body: { harness: "opencode" },
		});
	});

	it("turns off sending review findings to the agent", async () => {
		mockCommonGets([], "reviewer-pane", [reviewState(3, "up_to_date", "sha-1")]);
		postMock.mockResolvedValue({ data: {} });

		renderWithQuery(<SessionInspector session={session([pr(3, "open")])} />);
		await openReviewsTab();

		// Delivery is the pre-existing behaviour, so the switch starts on.
		const toggle = await screen.findByRole("switch", { name: "Send review findings to the agent" });
		expect(toggle).toBeChecked();

		await userEvent.click(toggle);
		expect(putMock).toHaveBeenCalledWith("/api/v1/projects/{id}/config", {
			params: { path: { id: "ws-1" } },
			body: { config: { reviewers: [{ harness: "codex" }], reviewAutoInjectOff: true } },
		});
	});

	it("names the reviewer that is actually running, not whichever PR comes first", async () => {
		// One PR reviewed earlier by claude-code, another running under codex.
		const done = {
			...reviewState(3, "up_to_date", "sha-a"),
			latestRun: { ...approvedReview, id: "run-done", harness: "claude-code", status: "complete" },
		};
		const running = {
			...reviewState(4, "running", "sha-b"),
			latestRun: {
				...approvedReview,
				id: "run-live",
				harness: "codex",
				status: "running",
				verdict: "",
				createdAt: "2026-01-02T00:00:00Z",
			},
		};
		mockCommonGets([], "reviewer-pane", [done, running]);

		renderWithQuery(<SessionInspector session={session([pr(3, "open"), pr(4, "open")])} />);
		await openReviewsTab();

		expect(await screen.findByText("codex is reviewing this change…")).toBeInTheDocument();
		expect(screen.queryByText("claude-code is reviewing this change…")).not.toBeInTheDocument();
	});

	it("gives each reviewer its own tab and lands on the one just run", async () => {
		const state = {
			...reviewState(3, "changes_requested", "sha-1"),
			latestRun: {
				...approvedReview,
				id: "run-codex",
				harness: "codex",
				verdict: "changes_requested",
				body: "codex asked for tests.",
				createdAt: "2026-01-03T00:00:00Z",
			},
		};
		mockCommonGets([], "reviewer-pane", [state]);
		const previous = getMock.getMockImplementation()!;
		getMock.mockImplementation(async (path: string, opts?: unknown) => {
			if (path === "/api/v1/sessions/{sessionId}/reviews") {
				return {
					data: {
						reviewerHandleId: "reviewer-pane",
						reviews: [state],
						runs: [
							state.latestRun,
							{
								...approvedReview,
								id: "run-claude",
								harness: "claude-code",
								verdict: "approved",
								body: "claude-code found nothing blocking.",
								createdAt: "2026-01-01T00:00:00Z",
							},
						],
					},
				};
			}
			return previous(path, opts);
		});

		renderWithQuery(<SessionInspector session={session([pr(3, "open")])} />);
		await openReviewsTab();

		// The newest run leads, so its verdict is what you see first.
		expect(await screen.findByText("codex asked for tests.")).toBeInTheDocument();
		expect(screen.queryByText("claude-code found nothing blocking.")).not.toBeInTheDocument();

		// The other reviewer is one click away, not buried.
		await userEvent.click(screen.getByRole("tab", { name: /claude-code/ }));
		expect(await screen.findByText("claude-code found nothing blocking.")).toBeInTheDocument();
	});

	it("moves the picker when you pick a reviewer to read", async () => {
		const state = {
			...reviewState(3, "changes_requested", "sha-1"),
			latestRun: { ...approvedReview, id: "run-codex", harness: "codex", createdAt: "2026-01-03T00:00:00Z" },
		};
		mockCommonGets([], "reviewer-pane", [state]);
		const previous = getMock.getMockImplementation()!;
		getMock.mockImplementation(async (path: string, opts?: unknown) => {
			if (path === "/api/v1/sessions/{sessionId}/reviews") {
				return {
					data: {
						reviewerHandleId: "reviewer-pane",
						reviews: [state],
						runs: [
							state.latestRun,
							{ ...approvedReview, id: "run-claude", harness: "claude-code", createdAt: "2026-01-01T00:00:00Z" },
						],
					},
				};
			}
			return previous(path, opts);
		});

		renderWithQuery(<SessionInspector session={session([pr(3, "open")])} />);
		await openReviewsTab();

		// Newest run leads, so the picker starts there.
		expect(await screen.findByRole("button", { name: /Select reviewer agent/ })).toHaveTextContent("codex");

		// Reading another reviewer makes it the one that runs next, so the two
		// controls never disagree about which agent you are on.
		await userEvent.click(screen.getByRole("tab", { name: /claude-code/ }));
		expect(screen.getByRole("button", { name: /Select reviewer agent/ })).toHaveTextContent("claude-code");
	});

	it("locks the reviewer choice while one is running", async () => {
		const running = {
			...reviewState(3, "running", "sha-1"),
			latestRun: { ...approvedReview, id: "run-live", harness: "codex", status: "running", verdict: "" },
		};
		mockCommonGets([], "reviewer-pane", [running]);

		renderWithQuery(<SessionInspector session={session([pr(3, "open")])} />);
		await openReviewsTab();

		// AO runs one reviewer per worker, so a second harness cannot start
		// alongside it. Say so rather than silently ignoring the choice.
		expect(await screen.findByText(/cancel it to review with a different agent/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Select reviewer agent/ })).toBeDisabled();
	});

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

		expect(await screen.findAllByText("Cancelled")).toHaveLength(1);
		expect(screen.queryByText("Failed")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Re-run review" })).toBeEnabled();
	});

	it("shows the reviewer identity and aggregate verdict", async () => {
		mockCommonGets([approvedReview], "reviewer-pane", [reviewState(3, "changes_requested", "abc123")]);

		renderWithQuery(<SessionInspector session={session([pr(3, "open")])} />);
		await openReviewsTab();

		expect(await screen.findByRole("button", { name: /Select reviewer agent/ })).toHaveTextContent("codex");
		expect(screen.queryByText("reviewer")).not.toBeInTheDocument();
		expect(screen.queryByText("sess-1")).not.toBeInTheDocument();
		expect(screen.queryByText("review session")).not.toBeInTheDocument();
		expect(screen.getAllByText("Changes requested")).not.toHaveLength(0);
	});

	it("omits pull request review summaries from the Reviews tab", async () => {
		mockCommonGets([], "", [reviewState(3, "needs_review", "abc123")]);

		renderWithQuery(<SessionInspector session={session([pr(3, "open")])} />);
		await openReviewsTab();

		expect(await screen.findByRole("button", { name: /Select reviewer agent/ })).toHaveTextContent("codex");
		expect(screen.queryByText("Pull request reviews")).not.toBeInTheDocument();
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

	it("hides the Reviews tab entirely when the session has no PRs", async () => {
		mockCommonGets();
		renderWithQuery(<SessionInspector session={session([])} />);

		await screen.findByRole("tab", { name: /Summary/ });
		expect(screen.queryByRole("tab", { name: /Reviews/ })).not.toBeInTheDocument();
	});

	it("falls back to Summary when a controlled Reviews view has no PR to show", async () => {
		mockCommonGets();
		renderWithQuery(<SessionInspector session={session([])} view="reviews" />);

		expect(await screen.findByRole("tab", { name: /Summary/ })).toHaveAttribute("aria-selected", "true");
		expect(screen.queryByRole("tab", { name: /Reviews/ })).not.toBeInTheDocument();
		// Summary has its own "No pull request opened yet." line, so assert on the
		// reviews panel's own content instead of that shared string.
		expect(screen.queryByRole("button", { name: /run review/i })).not.toBeInTheDocument();
	});
});
