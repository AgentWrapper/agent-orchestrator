import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_SOCIAL_LINKS } from "../lib/social-links";
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
	for (const m of [getUpdate, setUpdate, navigateMock, writeText, openExternal, getVersion, getDaemonStatus]) {
		m.mockReset();
	}
	getUpdate.mockResolvedValue({ enabled: true, channel: "latest", nightlyAck: false });
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
});

describe("GlobalSettingsForm", () => {
	it("renders the Figma settings sections", async () => {
		renderForm();
		expect(await screen.findByLabelText("Settings")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
		expect(screen.getByText("General")).toBeInTheDocument();
		expect(screen.getByText("Updates")).toBeInTheDocument();
		expect(screen.getByText("Get help")).toBeInTheDocument();
		expect(screen.getByText("CONNECT WITH US")).toBeInTheDocument();
		for (const { label } of SETTINGS_SOCIAL_LINKS) {
			expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
		}
		expect(screen.queryByText("More settings below...")).not.toBeInTheDocument();
	});

	it("shows the nightly warning when the nightly channel is loaded", async () => {
		getUpdate.mockResolvedValue({ enabled: true, channel: "nightly", nightlyAck: true });
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
				expect.objectContaining({ channel: "nightly", enabled: true, nightlyAck: true }),
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

	it("opens feedback from settings and copies redacted report drafts", async () => {
		const user = userEvent.setup();
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		getVersion.mockResolvedValue("9.9.9-test");
		getDaemonStatus.mockResolvedValue({
			state: "ready",
			message: "Listening at http://127.0.0.1:31001?token=secret",
		});
		renderForm();

		await user.click(await screen.findByRole("button", { name: "Feedback" }));
		expect(await screen.findByRole("dialog", { name: "Report a problem" })).toBeInTheDocument();

		await user.type(screen.getByLabelText("Title"), "Create project fails in /Users/alice/private-repo");
		await user.type(
			screen.getByLabelText("Brief"),
			"Open http://127.0.0.1:5173/projects/demo?access_token=local-secret and click Create. Show a clear prerequisite error.",
		);
		expect(screen.queryByRole("combobox", { name: "Report type" })).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Include safe diagnostics")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Expected behavior")).not.toBeInTheDocument();
		const destinationButton = screen.getByRole("button", { name: "Report destination" });
		expect(destinationButton).toHaveTextContent("GitHub");
		await user.click(destinationButton);
		await user.click(await screen.findByRole("menuitem", { name: "GitHub" }));
		expect(screen.queryByLabelText("Report preview")).not.toBeInTheDocument();

		expect(screen.getByRole("button", { name: /copy and raise github issue/i })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /copy and open email/i })).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /copy and raise github issue/i }));

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
		expect(screen.getByLabelText("Brief")).toHaveValue("");
	});

	it("opens Discord with an official invite and email with the support mailbox", async () => {
		const user = userEvent.setup();
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		getVersion.mockRejectedValue(new Error("version unavailable"));
		getDaemonStatus.mockRejectedValue(new Error("daemon unavailable"));
		renderForm();

		await user.click(await screen.findByRole("button", { name: "Feedback" }));
		expect(await screen.findByRole("dialog", { name: "Report a problem" })).toBeInTheDocument();
		await user.type(screen.getByLabelText("Title"), "Need help with setup");

		await user.click(screen.getByRole("button", { name: "Report destination" }));
		await user.click(await screen.findByRole("menuitem", { name: "Discord" }));
		expect(screen.getByRole("button", { name: /copy and open discord/i })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /copy and open email/i })).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /copy and open discord/i }));
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0][0]).toContain("**AO feedback**");
		expect(screen.getByText("Discord draft copied.")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Report destination" }));
		await user.click(await screen.findByRole("menuitem", { name: "Email" }));
		expect(screen.getByRole("button", { name: /copy and open email/i })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /copy and open discord/i })).not.toBeInTheDocument();
		expect(screen.queryByText("Discord draft copied.")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /copy and open email/i }));

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

		await user.click(await screen.findByRole("button", { name: "Feedback" }));
		expect(await screen.findByRole("dialog", { name: "Report a problem" })).toBeInTheDocument();
		await user.type(screen.getByLabelText("Title"), "Sensitive setup problem");
		await user.type(screen.getByLabelText("Brief"), `Token is ${githubToken}`);

		await user.click(screen.getByRole("button", { name: "Close report dialog" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Report a problem" })).not.toBeInTheDocument());

		await user.click(await screen.findByRole("button", { name: "Feedback" }));
		expect(await screen.findByRole("dialog", { name: "Report a problem" })).toBeInTheDocument();
		expect(screen.getByLabelText("Title")).toHaveValue("");
		expect(screen.getByLabelText("Brief")).toHaveValue("");
	});

	it("keeps the report form to title and brief while tailoring placeholder guidance", async () => {
		const user = userEvent.setup();
		renderForm();

		await user.click(await screen.findByRole("button", { name: "Feedback" }));
		expect(await screen.findByRole("dialog", { name: "Report a problem" })).toBeInTheDocument();
		expect(screen.getByLabelText("Title")).toHaveAttribute("placeholder", "Brief title");
		expect(screen.getByLabelText("Brief")).toHaveAttribute(
			"placeholder",
			"Share what happened, what you expected, and how to reproduce it.",
		);
		expect(screen.queryByLabelText("Expected behavior")).not.toBeInTheDocument();
		expect(screen.queryByRole("combobox", { name: "Report type" })).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Include safe diagnostics")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Report preview")).not.toBeInTheDocument();
	});
});
