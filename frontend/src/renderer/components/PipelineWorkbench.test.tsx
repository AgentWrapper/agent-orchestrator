import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineWorkbench } from "./PipelineWorkbench";
import type { PipelineRunSummary } from "../hooks/usePipelineRuns";

const { navigateMock, usePipelineRunsMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
	usePipelineRunsMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));
vi.mock("../hooks/usePipelineRuns", () => ({ usePipelineRuns: () => usePipelineRunsMock() }));

function run(overrides: Partial<PipelineRunSummary> & { runId: string }): PipelineRunSummary {
	return {
		pipelineId: "def-1",
		pipelineName: "review",
		sessionId: "sess-1",
		loopState: "running",
		loopRounds: 1,
		headSha: "abcdef1234567890",
		stageCount: 2,
		stageStatuses: { lint: "succeeded", test: "running" },
		hasOpenFindings: false,
		createdAt: "2026-07-15T00:00:00Z",
		updatedAt: "2026-07-15T00:00:00Z",
		projectId: "proj-1",
		...overrides,
	};
}

function setRuns(runs: PipelineRunSummary[]) {
	usePipelineRunsMock.mockReturnValue({ runs, isError: false, error: null, isLoading: false });
}

beforeEach(() => {
	navigateMock.mockReset();
	usePipelineRunsMock.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("PipelineWorkbench", () => {
	it("groups runs into the five loopState columns", () => {
		setRuns([
			run({ runId: "r1", pipelineName: "review", loopState: "running" }),
			run({ runId: "r2", pipelineName: "audit", loopState: "done" }),
			run({ runId: "r3", pipelineName: "audit", loopState: "stalled" }),
		]);
		render(<PipelineWorkbench />);

		expect(within(screen.getByLabelText("Running column")).getByText("review")).toBeInTheDocument();
		expect(within(screen.getByLabelText("Done column")).getByText("audit")).toBeInTheDocument();
		expect(within(screen.getByLabelText("Stalled column")).getByText("audit")).toBeInTheDocument();
		// Empty columns render the placeholder.
		expect(within(screen.getByLabelText("Terminated column")).getByText("Empty")).toBeInTheDocument();
	});

	it("renders card fields: pipeline name, rounds, and stage count", () => {
		setRuns([run({ runId: "r1", pipelineName: "review", loopRounds: 3, stageCount: 2 })]);
		const { container } = render(<PipelineWorkbench />);

		const card = container.querySelector('[data-run-id="r1"]') as HTMLElement;
		expect(within(card).getByText("review")).toBeInTheDocument();
		expect(within(card).getByText("rounds 3")).toBeInTheDocument();
		expect(within(card).getByText("2 stages")).toBeInTheDocument();
	});

	it("filters the board to the selected pipeline names", async () => {
		setRuns([
			run({ runId: "r1", pipelineName: "review", loopState: "running" }),
			run({ runId: "r2", pipelineName: "audit", loopState: "running" }),
		]);
		render(<PipelineWorkbench />);
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: "review", pressed: false }));

		const running = screen.getByLabelText("Running column");
		expect(within(running).getByText("review")).toBeInTheDocument();
		expect(within(running).queryByText("audit")).not.toBeInTheDocument();
	});

	it("navigates to the run detail with the run's project on card click", async () => {
		setRuns([run({ runId: "r1", pipelineName: "review", projectId: "proj-9" })]);
		const { container } = render(<PipelineWorkbench />);
		const user = userEvent.setup();

		await user.click(container.querySelector('[data-run-id="r1"]') as HTMLElement);

		expect(navigateMock).toHaveBeenCalledWith({
			to: "/pipelines/runs/$runId",
			params: { runId: "r1" },
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
		render(<PipelineWorkbench />);
		expect(screen.getByText(/Could not load pipeline runs: boom/)).toBeInTheDocument();
	});
});
