import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetPauseSection } from "./FleetPauseSection";

const { getFleetPaused, pauseFleet, resumeFleet, useWorkspaceQuery } = vi.hoisted(() => ({
	getFleetPaused: vi.fn(),
	pauseFleet: vi.fn(),
	resumeFleet: vi.fn(),
	useWorkspaceQuery: vi.fn(() => ({
		data: [] as Array<{ id: string; pauseState?: string; drainingWorkers?: number }>,
	})),
}));

vi.mock("../lib/pause-fleet", () => ({ getFleetPaused, pauseFleet, resumeFleet }));
vi.mock("../hooks/useWorkspaceQuery", () => ({ useWorkspaceQuery, workspaceQueryKey: ["workspaces"] }));

function renderSection() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<FleetPauseSection />
		</QueryClientProvider>,
	);
}

describe("FleetPauseSection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useWorkspaceQuery.mockReturnValue({ data: [] });
	});
	afterEach(() => vi.restoreAllMocks());

	it("shows Running with a Pause control and pauses the fleet", async () => {
		getFleetPaused.mockResolvedValue(false);
		pauseFleet.mockResolvedValue(true);
		renderSection();

		await waitFor(() => expect(screen.getByText("Running")).toBeInTheDocument());
		await userEvent.click(screen.getByRole("button", { name: "Pause fleet" }));
		expect(pauseFleet).toHaveBeenCalledWith(undefined);
	});

	it("confirms before a hard fleet pause and forwards hard=true", async () => {
		getFleetPaused.mockResolvedValue(false);
		pauseFleet.mockResolvedValue(true);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		renderSection();

		await waitFor(() => expect(screen.getByText("Running")).toBeInTheDocument());
		await userEvent.click(screen.getByRole("button", { name: "Pause now (hard)" }));
		expect(confirm).toHaveBeenCalledOnce();
		expect(pauseFleet).toHaveBeenCalledWith(true);
	});

	it("does NOT hard-pause when the confirmation is declined", async () => {
		getFleetPaused.mockResolvedValue(false);
		vi.spyOn(window, "confirm").mockReturnValue(false);
		renderSection();

		await waitFor(() => expect(screen.getByText("Running")).toBeInTheDocument());
		await userEvent.click(screen.getByRole("button", { name: "Pause now (hard)" }));
		expect(pauseFleet).not.toHaveBeenCalled();
	});

	it("shows Paused with a Resume control and resumes the fleet", async () => {
		getFleetPaused.mockResolvedValue(true);
		resumeFleet.mockResolvedValue(false);
		renderSection();

		await waitFor(() => expect(screen.getByText("Paused")).toBeInTheDocument());
		await userEvent.click(screen.getByRole("button", { name: "Resume fleet" }));
		expect(resumeFleet).toHaveBeenCalled();
	});

	it("surfaces the draining lifecycle (count) while paused workers finish", async () => {
		getFleetPaused.mockResolvedValue(true);
		useWorkspaceQuery.mockReturnValue({
			data: [
				{ id: "a", pauseState: "draining", drainingWorkers: 2 },
				{ id: "b", pauseState: "draining", drainingWorkers: 1 },
				{ id: "c", pauseState: "paused", drainingWorkers: 0 },
			],
		});
		renderSection();
		await waitFor(() => expect(screen.getByText("Draining (3)")).toBeInTheDocument());
		expect(screen.queryByText("Paused")).not.toBeInTheDocument();
	});

	it("keeps hard-pause available while paused so a drain can be escalated", async () => {
		getFleetPaused.mockResolvedValue(true);
		pauseFleet.mockResolvedValue(true);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		renderSection();

		await waitFor(() => expect(screen.getByText("Paused")).toBeInTheDocument());
		// Both Resume and the emergency hard-pause are offered while paused.
		expect(screen.getByRole("button", { name: "Resume fleet" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Pause now (hard)" }));
		expect(confirm).toHaveBeenCalledOnce();
		expect(pauseFleet).toHaveBeenCalledWith(true);
	});

	it("renders an unavailable state (not Running) when status can't be loaded", async () => {
		getFleetPaused.mockRejectedValue(new Error("daemon down"));
		renderSection();

		await waitFor(() => expect(screen.getByText("Unavailable")).toBeInTheDocument());
		// Must NOT fall back to Running with pause controls when status is unknown.
		expect(screen.queryByText("Running")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Pause fleet" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Resume fleet" })).not.toBeInTheDocument();
	});
});
