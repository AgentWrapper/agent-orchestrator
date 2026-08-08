import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrerequisiteBanner } from "./PrerequisiteBanner";

const { getMock, postMock, writeText } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
	writeText: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock, POST: postMock },
	apiErrorMessage: (e: unknown, fb = "Request failed") => (e as { message?: string })?.message ?? fb,
}));
vi.mock("../lib/bridge", () => ({ aoBridge: { clipboard: { writeText } } }));

function renderBanner() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<PrerequisiteBanner />
		</QueryClientProvider>,
	);
	return qc;
}

const missingOnMac = { tmux: { name: "tmux", satisfied: false, installCommand: "brew install tmux", installable: true } };
const missingOnLinux = {
	tmux: { name: "tmux", satisfied: false, installCommand: "sudo apt-get install -y tmux", installable: false },
};

beforeEach(() => {
	getMock.mockReset();
	postMock.mockReset();
	writeText.mockReset();
	writeText.mockResolvedValue(undefined);
});

describe("PrerequisiteBanner", () => {
	it("stays out of the way when tmux is present", async () => {
		getMock.mockResolvedValue({ data: { tmux: { name: "tmux", satisfied: true, installable: false } }, error: undefined });
		renderBanner();
		await waitFor(() => expect(getMock).toHaveBeenCalled());
		expect(screen.queryByTestId("prerequisite-banner")).not.toBeInTheDocument();
	});

	// A daemon we cannot reach is not evidence that tmux is missing.
	it("stays out of the way when the daemon cannot answer", async () => {
		getMock.mockResolvedValue({ data: undefined, error: { message: "daemon unreachable" } });
		renderBanner();
		await waitFor(() => expect(getMock).toHaveBeenCalled());
		expect(screen.queryByTestId("prerequisite-banner")).not.toBeInTheDocument();
	});

	it("offers to install when the app can run the command itself", async () => {
		getMock.mockResolvedValue({ data: missingOnMac, error: undefined });
		postMock.mockResolvedValue({ data: { prerequisite: { name: "tmux", satisfied: true } }, error: undefined });
		renderBanner();

		expect(await screen.findByTestId("prerequisite-banner")).toBeInTheDocument();
		expect(screen.getByText("brew install tmux")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Install tmux" }));
		await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/prerequisites/tmux/install"));
	});

	// The app has no terminal to answer a sudo prompt on, so it must not pretend
	// it can install: the command is there to copy and run.
	it("offers the command to copy when it cannot run it", async () => {
		getMock.mockResolvedValue({ data: missingOnLinux, error: undefined });
		renderBanner();

		await screen.findByTestId("prerequisite-banner");
		expect(screen.queryByRole("button", { name: "Install tmux" })).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Copy command" }));
		expect(writeText).toHaveBeenCalledWith("sudo apt-get install -y tmux");
		expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
	});

	it("shows why an install failed", async () => {
		getMock.mockResolvedValue({ data: missingOnMac, error: undefined });
		postMock.mockResolvedValue({ data: undefined, error: { message: "No available formula" } });
		renderBanner();

		await screen.findByTestId("prerequisite-banner");
		await userEvent.click(screen.getByRole("button", { name: "Install tmux" }));
		expect(await screen.findByText(/No available formula/)).toBeInTheDocument();
	});

	// After a manual install the user needs a way to clear the banner without
	// restarting the app.
	it("re-checks on demand", async () => {
		getMock.mockResolvedValue({ data: missingOnLinux, error: undefined });
		renderBanner();

		await screen.findByTestId("prerequisite-banner");
		getMock.mockResolvedValue({ data: { tmux: { name: "tmux", satisfied: true, installable: false } }, error: undefined });
		await userEvent.click(screen.getByRole("button", { name: "Check again" }));
		await waitFor(() => expect(screen.queryByTestId("prerequisite-banner")).not.toBeInTheDocument());
	});
});
