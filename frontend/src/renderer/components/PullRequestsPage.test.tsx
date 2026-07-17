import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, initializeRendererI18n } from "../i18n";
import { PullRequestsPage } from "./PullRequestsPage";
import type { PRState, PullRequestFacts, WorkspaceSession, WorkspaceSummary } from "../types/workspace";

const { navigateMock, postMock, useWorkspaceQueryMock } = vi.hoisted(() => ({
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
	apiClient: { POST: (...args: unknown[]) => postMock(...args) },
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

function renderPage() {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<PullRequestsPage />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	navigateMock.mockReset();
	postMock.mockReset().mockResolvedValue({ data: { method: "squash" }, error: undefined });
});

afterEach(() => vi.restoreAllMocks());

describe("PullRequestsPage", () => {
	it("renders one row per PR across sessions, actionable PRs first", () => {
		setWorkspaces([session("auth", [pr(41, "open"), pr(42, "draft"), pr(40, "merged")])]);
		renderPage();

		const rows = screen.getAllByRole("row").slice(1); // drop header
		const numbers = rows.map((r) => within(r).getByText(/^#\d+$/).textContent);
		expect(numbers).toEqual(["#41", "#42", "#40"]);
	});

	it("merges the PR by its own number, not the session's", async () => {
		setWorkspaces([session("auth", [pr(41, "open"), pr(42, "draft")])]);
		renderPage();
		const user = userEvent.setup();

		const childRow = screen.getByText("#42").closest("tr")!;
		await user.click(within(childRow).getByRole("button", { name: "Merge" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/prs/{id}/merge", { params: { path: { id: "42" } } });
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
		postMock.mockResolvedValueOnce({ data: undefined, error: {} });
		setWorkspaces([session("auth", [pr(41, "open")])]);
		renderPage();
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: "Merge" }));
		expect(await screen.findByText("merge failed")).toBeInTheDocument();

		await i18n.changeLanguage("zh-CN");
		expect(await screen.findByText("合并失败")).toBeInTheDocument();
	});
});
