import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// Drives the real useWorkspaceQuery + real Board / PR-page consumers end to end
// for a normal project, mocking only the HTTP client and the router. Proves PR
// facts carried on the session list flow through the shared workspace cache into
// every consumer.
const { getMock, navigateMock } = vi.hoisted(() => ({ getMock: vi.fn(), navigateMock: vi.fn() }));

vi.mock("../../lib/api-client", () => ({
	apiClient: { GET: getMock, POST: vi.fn() },
	apiErrorMessage: (e: unknown) => (e instanceof Error ? e.message : "error"),
	hasTrustedApiBaseUrl: () => true,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return { ...actual, useNavigate: () => navigateMock };
});

import { SessionsBoard } from "../../components/SessionsBoard";
import { PullRequestsPage } from "../../components/PullRequestsPage";

// One ordinary project with one worker session that has multiple PRs.
function respondWithProjectAndPRs() {
	getMock.mockImplementation(async (url: string) => {
		if (url === "/api/v1/projects") {
			return { data: { projects: [{ id: "proj-1", name: "my-app", path: "/repo/my-app" }] }, error: undefined };
		}
		if (url === "/api/v1/sessions") {
			return {
				data: {
					sessions: [
						{
							id: "sess-1",
							projectId: "proj-1",
							displayName: "fix the bug",
							harness: "claude-code",
							status: "pr_open",
							isTerminated: false,
							updatedAt: "2026-06-10T16:15:04Z",
							prs: [
								{
									number: 278,
									state: "open",
									url: "https://github.com/aoagents/ReverbCode/pull/278",
									ci: "passing",
									review: "approved",
									mergeability: "clean",
									reviewComments: false,
									updatedAt: "2026-06-10T16:15:04Z",
								},
								{
									number: 279,
									state: "draft",
									url: "https://github.com/aoagents/ReverbCode/pull/279",
									ci: "pending",
									review: "pending",
									mergeability: "unknown",
									reviewComments: false,
									updatedAt: "2026-06-10T16:20:04Z",
								},
							],
						},
					],
				},
				error: undefined,
			};
		}
		throw new Error(`unexpected GET ${url}`);
	});
}

function respondWithAttentionPR() {
	getMock.mockImplementation(async (url: string) => {
		if (url === "/api/v1/projects") {
			return { data: { projects: [{ id: "proj-1", name: "my-app", path: "/repo/my-app" }] }, error: undefined };
		}
		if (url === "/api/v1/sessions/sess-1/pr") {
			return {
				data: {
					sessionId: "sess-1",
					prs: [
						{
							url: "https://github.com/aoagents/ReverbCode/pull/278",
							htmlUrl: "https://github.com/aoagents/ReverbCode/pull/278",
							number: 278,
							title: "fix the bug",
							state: "open",
							provider: "github",
							repo: "aoagents/ReverbCode",
							author: "worker",
							sourceBranch: "fix/bug",
							targetBranch: "main",
							headSha: "abc123",
							additions: 1,
							deletions: 1,
							changedFiles: 1,
							ci: { state: "passing", failingChecks: [] },
							review: {
								decision: "changes_requested",
								hasUnresolvedHumanComments: true,
								unresolvedBy: [
									{
										reviewerId: "reviewer-a",
										count: 1,
										reviewUrl: "https://github.com/aoagents/ReverbCode/pull/278#pullrequestreview-1",
										links: [
											{
												url: "https://github.com/aoagents/ReverbCode/pull/278#discussion_r1",
												file: "main.go",
												line: 12,
											},
										],
									},
								],
							},
							mergeability: {
								state: "conflicting",
								reasons: ["conflicts"],
								prUrl: "https://github.com/aoagents/ReverbCode/pull/278",
								conflictFiles: [],
							},
							updatedAt: "2026-06-10T16:15:04Z",
							observedAt: "2026-06-10T16:15:04Z",
							ciObservedAt: "2026-06-10T16:15:04Z",
							reviewObservedAt: "2026-06-10T16:15:04Z",
						},
					],
				},
				error: undefined,
			};
		}
		if (url === "/api/v1/sessions") {
			return {
				data: {
					sessions: [
						{
							id: "sess-1",
							projectId: "proj-1",
							displayName: "fix the bug",
							harness: "claude-code",
							status: "changes_requested",
							isTerminated: false,
							updatedAt: "2026-06-10T16:15:04Z",
							prs: [
								{
									number: 278,
									state: "open",
									url: "https://github.com/aoagents/ReverbCode/pull/278",
									ci: "passing",
									review: "changes_requested",
									mergeability: "conflicting",
									reviewComments: true,
									updatedAt: "2026-06-10T16:15:04Z",
								},
							],
						},
					],
				},
				error: undefined,
			};
		}
		throw new Error(`unexpected GET ${url}`);
	});
}

function renderWithProviders(node: ReactNode) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

beforeEach(() => {
	getMock.mockReset();
	navigateMock.mockReset();
	respondWithProjectAndPRs();
});

describe("PR hydration for a normal project (#251)", () => {
	it("renders every session PR on the Board card instead of 'no PR yet'", async () => {
		renderWithProviders(<SessionsBoard />);

		expect(await screen.findByText("PR #278 · open")).toBeInTheDocument();
		expect(screen.getByText("PR #279 · draft")).toBeInTheDocument();
		expect(screen.queryByText("no PR yet")).not.toBeInTheDocument();
	});

	it("links Board attention states to PR fallback and merge conflict targets", async () => {
		respondWithAttentionPR();
		renderWithProviders(<SessionsBoard />);

		expect(await screen.findByRole("link", { name: "PR" })).toHaveAttribute(
			"href",
			"https://github.com/aoagents/ReverbCode/pull/278",
		);
		expect(screen.getByRole("link", { name: "conflicts" })).toHaveAttribute(
			"href",
			"https://github.com/aoagents/ReverbCode/pull/278/conflicts",
		);
	});

	it("lists every session PR on the PR page instead of being empty", async () => {
		renderWithProviders(<PullRequestsPage />);

		expect(await screen.findByText("#278")).toBeInTheDocument();
		expect(screen.getByText("#279")).toBeInTheDocument();
		expect(screen.queryByText("No open pull requests.")).not.toBeInTheDocument();
		expect(screen.getAllByText("fix the bug")).toHaveLength(2);
	});
});
