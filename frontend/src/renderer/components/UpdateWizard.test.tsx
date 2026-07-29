import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateWizard } from "./UpdateWizard";

const { hasDecision, setSettings } = vi.hoisted(() => ({
	hasDecision: vi.fn(),
	setSettings: vi.fn(),
}));

vi.mock("../lib/bridge", () => ({
	isTauri: true,
	aoBridge: { updateSettings: { hasDecision, set: setSettings } },
}));

// The wizard only opens in packaged builds (import.meta.env.PROD); vitest's
// own MODE defaults to "test", so this module is stubbed to simulate a
// packaged build for these tests.
vi.mock("../lib/build-env", () => ({
	isProdBuild: () => true,
}));

function renderWizard() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<UpdateWizard />
		</QueryClientProvider>,
	);
	return qc;
}

beforeEach(() => {
	hasDecision.mockReset();
	setSettings.mockReset();
	setSettings.mockResolvedValue(undefined);
});

describe("UpdateWizard", () => {
	it("renders nothing when a decision has already been made", async () => {
		hasDecision.mockResolvedValue(true);
		renderWizard();
		await vi.waitFor(() => expect(hasDecision).toHaveBeenCalled());
		expect(screen.queryByText(/Keep Agent Orchestrator up to date/i)).not.toBeInTheDocument();
	});

	it("shows the opt-in step on first run", async () => {
		hasDecision.mockResolvedValue(false);
		renderWizard();
		expect(await screen.findByText(/Keep Agent Orchestrator up to date automatically\?/i)).toBeInTheDocument();
	});

	it("Not now persists disabled settings", async () => {
		hasDecision.mockResolvedValue(false);
		renderWizard();
		await screen.findByText(/Keep Agent Orchestrator up to date automatically\?/i);
		await userEvent.click(screen.getByRole("button", { name: "Not now" }));
		expect(setSettings).toHaveBeenCalledWith({ enabled: false, channel: "latest", nightlyAck: false, feature: null });
	});

	it("walks Enable -> Stable to persist the stable channel", async () => {
		hasDecision.mockResolvedValue(false);
		renderWizard();
		await screen.findByText(/Keep Agent Orchestrator up to date automatically\?/i);
		await userEvent.click(screen.getByRole("button", { name: "Enable auto-updates" }));
		expect(await screen.findByText(/Which update channel\?/i)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Stable" }));
		expect(setSettings).toHaveBeenCalledWith({ enabled: true, channel: "latest", nightlyAck: false, feature: null });
	});

	it("walks Enable -> Nightly -> ack to persist the nightly channel", async () => {
		hasDecision.mockResolvedValue(false);
		renderWizard();
		await screen.findByText(/Keep Agent Orchestrator up to date automatically\?/i);
		await userEvent.click(screen.getByRole("button", { name: "Enable auto-updates" }));
		await userEvent.click(await screen.findByRole("button", { name: "Nightly" }));
		expect(await screen.findByText(/Nightly builds can be unstable/i)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "I understand, use Nightly" }));
		expect(setSettings).toHaveBeenCalledWith({ enabled: true, channel: "nightly", nightlyAck: true, feature: null });
	});

	it("walks Enable -> Nightly -> Use Stable instead to fall back to stable", async () => {
		hasDecision.mockResolvedValue(false);
		renderWizard();
		await screen.findByText(/Keep Agent Orchestrator up to date automatically\?/i);
		await userEvent.click(screen.getByRole("button", { name: "Enable auto-updates" }));
		await userEvent.click(await screen.findByRole("button", { name: "Nightly" }));
		await screen.findByText(/Nightly builds can be unstable/i);
		await userEvent.click(screen.getByRole("button", { name: "Use Stable instead" }));
		expect(setSettings).toHaveBeenCalledWith({ enabled: true, channel: "latest", nightlyAck: false, feature: null });
	});
});
