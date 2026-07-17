import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, initializeRendererI18n } from "../i18n";
import type { SessionPRSummary } from "../hooks/useSessionScmSummary";
import { PullRequestsPage } from "./PullRequestsPage";
import type { PRState, PullRequestFacts, WorkspaceSession, WorkspaceSummary } from "../types/workspace";

const { getMock, navigateMock, postMock, useWorkspaceQueryMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	navigateMock: vi.fn(),
	postMock: vi.fn(),
	useWorkspaceQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));
vi.mock("../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: () => useWorkspaceQueryMock(),
	workspaceQueryKey: ["workspaces"],
}));
vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: (...args: unknown[]) => getMock(...args),
		POST: (...args: unknown[]) => postMock(...args),
	},
	apiErrorMessage: (e: unknown, fallback = "error") => (e instanceof Error ? e.message : fallback),
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

const gitlabPr = (n: number, state: PRState): PullRequestFacts => ({
	...pr(n, state),
	url: `https://gitlab.example.com/group/app/-/merge_requests/${n}`,
});

let sessionSummaries: SessionPRSummary[] = [];

const summary = (n: number, state: PRState, provider: "github" | "gitlab" = "github"): SessionPRSummary => {
	const url =
		provider === "gitlab"
			? `https://gitlab.example.com/group/app/-/merge_requests/${n}`
			: `https://example.com/pr/${n}`;
	return {
		url,
		htmlUrl: url,
		number: n,
		title: `PR ${n}`,
		state,
		provider,
		repo: "group/app",
		author: "alice",
		sourceBranch: "feat/ns",
		targetBranch: "main",
		headSha: `head-${n}`,
		additions: 0,
		deletions: 0,
		changedFiles: 0,
		ci: { state: "passing", failingChecks: [] },
		review: { decision: "approved", hasUnresolvedHumanComments: false, unresolvedBy: [] },
		mergeability: { state: "mergeable", reasons: [], prUrl: url },
		updatedAt: "2026-06-15T00:00:00Z",
	};
};

const session = (id: string, prs: PullRequestFacts[]): WorkspaceSession => ({
	id,
	workspaceId: "proj-1",
	workspaceName: "my-app",
	title: id,
	provider: "claude-code",
	kind: "worker",
	branch: "feat/ns",
	status: "review_pending",
	updatedAt: "2026-06-15T00:00:00Z",
	prs,
});

function setWorkspaces(sessions: WorkspaceSession[]) {
	const data: WorkspaceSummary[] = [{ id: "proj-1", name: "my-app", path: "/p", sessions }];
	useWorkspaceQueryMock.mockReturnValue({ data, isError: false, isLoading: false });
}

function renderPage(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
	render(
		<QueryClientProvider client={queryClient}>
			<PullRequestsPage />
		</QueryClientProvider>,
	);
	return queryClient;
}

function mockProject(
	repo = "https://github.com/acme/my-app.git",
	scm?: { provider: "gitlab"; connectionId: string; repo: string },
) {
	getMock.mockImplementation((path: string) => {
		if (path === "/api/v1/sessions/{sessionId}/pr") {
			return Promise.resolve({ data: { prs: sessionSummaries }, error: undefined });
		}
		if (path === "/api/v1/scm/connections") {
			return Promise.resolve({ data: { connections: [] }, error: undefined });
		}
		return Promise.resolve({
			data: {
				status: "ok",
				project: {
					id: "proj-1",
					name: "my-app",
					path: "/p",
					repo,
					defaultBranch: "main",
					kind: "single_repo",
					config: scm ? { scm } : {},
				},
			},
			error: undefined,
		});
	});
}

beforeEach(() => {
	navigateMock.mockReset();
	sessionSummaries = [];
	getMock.mockReset();
	mockProject();
	postMock.mockReset().mockResolvedValue({ data: { method: "squash" }, error: undefined });
});

afterEach(async () => {
	vi.restoreAllMocks();
	await initializeRendererI18n("en");
});

describe("PullRequestsPage", () => {
	it("renders one row per PR across sessions, actionable PRs first", () => {
		setWorkspaces([session("auth", [pr(41, "open"), pr(42, "draft"), pr(40, "merged")])]);
		renderPage();

		const rows = screen.getAllByRole("row").slice(1); // drop header
		const numbers = rows.map((r) => within(r).getByText(/^#\d+$/).textContent);
		expect(numbers).toEqual(["#41", "#42", "#40"]);
	});

	it("merges the PR by its own number, not the session's", async () => {
		sessionSummaries = [summary(41, "open"), summary(42, "draft")];
		setWorkspaces([session("auth", [pr(41, "open"), pr(42, "draft")])]);
		renderPage();
		const user = userEvent.setup();

		const childRow = screen.getByText("#42").closest("tr")!;
		const merge = within(childRow).getByRole("button", { name: "Merge" });
		await waitFor(() => expect(merge).toBeEnabled());
		await user.click(merge);

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/prs/{id}/merge", {
			params: { path: { id: "42" } },
			body: { sessionId: "auth", prUrl: "https://example.com/pr/42", expectedHeadSha: "head-42" },
		});
	});

	it("resolves comments with the owning session and PR URL", async () => {
		setWorkspaces([session("auth", [pr(41, "open")])]);
		renderPage();
		const user = userEvent.setup();
		const resolve = screen.getByRole("button", { name: "Resolve" });
		await waitFor(() => expect(resolve).toBeEnabled());

		await user.click(resolve);

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/prs/{id}/resolve-comments", {
			params: { path: { id: "41" } },
			body: { sessionId: "auth", prUrl: "https://example.com/pr/41" },
		});
	});

	it("keeps merge disabled until the current PR head is available without blocking resolve", async () => {
		setWorkspaces([session("auth", [pr(41, "open")])]);
		renderPage();

		await waitFor(() => expect(screen.getByRole("button", { name: "Resolve" })).toBeEnabled());
		expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
		expect(screen.getByText("Merge is unavailable until the latest PR details load.")).toBeInTheDocument();

		await i18n.changeLanguage("zh-CN");
		expect(await screen.findByText("加载最新 PR 详情后才能合并。")).toBeInTheDocument();
	});

	it("shows an empty state when no session has a PR", () => {
		setWorkspaces([session("idle", [])]);
		renderPage();
		expect(screen.getByText("Pull / merge requests")).toBeInTheDocument();
		expect(screen.getByText("No open pull or merge requests.")).toBeInTheDocument();
	});

	it("localizes the table and formats each provider's number independently", async () => {
		await initializeRendererI18n("zh-CN");
		setWorkspaces([session("原始标题", [pr(41, "open"), gitlabPr(42, "draft")])]);
		renderPage();

		expect(screen.getByText("拉取 / 合并请求")).toBeInTheDocument();
		expect(screen.getByText("#41")).toBeInTheDocument();
		expect(screen.getByText("!42")).toBeInTheDocument();
		expect(screen.getAllByText("原始标题")).not.toHaveLength(0);
		expect(screen.getAllByRole("button", { name: "合并" })).toHaveLength(2);
	});

	it("retranslates an existing semantic merge error without remounting", async () => {
		await initializeRendererI18n("en");
		sessionSummaries = [summary(41, "open")];
		postMock.mockResolvedValueOnce({ data: undefined, error: {} });
		setWorkspaces([session("auth", [pr(41, "open")])]);
		renderPage();
		const user = userEvent.setup();

		const merge = screen.getByRole("button", { name: "Merge" });
		await waitFor(() => expect(merge).toBeEnabled());
		await user.click(merge);
		expect(await screen.findByText("merge failed")).toBeInTheDocument();

		await i18n.changeLanguage("zh-CN");
		expect(await screen.findByText("合并失败")).toBeInTheDocument();
	});

	it("disables write actions for an untested custom connection", async () => {
		sessionSummaries = [summary(41, "open", "gitlab")];
		mockProject("git@gitlab.example.com:group/app.git", {
			provider: "gitlab",
			connectionId: "gitlab-work",
			repo: "group/app",
		});
		setWorkspaces([session("auth", [gitlabPr(41, "open")])]);
		const queryClient = renderPage();

		expect(await screen.findByText("Write access has not been verified for this repository.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Resolve" })).toBeDisabled();

		await i18n.changeLanguage("zh-CN");
		expect(await screen.findByText("尚未验证该仓库的写入权限。")).toBeInTheDocument();

		act(() => {
			queryClient.setQueryData(["scm-capabilities", "gitlab-work", "group/app"], {
				read: true,
				write: true,
			});
		});
		await waitFor(() => expect(screen.getByRole("button", { name: "合并" })).toBeEnabled());
		expect(screen.queryByText("尚未验证该仓库的写入权限。")).not.toBeInTheDocument();
	});

	it("disables write actions when the tested repository is read-only", async () => {
		mockProject("git@gitlab.example.com:group/app.git", {
			provider: "gitlab",
			connectionId: "gitlab-work",
			repo: "group/app",
		});
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		queryClient.setQueryData(["scm-capabilities", "gitlab-work", "group/app"], { read: true, write: false });
		setWorkspaces([session("auth", [gitlabPr(41, "open")])]);
		renderPage(queryClient);

		expect(
			await screen.findByText("This source control connection is read-only for this repository."),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Resolve" })).toBeDisabled();
	});

	it("enables write actions when the custom connection was tested with write access", async () => {
		sessionSummaries = [summary(41, "open", "gitlab")];
		mockProject("git@gitlab.example.com:group/app.git", {
			provider: "gitlab",
			connectionId: "gitlab-work",
			repo: "group/app",
		});
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		queryClient.setQueryData(["scm-capabilities", "gitlab-work", "group/app"], { read: true, write: true });
		setWorkspaces([session("auth", [gitlabPr(41, "open")])]);
		renderPage(queryClient);

		await waitFor(() => expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled());
		expect(screen.getByRole("button", { name: "Resolve" })).toBeEnabled();
		expect(screen.queryByText(/write access|read-only/i)).not.toBeInTheDocument();
	});
});
