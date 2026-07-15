import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineRunDetail } from "./PipelineRunDetail";
import type { PipelineArtifact, PipelineRunDetail as RunDetail } from "../hooks/usePipelineRuns";

const { usePipelineRunMock, postMock } = vi.hoisted(() => ({
	usePipelineRunMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("../hooks/usePipelineRuns", () => ({
	usePipelineRun: () => usePipelineRunMock(),
	pipelineRunQueryKey: (runId: string) => ["pipeline-run", runId],
}));
vi.mock("../lib/api-client", () => ({
	apiClient: { POST: (...args: unknown[]) => postMock(...args) },
	apiErrorMessage: (e: unknown) => (e instanceof Error ? e.message : "error"),
}));

type StageView = RunDetail["stages"][number];

function stage(overrides: Partial<StageView> & { stageName: string }): StageView {
	return {
		stageRunId: `sr-${overrides.stageName}`,
		status: "succeeded",
		attempt: 1,
		artifactIds: [],
		...overrides,
	};
}

function finding(overrides: Partial<PipelineArtifact> & { artifactId: string }): PipelineArtifact {
	return {
		kind: "finding",
		pipelineRunId: "run-1",
		stageRunId: "sr-1",
		stageName: "review",
		status: "open",
		createdAt: "2026-07-15T00:00:00Z",
		...overrides,
	};
}

function detail(overrides: Partial<RunDetail>): RunDetail {
	return {
		runId: "run-1",
		pipelineId: "def-1",
		pipelineName: "review",
		sessionId: "sess-1",
		loopState: "running",
		loopRounds: 2,
		headSha: "abcdef1234567890",
		stageCount: 1,
		stageStatuses: { review: "running" },
		hasOpenFindings: false,
		findings: [],
		stages: [],
		createdAt: "2026-07-15T00:00:00Z",
		updatedAt: "2026-07-15T00:00:00Z",
		...overrides,
	};
}

function setRun(run: RunDetail) {
	usePipelineRunMock.mockReturnValue({ data: run, isLoading: false, isError: false, error: null });
}

function renderDetail(project?: string) {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<PipelineRunDetail runId="run-1" project={project} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	usePipelineRunMock.mockReset();
	postMock.mockReset().mockResolvedValue({ error: undefined });
});

afterEach(() => vi.restoreAllMocks());

describe("PipelineRunDetail", () => {
	it("renders each stage with status, attempt, verdict, and error message", () => {
		setRun(
			detail({
				stages: [stage({ stageName: "lint", status: "failed", attempt: 2, verdict: "fail", errorMessage: "exit 1" })],
			}),
		);
		renderDetail("proj-1");

		const row = screen.getByText("lint").closest("[data-stage]") as HTMLElement;
		expect(within(row).getByText("failed")).toBeInTheDocument();
		expect(within(row).getByText("attempt 2")).toBeInTheDocument();
		expect(within(row).getByText("fail")).toBeInTheDocument();
		expect(within(row).getByText("exit 1")).toBeInTheDocument();
	});

	it("hides dismissed findings until the show-dismissed toggle is on", async () => {
		setRun(
			detail({
				findings: [
					finding({ artifactId: "f1", title: "Open bug", filePath: "a.ts", startLine: 10, severity: "high" }),
					finding({ artifactId: "f2", title: "Dismissed nit", status: "dismissed" }),
				],
			}),
		);
		renderDetail("proj-1");

		expect(screen.getByText("Open bug")).toBeInTheDocument();
		expect(screen.getByText("a.ts:10")).toBeInTheDocument();
		expect(screen.queryByText("Dismissed nit")).not.toBeInTheDocument();

		await userEvent.setup().click(screen.getByRole("switch"));
		expect(screen.getByText("Dismissed nit")).toBeInTheDocument();
	});

	it("cancels a running run with the run's project scope", async () => {
		setRun(detail({ loopState: "running" }));
		renderDetail("proj-7");

		await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/pipelines/runs/{runId}/cancel", {
			params: { path: { runId: "run-1" }, query: { project: "proj-7" } },
		});
	});

	it("offers Resume for a stalled run and not Cancel", () => {
		setRun(detail({ loopState: "stalled" }));
		renderDetail("proj-1");

		expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
	});

	it("disables the action when the run's project is unknown", () => {
		setRun(detail({ loopState: "running" }));
		renderDetail(undefined);

		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
	});
});
