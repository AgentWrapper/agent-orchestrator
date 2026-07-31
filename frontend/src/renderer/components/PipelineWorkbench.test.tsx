import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineWorkbench } from "./PipelineWorkbench";
import type { PipelineRunSummary } from "../hooks/usePipelineRuns";

const { navigateMock, usePipelineRunsMock, useWorkspaceQueryMock, useDefinitionsMock, postMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
	usePipelineRunsMock: vi.fn(),
	useWorkspaceQueryMock: vi.fn(),
	useDefinitionsMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));
vi.mock("../hooks/usePipelineRuns", async () => {
	const actual = await vi.importActual<typeof import("../hooks/usePipelineRuns")>("../hooks/usePipelineRuns");
	return { ...actual, usePipelineRuns: () => usePipelineRunsMock() };
});
vi.mock("../hooks/useWorkspaceQuery", () => ({
	useWorkspaceQuery: () => useWorkspaceQueryMock(),
}));
vi.mock("../hooks/usePipelineDefinitions", () => ({
	usePipelineDefinitionsQuery: () => useDefinitionsMock(),
}));
vi.mock("../lib/api-client", () => ({
	apiClient: { POST: (...args: unknown[]) => postMock(...args) },
	apiErrorMessage: () => "cancel failed",
}));

function run(overrides: Partial<PipelineRunSummary> & { runId: string }): PipelineRunSummary {
	return {
		pipelineId: "def-1",
		pipelineName: "review",
		runNumber: 7,
		status: "running",
		subjectKind: "session",
		sessionId: "sess-1",
		headSha: "abcdef1234567890",
		stageCount: 2,
		stageOutcomes: { lint: "succeeded", test: "running" },
		createdAt: "2026-07-15T00:00:00Z",
		updatedAt: "2026-07-15T00:00:00Z",
		projectId: "proj-1",
		...overrides,
	};
}

function setRuns(runs: PipelineRunSummary[]) {
	usePipelineRunsMock.mockReturnValue({
		runs,
		isError: false,
		error: null,
		isLoading: false,
	});
}

function renderWorkbench(projectId?: string) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<PipelineWorkbench projectId={projectId} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	navigateMock.mockReset();
	usePipelineRunsMock.mockReset();
	postMock.mockReset();
	postMock.mockResolvedValue({ error: undefined });
	useDefinitionsMock.mockReturnValue({ data: [] });
	useWorkspaceQueryMock.mockReturnValue({
		data: [
			{
				id: "proj-1",
				sessions: [
					{
						id: "sess-1",
						title: "fix: preserve scratch workspaces",
						branch: "fix/scratch-retry",
					},
				],
			},
		],
	});
});

afterEach(() => vi.restoreAllMocks());

describe("PipelineWorkbench", () => {
	it("lists every run newest first, with the total count above the list", () => {
		setRuns([
			run({
				runId: "run-1111aaaa-0000",
				pipelineName: "review",
				createdAt: "2026-07-15T00:00:00Z",
			}),
			run({
				runId: "run-2222bbbb-0000",
				pipelineName: "audit",
				createdAt: "2026-07-16T00:00:00Z",
			}),
		]);
		renderWorkbench();

		expect(screen.getByText("2 pipeline runs")).toBeInTheDocument();
		const rows = screen.getAllByRole("listitem").filter((item) => item.dataset.runId);
		expect(rows.map((item) => item.dataset.runId)).toEqual(["run-2222bbbb-0000", "run-1111aaaa-0000"]);
	});

	it("renders the trigger sub-line, branch chip, and stacked time and duration", () => {
		setRuns([
			run({
				runId: "run-abc1234-0000",
				pipelineName: "review",
				subjectKind: "pr",
				prNumber: 3136,
				status: "succeeded",
				createdAt: "2026-07-15T00:00:00Z",
				settledAt: "2026-07-15T00:00:29Z",
			}),
		]);
		const { container } = renderWorkbench();

		const row = container.querySelector('[data-run-id="run-abc1234-0000"]') as HTMLElement;
		// Title falls back to the subject the session names, the way GitHub shows the PR title.
		expect(within(row).getByText("fix: preserve scratch workspaces")).toBeInTheDocument();
		expect(
			within(row).getByText("review #7: Pull request #3136 in session fix: preserve scratch workspaces"),
		).toBeInTheDocument();
		expect(within(row).getByText("fix/scratch-retry")).toBeInTheDocument();
		expect(within(row).getByText("29s")).toBeInTheDocument();
	});

	it("shows the daemon's run number, and keeps it when the list is filtered", async () => {
		setRuns([
			run({ runId: "run-1111aaaa-0000", pipelineName: "review", runNumber: 12 }),
			run({ runId: "run-2222bbbb-0000", pipelineName: "audit", runNumber: 3 }),
		]);
		renderWorkbench();
		const user = userEvent.setup();

		const list = screen.getByRole("list", { name: "Pipeline runs" });
		expect(within(list).getByText(/^review #12: /)).toBeInTheDocument();
		expect(within(list).getByText(/^audit #3: /)).toBeInTheDocument();

		// Numbering client-side would renumber these to #1 and #2 the moment a
		// filter hid one of them. The daemon's number does not move.
		await user.click(
			within(screen.getByRole("navigation", { name: "Pipelines" })).getByRole("button", { name: "audit" }),
		);
		expect(within(screen.getByRole("list", { name: "Pipeline runs" })).getByText(/^audit #3: /)).toBeInTheDocument();
	});

	it("falls back to the run id prefix for a run the daemon never numbered", () => {
		setRuns([run({ runId: "run-abc1234-0000", pipelineName: "review", runNumber: 0 })]);
		const { container } = renderWorkbench();

		const row = container.querySelector('[data-run-id="run-abc1234-0000"]') as HTMLElement;
		expect(within(row).getByText(/^review #abc1234: /)).toBeInTheDocument();
	});

	it("says what a live run is doing instead of showing a duration that never ticks", () => {
		setRuns([run({ runId: "run-live-0000", status: "running" })]);
		const { container } = renderWorkbench();

		const row = container.querySelector('[data-run-id="run-live-0000"]') as HTMLElement;
		expect(within(row).getByText("In progress")).toBeInTheDocument();
	});

	it("filters the list from the pipeline rail", async () => {
		setRuns([
			run({ runId: "run-1111aaaa-0000", pipelineName: "review" }),
			run({ runId: "run-2222bbbb-0000", pipelineName: "audit" }),
		]);
		renderWorkbench();
		const user = userEvent.setup();

		await user.click(
			within(screen.getByRole("navigation", { name: "Pipelines" })).getByRole("button", { name: "audit" }),
		);

		expect(screen.getByText("1 pipeline run")).toBeInTheDocument();
		const list = screen.getByRole("list", { name: "Pipeline runs" });
		expect(within(list).queryByText(/review #/)).not.toBeInTheDocument();
		expect(within(list).getByText(/audit #/)).toBeInTheDocument();
	});

	it("lists a definition with no runs in the rail, and shows an empty list for it", async () => {
		useDefinitionsMock.mockReturnValue({
			data: [{ id: "def-2", name: "nightly", projectId: "proj-1" }],
		});
		setRuns([run({ runId: "run-1111aaaa-0000", pipelineName: "review" })]);
		renderWorkbench("proj-1");
		const user = userEvent.setup();

		await user.click(
			within(screen.getByRole("navigation", { name: "Pipelines" })).getByRole("button", { name: "nightly" }),
		);

		expect(screen.getByText("0 pipeline runs")).toBeInTheDocument();
		expect(screen.getByText("No runs match these filters.")).toBeInTheDocument();
	});

	it("narrows on status through the filter row", async () => {
		setRuns([
			run({ runId: "run-1111aaaa-0000", status: "running" }),
			run({ runId: "run-2222bbbb-0000", status: "failed" }),
		]);
		renderWorkbench();
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: /^Status/ }));
		await user.click(await screen.findByRole("menuitem", { name: "Failure" }));

		expect(screen.getByText("1 pipeline run")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Status: Failure/ })).toBeInTheDocument();
	});

	it("cancels a live run from the row overflow menu", async () => {
		setRuns([run({ runId: "run-live-0000", status: "running", projectId: "proj-9" })]);
		renderWorkbench();
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: /^Actions for/ }));
		await user.click(await screen.findByRole("menuitem", { name: "Cancel run" }));

		expect(postMock).toHaveBeenCalledWith("/api/v1/pipelines/runs/{runId}/cancel", {
			params: {
				path: { runId: "run-live-0000" },
				query: { project: "proj-9" },
			},
		});
	});

	it("offers no cancel on a settled run", async () => {
		setRuns([run({ runId: "run-done-0000", status: "succeeded" })]);
		renderWorkbench();
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: /^Actions for/ }));

		expect(await screen.findByRole("menuitem", { name: "View run detail" })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Cancel run" })).not.toBeInTheDocument();
	});

	it("navigates to the run detail with the run's project on title click", async () => {
		setRuns([
			run({
				runId: "run-1111aaaa-0000",
				pipelineName: "review",
				sessionId: undefined,
				projectId: "proj-9",
			}),
		]);
		renderWorkbench();
		const user = userEvent.setup();

		const list = screen.getByRole("list", { name: "Pipeline runs" });
		await user.click(within(list).getByRole("button", { name: "review" }));

		expect(navigateMock).toHaveBeenCalledWith({
			to: "/pipelines/runs/$runId",
			params: { runId: "run-1111aaaa-0000" },
			search: { project: "proj-9" },
		});
	});

	it("shows an error state when runs fail to load", () => {
		usePipelineRunsMock.mockReturnValue({
			runs: [],
			isError: true,
			error: new Error("boom"),
			isLoading: false,
		});
		renderWorkbench();
		expect(screen.getByText(/Could not load pipeline runs: boom/)).toBeInTheDocument();
	});
});
