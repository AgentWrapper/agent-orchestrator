import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalSettingsForm } from "./GlobalSettingsForm";

const {
	getUpdate,
	setUpdate,
	updGetStatus,
	updCheck,
	updDownload,
	updInstall,
	updOnStatus,
	getVersion,
	getDaemonStatus,
	navigateMock,
	writeText,
	openExternal,
	featListBuilds,
	featGetActive,
} = vi.hoisted(() => ({
	getUpdate: vi.fn(),
	setUpdate: vi.fn(),
	updGetStatus: vi.fn(),
	updCheck: vi.fn(),
	updDownload: vi.fn(),
	updInstall: vi.fn(),
	updOnStatus: vi.fn(),
	getVersion: vi.fn(),
	getDaemonStatus: vi.fn(),
	navigateMock: vi.fn(),
	writeText: vi.fn(),
	openExternal: vi.fn(),
	featListBuilds: vi.fn(),
	featGetActive: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => navigateMock,
	};
});

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		app: { getVersion, openExternal },
		clipboard: { writeText },
		daemon: { getStatus: getDaemonStatus },
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
	for (const m of [
		getUpdate,
		setUpdate,
		updGetStatus,
		updCheck,
		updDownload,
		updInstall,
		updOnStatus,
		navigateMock,
		writeText,
		openExternal,
		getVersion,
		getDaemonStatus,
		featListBuilds,
		featGetActive,
	]) {
		m.mockReset();
	}
	getUpdate.mockResolvedValue({ enabled: true, channel: "latest", nightlyAck: false, feature: null });
	setUpdate.mockResolvedValue(undefined);
	updGetStatus.mockResolvedValue({ state: "idle" });
	updCheck.mockResolvedValue(undefined);
	updDownload.mockResolvedValue(undefined);
	updInstall.mockResolvedValue(undefined);
	updOnStatus.mockReturnValue(() => undefined);
	getVersion.mockResolvedValue("1.4.0");
	getDaemonStatus.mockResolvedValue({ state: "ready" });
	writeText.mockResolvedValue(undefined);
	openExternal.mockResolvedValue(undefined);
	featListBuilds.mockResolvedValue([]);
	featGetActive.mockResolvedValue(null);
});

describe("GlobalSettingsForm", () => {
	it("renders the Figma settings sections", async () => {
		renderForm();
		expect(await screen.findByLabelText("Settings")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
		expect(screen.getByText("General")).toBeInTheDocument();
		expect(screen.getByText("Updates")).toBeInTheDocument();
		expect(screen.getByText("Get help")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Report a problem" })).toBeInTheDocument();
	});

	it("shows the nightly warning when the nightly channel is loaded", async () => {
		getUpdate.mockResolvedValue({ enabled: true, channel: "nightly", nightlyAck: true, feature: null });
		renderForm();
		expect(await screen.findByText(/Nightly builds are cut every day/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
	});

	it("auto-saves when the updates channel changes while automatic updates are enabled", async () => {
		renderForm();
		await screen.findByLabelText("Updates channel");
		await userEvent.click(screen.getByLabelText("Updates channel"));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Nightly (Pre-release)" }));
		await waitFor(() =>
			expect(setUpdate).toHaveBeenCalledWith(
				expect.objectContaining({ channel: "nightly", enabled: true, nightlyAck: true, feature: null }),
			),
		);
		expect(await screen.findByText(/Nightly builds are cut every day/i)).toBeInTheDocument();
	});

	it("auto-saves when automatic updates are toggled", async () => {
		renderForm();
		await screen.findByLabelText("Automatic Updates");
		await userEvent.click(screen.getByLabelText("Automatic Updates"));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Disabled" }));
		await waitFor(() =>
			expect(setUpdate).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, channel: "latest" })),
		);
	});

	it("hides the nightly warning on the stable channel", async () => {
		renderForm();
		await screen.findByText("Updates");
		expect(screen.queryByText(/Nightly builds are cut every day/i)).not.toBeInTheDocument();
	});

	it("hides the nightly warning when Feature Releases is selected", async () => {
		getUpdate.mockResolvedValue({ enabled: true, channel: "nightly", nightlyAck: true, feature: null });
		renderForm();
		expect(await screen.findByText(/Nightly builds are cut every day/i)).toBeInTheDocument();
		await userEvent.click(screen.getByLabelText("Updates channel"));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Feature Releases" }));
		expect(screen.queryByText(/Nightly builds are cut every day/i)).not.toBeInTheDocument();
	});

	it("shows the current app version", async () => {
		renderForm();
		expect(await screen.findByText(/Current version - v1\.4\.0/)).toBeInTheDocument();
	});

	it("Check for updates icon triggers a manual check", async () => {
		renderForm();
		expect(await screen.findByText(/Current version - v1\.4\.0/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
		expect(updCheck).toHaveBeenCalled();
	});

	it("offers an Update button when an update is available and downloads it", async () => {
		let emit: (s: { state: string; version?: string; requestId?: string }) => void = () => undefined;
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
		let emit: (s: { state: string; version?: string; requestId?: string }) => void = () => undefined;
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

	it("opens feedback from settings and copies redacted report drafts", async () => {
		const user = userEvent.setup();
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		getVersion.mockResolvedValue("9.9.9-test");
		getDaemonStatus.mockResolvedValue({
			state: "ready",
			message: "Listening at http://127.0.0.1:31001?token=secret",
		});
		renderForm();

		await user.click(await screen.findByRole("button", { name: "Report a problem" }));
		expect(await screen.findByRole("dialog", { name: "Report a problem" })).toBeInTheDocument();

		await user.type(screen.getByLabelText("Title"), "Create project fails in /Users/alice/private-repo");
		await user.type(
			screen.getByLabelText("What happened?"),
			"Open http://127.0.0.1:5173/projects/demo?access_token=local-secret and click Create. Show a clear prerequisite error.",
		);
		expect(screen.queryByRole("combobox", { name: "Report type" })).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Include safe diagnostics")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Expected behavior")).not.toBeInTheDocument();
		expect(screen.getByRole("radiogroup", { name: "Report destination" })).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "GitHub" })).toHaveAttribute("aria-checked", "true");
		expect(screen.queryByLabelText("Report preview")).not.toBeInTheDocument();

		expect(screen.getByRole("button", { name: /copy & create github issue/i })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /copy & open email/i })).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /copy & create github issue/i }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		const copied = writeText.mock.calls[0][0] as string;
		expect(copied).toContain("Create project fails");
		expect(copied).toContain("AO version: 9.9.9-test");
		expect(copied).toContain("Daemon: ready");
		expect(copied).toContain("[redacted-local-path]");
		expect(copied).toContain("[redacted-local-url]");
		expect(copied).not.toContain("/Users/alice");
		expect(copied).not.toContain("local-secret");
		expect(copied).not.toContain("## Type");
		expect(copied).not.toContain("Generated locally by AO");
		expect(openExternal).toHaveBeenCalledWith(
			expect.stringContaining("https://github.com/AgentWrapper/agent-orchestrator/issues/new"),
		);
		expect(open).not.toHaveBeenCalled();
		expect(screen.getByLabelText("Title")).toHaveValue("");
		expect(screen.getByLabelText("What happened?")).toHaveValue("");
	});

	it("opens Discord with an official invite and email with the support mailbox", async () => {
		const user = userEvent.setup();
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		getVersion.mockRejectedValue(new Error("version unavailable"));
		getDaemonStatus.mockRejectedValue(new Error("daemon unavailable"));
		renderForm();

		await user.click(await screen.findByRole("button", { name: "Report a problem" }));
		expect(await screen.findByRole("dialog", { name: "Report a problem" })).toBeInTheDocument();
		await user.type(screen.getByLabelText("Title"), "Need help with setup");

		await user.click(screen.getByRole("radio", { name: "Discord" }));
		expect(screen.getByRole("button", { name: /copy & open discord/i })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /copy & open email/i })).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /copy & open discord/i }));
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0][0]).toContain("**AO feedback**");
		expect(screen.getByText("Discord draft copied.")).toBeInTheDocument();

		await user.click(screen.getByRole("radio", { name: "Email" }));
		expect(screen.getByRole("button", { name: /copy & open email/i })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /copy & open discord/i })).not.toBeInTheDocument();
		expect(screen.queryByText("Discord draft copied.")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /copy & open email/i })).toBeDisabled();
		await user.type(screen.getByLabelText("Title"), "Need help with setup");
		await user.click(screen.getByRole("button", { name: /copy & open email/i }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
		expect(writeText.mock.calls[0][0]).toContain("Daemon: unknown");
		expect(writeText.mock.calls[1][0]).toContain("To: support@aoagents.dev");
		expect(writeText.mock.calls[1][0]).toContain("AO feedback");
		expect(openExternal).toHaveBeenCalledWith("https://discord.com/invite/UZv7JjxbwG");
		expect(openExternal).toHaveBeenCalledWith(expect.stringContaining("mailto:support@aoagents.dev"));
		expect(open).not.toHaveBeenCalled();
	});

	it("clears draft text when the feedback dialog closes", async () => {
		const user = userEvent.setup();
		const githubToken = `ghp_${"abcdefghijklmnopqrstuvwxyz"}${"1234567890AB"}`;
		renderForm();

		await user.click(await screen.findByRole("button", { name: "Report a problem" }));
		expect(await screen.findByRole("dialog", { name: "Report a problem" })).toBeInTheDocument();
		await user.type(screen.getByLabelText("Title"), "Sensitive setup problem");
		await user.type(screen.getByLabelText("What happened?"), `Token is ${githubToken}`);

		await user.click(screen.getByRole("button", { name: "Close report dialog" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Report a problem" })).not.toBeInTheDocument());

		await user.click(await screen.findByRole("button", { name: "Report a problem" }));
		expect(await screen.findByRole("dialog", { name: "Report a problem" })).toBeInTheDocument();
		expect(screen.getByLabelText("Title")).toHaveValue("");
		expect(screen.getByLabelText("What happened?")).toHaveValue("");
	});

	it("keeps the report form to title and details while tailoring placeholder guidance", async () => {
		const user = userEvent.setup();
		renderForm();

		await user.click(await screen.findByRole("button", { name: "Report a problem" }));
		expect(await screen.findByRole("dialog", { name: "Report a problem" })).toBeInTheDocument();
		expect(screen.getByLabelText("Title")).toHaveAttribute("placeholder", "Brief Title");
		expect(screen.getByLabelText("What happened?")).toHaveAttribute(
			"placeholder",
			"Share what happened, what you expected, and how to reproduce it.",
		);
		expect(screen.queryByLabelText("Expected behavior")).not.toBeInTheDocument();
		expect(screen.queryByRole("combobox", { name: "Report type" })).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Include safe diagnostics")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Report preview")).not.toBeInTheDocument();
	});

	it("reveals the feature-build picker when Feature Releases is selected", async () => {
		renderForm();
		await screen.findByText("Updates");
		// The picker must be reachable from a clean state (no pin seeded).
		await userEvent.click(screen.getByLabelText("Updates channel"));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Feature Releases" }));
		// Secondary picker mounts; no live builds are mocked, so it shows the empty state.
		expect(await screen.findByText("No live feature releases.")).toBeInTheDocument();
		expect(featListBuilds).toHaveBeenCalled();
	});

	it("pins a feature build after confirming and ignores unowned updater events", async () => {
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
		let emit: (s: { state: string; version?: string; requestId?: string }) => void = () => undefined;
		updOnStatus.mockImplementation((cb: (s: unknown) => void) => {
			emit = cb as typeof emit;
			return () => undefined;
		});
		renderForm();
		await screen.findByText("Updates");

		await userEvent.click(screen.getByLabelText("Updates channel"));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Feature Releases" }));

		await userEvent.click(await screen.findByLabelText("Feature build"));
		await userEvent.click(await screen.findByRole("menuitem", { name: /PR #2270: Fix foo/ }));

		// Confirmation dialog replaces window.confirm.
		await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));

		await waitFor(() =>
			expect(updCheck).toHaveBeenCalledWith({
				settings: expect.objectContaining({ feature: { pr: 2270 } }),
				requestId: expect.any(String),
			}),
		);
		const requestId = updCheck.mock.calls[0]?.[0]?.requestId as string;

		// An older hourly operation can finish while the feature request waits for
		// updater ownership. Its events must not arm the feature install flow.
		act(() => emit({ state: "available", version: "1.2.3" }));
		expect(updDownload).not.toHaveBeenCalled();

		// The owned feature operation auto-progresses available -> download -> install.
		act(() => emit({ state: "available", version: "1.2.3", requestId }));
		await waitFor(() => expect(updDownload).toHaveBeenCalledWith(requestId));
		act(() => emit({ state: "downloaded", version: "1.2.3", requestId }));
		await waitFor(() => expect(updInstall).toHaveBeenCalled());
	});

	it("returns to Stable, then auto-progresses check -> download -> install", async () => {
		getUpdate.mockResolvedValue({ enabled: true, channel: "latest", nightlyAck: false, feature: { pr: 2270 } });
		featGetActive.mockResolvedValue({ pr: 2270 });
		let emit: (s: { state: string; version?: string; requestId?: string }) => void = () => undefined;
		updOnStatus.mockImplementation((cb: (s: unknown) => void) => {
			emit = cb as typeof emit;
			return () => undefined;
		});
		renderForm();

		const returnBtn = await screen.findByRole("button", { name: "Return to Stable" });
		await userEvent.click(returnBtn);

		await waitFor(() =>
			expect(updCheck).toHaveBeenCalledWith({
				settings: expect.objectContaining({ feature: null }),
				requestId: expect.any(String),
			}),
		);
		const requestId = updCheck.mock.calls[0]?.[0]?.requestId as string;

		act(() => emit({ state: "available", version: "1.3.0", requestId }));
		await waitFor(() => expect(updDownload).toHaveBeenCalledWith(requestId));
		act(() => emit({ state: "downloaded", version: "1.3.0", requestId }));
		await waitFor(() => expect(updInstall).toHaveBeenCalled());
	});
});
