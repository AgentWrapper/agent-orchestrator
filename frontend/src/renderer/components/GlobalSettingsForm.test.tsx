import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalSettingsForm } from "./GlobalSettingsForm";

const {
	getMock,
	postMock,
	getMigration,
	setMigration,
	getUpdate,
	setUpdate,
	updGetStatus,
	updCheck,
	updDownload,
	updInstall,
	updOnStatus,
	getVersion,
	featListBuilds,
	featGetActive,
} = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
	getMigration: vi.fn(),
	setMigration: vi.fn(),
	getUpdate: vi.fn(),
	setUpdate: vi.fn(),
	updGetStatus: vi.fn(),
	updCheck: vi.fn(),
	updDownload: vi.fn(),
	updInstall: vi.fn(),
	updOnStatus: vi.fn(),
	getVersion: vi.fn(),
	featListBuilds: vi.fn(),
	featGetActive: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock, POST: postMock },
	apiErrorMessage: (e: unknown, fb = "Request failed") =>
		e instanceof Error ? e.message : ((e as { message?: string })?.message ?? fb),
}));
vi.mock("../lib/bridge", () => ({
	aoBridge: {
		app: { getVersion },
		appState: { getMigration, setMigration },
		updateSettings: { get: getUpdate, set: setUpdate },
		updates: {
			getStatus: updGetStatus,
			check: updCheck,
			download: updDownload,
			install: updInstall,
			onStatus: updOnStatus,
		},
		featureBuilds: { list: featListBuilds, getActive: featGetActive },
	},
}));

function renderForm() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<GlobalSettingsForm />
		</QueryClientProvider>,
	);
	return qc;
}

beforeEach(() => {
	for (const m of [getMock, postMock, getMigration, setMigration, getUpdate, setUpdate, featListBuilds, featGetActive])
		m.mockReset();
	getMigration.mockResolvedValue({ status: "pending" });
	getMock.mockResolvedValue({ data: { available: true, legacyRoot: "/home/u/.agent-orchestrator" }, error: undefined });
	postMock.mockResolvedValue({ data: { report: { projectsImported: 2, projectsSkipped: 1 } }, error: undefined });
	setMigration.mockResolvedValue(undefined);
	getUpdate.mockResolvedValue({ enabled: true, channel: "latest", nightlyAck: false, feature: null });
	setUpdate.mockResolvedValue(undefined);
	updGetStatus.mockResolvedValue({ state: "idle" });
	updCheck.mockResolvedValue(undefined);
	updDownload.mockResolvedValue(undefined);
	updInstall.mockResolvedValue(undefined);
	updOnStatus.mockReturnValue(() => undefined);
	getVersion.mockResolvedValue("1.4.0");
	featListBuilds.mockResolvedValue([]);
	featGetActive.mockResolvedValue(null);
});

describe("GlobalSettingsForm", () => {
	it("renders the Updates and Migration sections", async () => {
		renderForm();
		expect(await screen.findByText("Updates")).toBeInTheDocument();
		expect(screen.getByText("Migration")).toBeInTheDocument();
	});

	it("shows the nightly warning and saves the loaded channel", async () => {
		getUpdate.mockResolvedValue({ enabled: true, channel: "nightly", nightlyAck: true, feature: null });
		renderForm();
		expect(await screen.findByText(/Nightly builds are cut every day/i)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await waitFor(() =>
			expect(setUpdate).toHaveBeenCalledWith(expect.objectContaining({ channel: "nightly", enabled: true })),
		);
	});

	it("hides the nightly warning on the stable channel", async () => {
		renderForm();
		await screen.findByText("Updates");
		expect(screen.queryByText(/Nightly builds are cut every day/i)).not.toBeInTheDocument();
	});

	it("shows migration status and the available legacy root", async () => {
		renderForm();
		expect(await screen.findByText("Not migrated yet")).toBeInTheDocument();
		expect(await screen.findByText("/home/u/.agent-orchestrator")).toBeInTheDocument();
	});

	it("Run migration imports and marks completed", async () => {
		renderForm();
		const btn = await screen.findByRole("button", { name: "Run migration" });
		await userEvent.click(btn);
		await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/import"));
		expect(setMigration).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
		expect(await screen.findByText("Migration complete.")).toBeInTheDocument();
	});

	it("lets a declined user re-run the migration", async () => {
		getMigration.mockResolvedValue({ status: "declined", lastAttemptAt: "2026-06-01T00:00:00.000Z" });
		renderForm();
		expect(await screen.findByText("Declined")).toBeInTheDocument();
		const btn = await screen.findByRole("button", { name: "Run migration" });
		expect(btn).toBeEnabled();
		await userEvent.click(btn);
		await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/import"));
	});

	it("disables Run when no legacy install is available", async () => {
		getMock.mockResolvedValue({ data: { available: false, legacyRoot: "" }, error: undefined });
		renderForm();
		expect(await screen.findByText("None found")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Run migration" })).toBeDisabled();
	});

	it("shows the current app version", async () => {
		renderForm();
		expect(await screen.findByText("v1.4.0")).toBeInTheDocument();
	});

	it("Check for updates triggers a manual check", async () => {
		renderForm();
		const btn = await screen.findByRole("button", { name: "Check for updates" });
		await userEvent.click(btn);
		expect(updCheck).toHaveBeenCalled();
	});

	it("offers an Update button when an update is available and downloads it", async () => {
		let emit: (s: { state: string; version?: string }) => void = () => undefined;
		updOnStatus.mockImplementation((cb: (s: unknown) => void) => {
			emit = cb as typeof emit;
			return () => undefined;
		});
		renderForm();
		await screen.findByRole("button", { name: "Check for updates" });
		act(() => emit({ state: "available", version: "1.2.3" }));
		const updateBtn = await screen.findByRole("button", { name: "Update to v1.2.3" });
		await userEvent.click(updateBtn);
		expect(updDownload).toHaveBeenCalled();
	});

	it("offers Restart & install once downloaded and installs it", async () => {
		let emit: (s: { state: string; version?: string }) => void = () => undefined;
		updOnStatus.mockImplementation((cb: (s: unknown) => void) => {
			emit = cb as typeof emit;
			return () => undefined;
		});
		renderForm();
		await screen.findByRole("button", { name: "Check for updates" });
		act(() => emit({ state: "downloaded", version: "1.2.3" }));
		const installBtn = await screen.findByRole("button", { name: /Restart & install/ });
		await userEvent.click(installBtn);
		expect(updInstall).toHaveBeenCalled();
	});

	it("a failed import surfaces the error and marks failed", async () => {
		postMock.mockResolvedValue({ data: undefined, error: { message: "disk full" } });
		renderForm();
		const btn = await screen.findByRole("button", { name: "Run migration" });
		await userEvent.click(btn);
		expect(await screen.findByText(/disk full/i)).toBeInTheDocument();
		expect(setMigration).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error: "disk full" }));
	});

	it("reveals the feature-build picker when Feature Releases is selected", async () => {
		renderForm();
		await screen.findByText("Updates");
		// The picker must be reachable from a clean state (no pin seeded).
		await userEvent.click(screen.getByLabelText("Update channel"));
		await userEvent.click(await screen.findByRole("option", { name: "Feature Releases" }));
		// Secondary picker mounts; no live builds are mocked, so it shows the empty state.
		expect(await screen.findByText("No live feature releases.")).toBeInTheDocument();
		expect(featListBuilds).toHaveBeenCalled();
	});

	it("pins a feature build after confirming, then auto-progresses check -> download -> install", async () => {
		featListBuilds.mockResolvedValue([
			{
				pr: 2270,
				title: "Fix foo",
				base: "0.2.0",
				sha: "abc",
				slug: "x",
				buildId: "v0.2.0-pr2270.202607061200",
				publishedAt: new Date().toISOString(),
			},
		]);
		let emit: (s: { state: string; version?: string }) => void = () => undefined;
		updOnStatus.mockImplementation((cb: (s: unknown) => void) => {
			emit = cb as typeof emit;
			return () => undefined;
		});
		renderForm();
		await screen.findByText("Updates");

		await userEvent.click(screen.getByLabelText("Update channel"));
		await userEvent.click(await screen.findByRole("option", { name: "Feature Releases" }));

		await userEvent.click(await screen.findByLabelText("Feature build"));
		await userEvent.click(await screen.findByRole("option", { name: /PR #2270: Fix foo/ }));

		// Confirmation dialog replaces window.confirm.
		await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));

		await waitFor(() => expect(setUpdate).toHaveBeenCalledWith(expect.objectContaining({ feature: { pr: 2270 } })));
		expect(updCheck).toHaveBeenCalled();

		// Auto-progression: available -> download(), downloaded -> install().
		act(() => emit({ state: "available", version: "1.2.3" }));
		await waitFor(() => expect(updDownload).toHaveBeenCalled());
		act(() => emit({ state: "downloaded", version: "1.2.3" }));
		await waitFor(() => expect(updInstall).toHaveBeenCalled());
	});

	it("returns to Stable, then auto-progresses check -> download -> install", async () => {
		getUpdate.mockResolvedValue({ enabled: true, channel: "latest", nightlyAck: false, feature: { pr: 2270 } });
		featGetActive.mockResolvedValue({ pr: 2270 });
		let emit: (s: { state: string; version?: string }) => void = () => undefined;
		updOnStatus.mockImplementation((cb: (s: unknown) => void) => {
			emit = cb as typeof emit;
			return () => undefined;
		});
		renderForm();

		const returnBtn = await screen.findByRole("button", { name: "Return to Stable" });
		await userEvent.click(returnBtn);

		await waitFor(() => expect(setUpdate).toHaveBeenCalledWith(expect.objectContaining({ feature: null })));
		expect(updCheck).toHaveBeenCalled();

		act(() => emit({ state: "available", version: "1.3.0" }));
		await waitFor(() => expect(updDownload).toHaveBeenCalled());
		act(() => emit({ state: "downloaded", version: "1.3.0" }));
		await waitFor(() => expect(updInstall).toHaveBeenCalled());
	});
});
