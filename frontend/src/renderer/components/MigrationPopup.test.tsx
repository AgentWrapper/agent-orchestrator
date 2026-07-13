import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MigrationPopup } from "./MigrationPopup";

const { getMock, postMock, getMigration, setMigration } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
	getMigration: vi.fn(),
	setMigration: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock, POST: postMock },
	apiErrorMessage: (e: unknown, fb = "Request failed") =>
		e instanceof Error ? e.message : ((e as { message?: string })?.message ?? fb),
}));
vi.mock("../lib/bridge", () => ({ aoBridge: { appState: { getMigration, setMigration } } }));

function renderPopup() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MigrationPopup />
		</QueryClientProvider>,
	);
	return qc;
}

beforeEach(() => {
	getMock.mockReset();
	postMock.mockReset();
	getMigration.mockReset();
	setMigration.mockReset();
	getMigration.mockResolvedValue({ status: "pending" });
	getMock.mockResolvedValue({ data: { available: true, legacyRoot: "/home/u/.agent-orchestrator" }, error: undefined });
	postMock.mockResolvedValue({ data: { report: { projectsImported: 2, projectsSkipped: 1 } }, error: undefined });
	setMigration.mockResolvedValue(undefined);
});

describe("MigrationPopup", () => {
	it("shows when a legacy install is available and the marker is pending", async () => {
		renderPopup();
		expect(await screen.findByText(/Import projects from your earlier AO/i)).toBeInTheDocument();
		expect(screen.getByText("/home/u/.agent-orchestrator")).toBeInTheDocument();
	});

	it("renders nothing when the marker is declined", async () => {
		getMigration.mockResolvedValue({ status: "declined" });
		renderPopup();
		await waitFor(() => expect(getMigration).toHaveBeenCalled());
		expect(screen.queryByText(/Import projects from your earlier AO/i)).not.toBeInTheDocument();
		expect(getMock).not.toHaveBeenCalled();
	});

	it("Proceed imports, marks completed, and retires", async () => {
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Proceed" }));
		await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/import"));
		expect(setMigration).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
		await waitFor(() => expect(screen.queryByText(/Import projects from your earlier AO/i)).not.toBeInTheDocument());
	});

	it("Don't Migrate records declined", async () => {
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Don't Migrate" }));
		expect(setMigration).toHaveBeenCalledWith(expect.objectContaining({ status: "declined" }));
	});

	it("Skip dismisses without writing the marker", async () => {
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Skip" }));
		expect(setMigration).not.toHaveBeenCalled();
		expect(screen.queryByText(/Import projects from your earlier AO/i)).not.toBeInTheDocument();
	});

	// M11 (#293): a THROWN failure (fetch/IPC/query rejection) used to escape
	// `proceed` with no catch/finally, so busy stayed true forever: Proceed, Skip
	// and Don't Migrate all stayed disabled and the popup could never be dismissed
	// or retried. The rejection must be surfaced and busy always cleared.
	it("a rejected import surfaces the error and re-enables every action", async () => {
		postMock.mockRejectedValue(new Error("Failed to fetch"));
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Proceed" }));

		expect(await screen.findByText(/Failed to fetch/i)).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole("button", { name: /Retry/i })).toBeEnabled());
		expect(screen.getByRole("button", { name: "Skip" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Don't Migrate" })).toBeEnabled();
		expect(setMigration).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
	});

	// The same trap sits behind the post-success bookkeeping: a rejected IPC marker
	// write or query invalidation must not strand the popup in its busy state.
	it("a rejected marker write after a successful import still clears busy", async () => {
		setMigration.mockRejectedValue(new Error("app state is read-only"));
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Proceed" }));

		expect(await screen.findByText(/app state is read-only/i)).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole("button", { name: /Retry/i })).toBeEnabled());
	});

	it("a failed Don't Migrate surfaces the error instead of failing silently", async () => {
		setMigration.mockRejectedValue(new Error("marker write failed"));
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Don't Migrate" }));

		expect(await screen.findByText(/marker write failed/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Don't Migrate" })).toBeEnabled();
	});

	it("a failed import shows the lossless reassurance and marks failed", async () => {
		postMock.mockResolvedValue({ data: undefined, error: { message: "disk full" } });
		renderPopup();
		await screen.findByText(/Import projects from your earlier AO/i);
		await userEvent.click(screen.getByRole("button", { name: "Proceed" }));
		expect(await screen.findByText(/nothing is ever deleted/i)).toBeInTheDocument();
		expect(setMigration).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error: "disk full" }));
	});
});
