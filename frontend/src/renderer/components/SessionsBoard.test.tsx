import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";

const { navigateMock, workspaceQueryMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
	workspaceQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
}));

vi.mock("../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: workspaceQueryMock,
}));

import { SessionsBoard } from "./SessionsBoard";

function renderBoard(projectId?: string) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={queryClient}>
			<SessionsBoard projectId={projectId} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	navigateMock.mockReset();
	workspaceQueryMock.mockReset().mockReturnValue({ data: [], isError: false });
});

describe("SessionsBoard", () => {
	it("does not show an agent setup warning on the board", () => {
		renderBoard();

		expect(screen.queryByText(/reload agents/i)).not.toBeInTheDocument();
	});

	it("labels an idle session as Idle, not Working", () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "p1",
					name: "radic",
					path: "/tmp/radic",
					sessions: [
						{
							id: "s1",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "brand-font-pipeline",
							provider: "claude-code",
							branch: "ao/radic-5",
							status: "idle",
							activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
					],
				},
			],
			isError: false,
		});

		renderBoard("p1");

		expect(screen.getByText("Idle")).toBeInTheDocument();
	});

	it("localizes board state without hiding distinct Chinese branch and title values", async () => {
		await i18n.changeLanguage("zh-CN");
		workspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "p1",
					name: "radic",
					path: "/tmp/radic",
					sessions: [
						{
							id: "s1",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "修复登录流程",
							provider: "claude-code",
							branch: "功能/登录保护",
							status: "idle",
							activity: { state: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
					],
				},
			],
			isError: false,
		});

		renderBoard("p1");

		expect(screen.getByText("空闲")).toBeInTheDocument();
		expect(screen.getByText("工作中")).toBeInTheDocument();
		expect(screen.getByText("修复登录流程")).toBeInTheDocument();
		expect(screen.getByText("功能/登录保护")).toBeInTheDocument();
	});

	it("shows distinct symbol-only branches but hides an exactly matching one", () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "p1",
					name: "radic",
					path: "/tmp/radic",
					sessions: [
						{
							id: "s-distinct",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "!!!",
							provider: "claude-code",
							branch: "???",
							status: "working",
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
						{
							id: "s-exact",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "@@@",
							provider: "claude-code",
							branch: "@@@",
							status: "working",
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [],
						},
					],
				},
			],
			isError: false,
		});

		renderBoard("p1");

		expect(screen.getByText("!!!")).toBeInTheDocument();
		expect(screen.getByText("???")).toBeInTheDocument();
		expect(screen.getAllByText("@@@")).toHaveLength(1);
	});

	it("formats mixed GitHub and GitLab numbers with provider-specific punctuation", async () => {
		workspaceQueryMock.mockReturnValue({
			data: [
				{
					id: "p1",
					name: "radic",
					path: "/tmp/radic",
					sessions: [
						{
							id: "s1",
							workspaceId: "p1",
							workspaceName: "radic",
							title: "mixed changes",
							provider: "claude-code",
							branch: "feat/mixed",
							status: "pr_open",
							updatedAt: "2026-01-01T00:00:00Z",
							prs: [
								{
									url: "https://github.com/acme/app/pull/7",
									number: 7,
									state: "open",
									ci: "passing",
									review: "approved",
									mergeability: "mergeable",
									reviewComments: false,
									updatedAt: "2026-01-01T00:00:00Z",
								},
								{
									url: "https://gitlab.example.com/acme/app/-/merge_requests/8",
									number: 8,
									state: "open",
									ci: "passing",
									review: "approved",
									mergeability: "mergeable",
									reviewComments: false,
									updatedAt: "2026-01-01T00:00:00Z",
								},
							],
						},
					],
				},
			],
			isError: false,
		});

		renderBoard("p1");

		expect(await screen.findByText("#7")).toBeInTheDocument();
		expect(screen.getByText("!8")).toBeInTheDocument();
	});
});
