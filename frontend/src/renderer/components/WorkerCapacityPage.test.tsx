import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerCapacityPage } from "./WorkerCapacityPage";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import type { WorkspaceSummary } from "../types/workspace";

const { getMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock },
	apiErrorMessage: (error: unknown) => {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error) {
			return String((error as { message: unknown }).message);
		}
		return "Request failed";
	},
}));

const workspace: WorkspaceSummary = {
	id: "ao",
	name: "Agent Orchestrator",
	path: "/repo/ao",
	sessions: [],
};

function renderPage() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	queryClient.setQueryData(workspaceQueryKey, [workspace]);
	render(
		<QueryClientProvider client={queryClient}>
			<WorkerCapacityPage projectId="ao" />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	getMock.mockReset();
});

describe("WorkerCapacityPage", () => {
	it("renders degraded allocation and health details", async () => {
		getMock.mockResolvedValue({
			response: { status: 200 },
			error: undefined,
			data: {
				capacity: {
					projectId: "ao",
					cap: 10,
					activeWorkers: 3,
					downBucketShare: 3,
					availableCapacity: 7,
					freeAvailableCapacity: 4,
					state: "degraded",
					checkedAt: "2026-07-08T12:00:00Z",
					buckets: [
						{
							agent: "codex",
							targetPercent: 70,
							activeWorkers: 2,
							realizedPercent: 66.7,
							health: "healthy",
							down: false,
						},
						{
							agent: "claude-code",
							model: "claude-opus-4-8",
							targetPercent: 30,
							activeWorkers: 1,
							realizedPercent: 33.3,
							health: "unauthorized",
							down: true,
							downCapacityShare: 3,
							reason: "not authenticated",
							remedy: "run `claude`",
						},
					],
					harnesses: [
						{ id: "codex", label: "Codex", health: "healthy" },
						{
							id: "claude-code",
							label: "Claude Code",
							health: "unauthorized",
							reason: "not authenticated",
							remedy: "run `claude`",
						},
					],
				},
			},
		});

		renderPage();

		expect(await screen.findByRole("heading", { name: "Capacity" })).toBeInTheDocument();
		expect(screen.getByText("/repo/ao")).toBeInTheDocument();
		expect(await screen.findByText("Degraded")).toBeInTheDocument();
		expect(screen.getByText("claude-code · claude-opus-4-8")).toBeInTheDocument();
		expect(screen.getByText("33.3%")).toBeInTheDocument();
		expect(screen.getByText("not authenticated")).toBeInTheDocument();
		expect(screen.getByText("run `claude`")).toBeInTheDocument();

		const allocation = screen.getByRole("heading", { name: "Allocation" }).closest("section");
		expect(allocation).not.toBeNull();
		expect(within(allocation!).getByText("3")).toBeInTheDocument();
	});

	it("renders unavailable state for an unwired endpoint", async () => {
		getMock.mockResolvedValue({
			response: { status: 501 },
			error: { message: "unavailable" },
			data: undefined,
		});

		renderPage();

		expect(await screen.findByText("Capacity is unavailable.")).toBeInTheDocument();
	});
});
