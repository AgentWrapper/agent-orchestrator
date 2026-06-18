import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMock, postMock, putMock, startDaemonMock, stopDaemonMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
	putMock: vi.fn(),
	startDaemonMock: vi.fn(),
	stopDaemonMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: getMock,
		POST: postMock,
		PUT: putMock,
	},
	apiErrorMessage: (error: unknown) => {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error) {
			return String((error as { message: unknown }).message);
		}
		return "Request failed";
	},
	hasTrustedApiBaseUrl: () => true,
}));

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		daemon: {
			start: startDaemonMock,
			stop: stopDaemonMock,
		},
	},
}));

import { ProjectSettingsForm } from "./ProjectSettingsForm";

function renderSettings(projectId = "proj-1") {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	render(
		<QueryClientProvider client={queryClient}>
			<ProjectSettingsForm projectId={projectId} />
		</QueryClientProvider>,
	);
	return queryClient;
}

async function chooseOption(trigger: HTMLElement, optionName: string) {
	await userEvent.click(trigger);
	await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

let projectResponse: unknown;
let agentsResponse: unknown;
let orchestratorsResponse: unknown;
let projectsListResponse: unknown;
let sessionsListResponse: unknown;

beforeEach(() => {
	getMock.mockReset();
	postMock.mockReset();
	putMock.mockReset();
	startDaemonMock.mockReset();
	stopDaemonMock.mockReset();
	postMock.mockResolvedValue({
		data: { orchestrator: { id: "proj-1-orchestrator", projectId: "proj-1" } },
		error: undefined,
	});
	putMock.mockResolvedValue({ data: { project: {} }, error: undefined });
	startDaemonMock.mockResolvedValue({ state: "starting" });
	stopDaemonMock.mockResolvedValue({ state: "stopped" });
	projectResponse = undefined;
	agentsResponse = undefined;
	orchestratorsResponse = { data: { sessions: [] }, error: undefined };
	projectsListResponse = { data: { projects: [] }, error: undefined };
	sessionsListResponse = { data: { sessions: [] }, error: undefined };
});

describe("ProjectSettingsForm", () => {
	it("loads the current project settings and saves the exposed fields without dropping hidden config", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "git@github.com:acme/project-one.git",
			defaultBranch: "main",
			config: {
				defaultBranch: "develop",
				sessionPrefix: "po",
				env: { FOO: "bar" },
				symlinks: [".env"],
				postCreate: ["npm install"],
				worker: {
					agent: "codex",
					agentConfig: { model: "worker-model" },
				},
				orchestrator: { agent: "claude-code" },
				agentConfig: {
					model: "claude-opus-4-5",
					permissions: "auto",
				},
				reviewers: [{ harness: "claude-code" }],
			},
		});
		mockAgents({
			supported: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
				{ id: "goose", label: "Goose" },
				{ id: "opencode", label: "OpenCode" },
			],
			installed: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
				{ id: "goose", label: "Goose" },
				{ id: "opencode", label: "OpenCode" },
			],
			authorized: [
				{ id: "claude-code", label: "Claude Code", authStatus: "authorized" },
				{ id: "codex", label: "Codex", authStatus: "authorized" },
				{ id: "goose", label: "Goose", authStatus: "authorized" },
				{ id: "opencode", label: "OpenCode", authStatus: "authorized" },
			],
		});
		mockGetResponses();

		renderSettings();

		expect(await screen.findByText("git@github.com:acme/project-one.git")).toBeInTheDocument();
		expect(screen.queryByText(/supported agents installed on this machine/)).not.toBeInTheDocument();
		expect(screen.queryByText(/installed agents authorized/)).not.toBeInTheDocument();
		expect(screen.getByLabelText("Default branch")).toHaveValue("develop");
		expect(screen.getByLabelText("Session prefix")).toHaveValue("po");
		expect(screen.getByLabelText("Model override")).toHaveValue("claude-opus-4-5");

		const workerAgent = screen.getByRole("combobox", { name: "Default worker agent" });
		const orchestratorAgent = screen.getByRole("combobox", { name: "Default orchestrator agent" });
		const permissionMode = screen.getByRole("combobox", { name: "Permission mode" });
		expect(workerAgent).toHaveTextContent("Codex");
		expect(orchestratorAgent).toHaveTextContent("Claude Code");
		const reviewerAgent = screen.getByRole("combobox", { name: "Default reviewer agent" });
		expect(permissionMode).toHaveTextContent("Auto");
		expect(reviewerAgent).toHaveTextContent("claude-code");

		await userEvent.clear(screen.getByLabelText("Default branch"));
		await userEvent.type(screen.getByLabelText("Default branch"), "release");
		await userEvent.clear(screen.getByLabelText("Session prefix"));
		await userEvent.type(screen.getByLabelText("Session prefix"), "rel");
		await userEvent.clear(screen.getByLabelText("Model override"));
		await userEvent.type(screen.getByLabelText("Model override"), "gpt-5-codex");
		await chooseOption(workerAgent, "OpenCode");
		await chooseOption(orchestratorAgent, "Goose");
		await chooseOption(permissionMode, "Bypass permissions");

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		expect(getMock).toHaveBeenCalledWith("/api/v1/orchestrators");
		expect(postMock).toHaveBeenCalledWith("/api/v1/orchestrators", {
			body: { projectId: "proj-1", clean: true },
		});
		expect(putMock).toHaveBeenCalledWith("/api/v1/projects/{id}/config", {
			params: { path: { id: "proj-1" } },
			body: {
				config: {
					defaultBranch: "release",
					sessionPrefix: "rel",
					env: { FOO: "bar" },
					symlinks: [".env"],
					postCreate: ["npm install"],
					worker: {
						agent: "opencode",
						agentConfig: { model: "worker-model" },
					},
					orchestrator: { agent: "goose" },
					agentConfig: {
						model: "gpt-5-codex",
						permissions: "bypass-permissions",
					},
					reviewers: [{ harness: "claude-code" }],
				},
			},
		});
		expect(await screen.findByText("Saved. Orchestrator restarted.")).toBeInTheDocument();
	}, 20_000);

	it("reuses the cached agent catalog across project settings switches", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				worker: { agent: "codex" },
				orchestrator: { agent: "codex" },
			},
		});
		mockAgents({
			supported: [{ id: "codex", label: "Codex" }],
			installed: [{ id: "codex", label: "Codex" }],
			authorized: [{ id: "codex", label: "Codex", authStatus: "authorized" }],
		});
		mockGetResponses();
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});

		const view = render(
			<QueryClientProvider client={queryClient}>
				<ProjectSettingsForm projectId="proj-1" />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(screen.getAllByText("/repo/project-one").length).toBeGreaterThan(0));
		expect(agentRequestCount()).toBe(1);

		mockProject({
			id: "proj-2",
			name: "Project Two",
			kind: "single_repo",
			path: "/repo/project-two",
			repo: "",
			defaultBranch: "main",
		});

		view.rerender(
			<QueryClientProvider client={queryClient}>
				<ProjectSettingsForm projectId="proj-2" />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(screen.getAllByText("/repo/project-two").length).toBeGreaterThan(0));
		expect(agentRequestCount()).toBe(1);
	});

	it("lets project settings manually reload the shared agent catalog", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
		});
		mockAgents({
			supported: [{ id: "codex", label: "Codex" }],
			installed: [{ id: "codex", label: "Codex" }],
			authorized: [{ id: "codex", label: "Codex", authStatus: "authorized" }],
		});
		mockGetResponses();

		renderSettings();

		expect(await screen.findByRole("combobox", { name: "Default worker agent" })).toBeInTheDocument();
		expect(agentRequestCount()).toBe(1);

		await userEvent.click(screen.getByRole("button", { name: "Reload agents" }));

		await waitFor(() => expect(agentRequestCount()).toBe(2));
	});

	it("reuses the cached agent catalog across project settings switches", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
		});
		mockAgents({
			supported: [{ id: "codex", label: "Codex" }],
			installed: [{ id: "codex", label: "Codex" }],
			authorized: [{ id: "codex", label: "Codex", authStatus: "authorized" }],
		});
		mockGetResponses();
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});

		const view = render(
			<QueryClientProvider client={queryClient}>
				<ProjectSettingsForm projectId="proj-1" />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(screen.getAllByText("/repo/project-one").length).toBeGreaterThan(0));
		expect(agentRequestCount()).toBe(1);

		mockProject({
			id: "proj-2",
			name: "Project Two",
			kind: "single_repo",
			path: "/repo/project-two",
			repo: "",
			defaultBranch: "main",
		});

		view.rerender(
			<QueryClientProvider client={queryClient}>
				<ProjectSettingsForm projectId="proj-2" />
			</QueryClientProvider>,
		);

		await waitFor(() => expect(screen.getAllByText("/repo/project-two").length).toBeGreaterThan(0));
		expect(agentRequestCount()).toBe(1);
	});

	it("lets project settings manually reload the shared agent catalog", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
		});
		mockAgents({
			supported: [{ id: "codex", label: "Codex" }],
			installed: [{ id: "codex", label: "Codex" }],
			authorized: [{ id: "codex", label: "Codex", authStatus: "authorized" }],
		});
		mockGetResponses();

		renderSettings();

		expect(await screen.findByRole("combobox", { name: "Default worker agent" })).toBeInTheDocument();
		expect(agentRequestCount()).toBe(1);

		await userEvent.click(screen.getByRole("button", { name: "Reload agents" }));

		await waitFor(() => expect(agentRequestCount()).toBe(2));
	});

	it("does not restart the orchestrator when unrelated settings change", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				defaultBranch: "main",
				worker: { agent: "codex" },
				orchestrator: { agent: "codex" },
			},
		});
		mockAgents({
			supported: [{ id: "codex", label: "Codex" }],
			installed: [{ id: "codex", label: "Codex" }],
			authorized: [{ id: "codex", label: "Codex", authStatus: "authorized" }],
		});
		mockGetResponses();

		renderSettings();

		await userEvent.clear(await screen.findByLabelText("Default branch"));
		await userEvent.type(screen.getByLabelText("Default branch"), "release");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		expect(postMock).not.toHaveBeenCalled();
		expect(await screen.findByText("Saved.")).toBeInTheDocument();
	}, 20_000);

	it("blocks orchestrator agent changes while the project orchestrator is active", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				worker: { agent: "claude-code" },
				orchestrator: { agent: "claude-code" },
			},
		});
		mockAgents({
			supported: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
			],
			installed: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
			],
			authorized: [
				{ id: "claude-code", label: "Claude Code", authStatus: "authorized" },
				{ id: "codex", label: "Codex", authStatus: "authorized" },
			],
		});
		mockOrchestrators([
			{
				id: "proj-1-orchestrator",
				projectId: "proj-1",
				kind: "orchestrator",
				status: "working",
				isTerminated: false,
			},
		]);
		mockGetResponses();

		renderSettings();

		await chooseOption(await screen.findByRole("combobox", { name: "Default orchestrator agent" }), "Codex");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(
			await screen.findByText("Orchestrator is currently active. Wait until it is idle before switching agents."),
		).toBeInTheDocument();
		expect(putMock).not.toHaveBeenCalled();
		expect(postMock).not.toHaveBeenCalled();
	});

	it("allows orchestrator agent changes when the current orchestrator is idle", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				worker: { agent: "claude-code" },
				orchestrator: { agent: "claude-code" },
			},
		});
		mockAgents({
			supported: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
			],
			installed: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
			],
			authorized: [
				{ id: "claude-code", label: "Claude Code", authStatus: "authorized" },
				{ id: "codex", label: "Codex", authStatus: "authorized" },
			],
		});
		mockOrchestrators([
			{
				id: "proj-1-orchestrator",
				projectId: "proj-1",
				kind: "orchestrator",
				status: "idle",
				isTerminated: false,
			},
		]);
		mockGetResponses();

		renderSettings();

		await chooseOption(await screen.findByRole("combobox", { name: "Default orchestrator agent" }), "Codex");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/orchestrators", {
			body: { projectId: "proj-1", clean: true },
		});
		expect(await screen.findByText("Saved. Orchestrator restarted.")).toBeInTheDocument();
	});

	it("shows a persistent retry action when config saves but orchestrator replacement fails", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				worker: { agent: "claude-code" },
				orchestrator: { agent: "claude-code" },
			},
		});
		mockAgents({
			supported: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
			],
			installed: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
			],
			authorized: [
				{ id: "claude-code", label: "Claude Code", authStatus: "authorized" },
				{ id: "codex", label: "Codex", authStatus: "authorized" },
			],
		});
		mockOrchestrators([
			{
				id: "proj-1-orchestrator",
				projectId: "proj-1",
				kind: "orchestrator",
				harness: "claude-code",
				provider: "claude-code",
				status: "idle",
				isTerminated: false,
			},
		]);
		mockGetResponses();
		putMock.mockImplementation(async () => {
			mockProject({
				id: "proj-1",
				name: "Project One",
				kind: "single_repo",
				path: "/repo/project-one",
				repo: "",
				defaultBranch: "main",
				config: {
					worker: { agent: "codex" },
					orchestrator: { agent: "codex" },
				},
			});
			return { data: { project: {} }, error: undefined };
		});
		postMock
			.mockResolvedValueOnce({ data: undefined, error: { message: "agent binary missing" } })
			.mockResolvedValueOnce({
				data: { orchestrator: { id: "proj-2-orchestrator", projectId: "proj-1" } },
				error: undefined,
			});

		renderSettings();

		await chooseOption(await screen.findByRole("combobox", { name: "Default orchestrator agent" }), "Codex");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(
			await screen.findByText(
				"Saved config. New orchestrator failed to start, and the previous orchestrator is still running: agent binary missing",
			),
		).toBeInTheDocument();
		expect(await screen.findByText("Orchestrator replacement pending")).toBeInTheDocument();
		expect(
			screen.getByText(
				(_, node) =>
					node?.textContent === "Saved orchestrator agent is Codex, but the running orchestrator is still Claude Code.",
			),
		).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Retry orchestrator replacement" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
		expect(postMock).toHaveBeenNthCalledWith(2, "/api/v1/orchestrators", {
			body: { projectId: "proj-1", clean: true },
		});
		expect(putMock).toHaveBeenCalledTimes(1);
	});

	it("disables spawn retry until the old orchestrator becomes idle", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
		});
		mockAgents({
			supported: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
			],
			installed: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
			],
			authorized: [
				{ id: "claude-code", label: "Claude Code", authStatus: "authorized" },
				{ id: "codex", label: "Codex", authStatus: "authorized" },
			],
		});
		mockOrchestrators([
			{
				id: "proj-1-orchestrator",
				projectId: "proj-1",
				kind: "orchestrator",
				harness: "claude-code",
				provider: "claude-code",
				status: "working",
				isTerminated: false,
			},
		]);
		mockGetResponses();

		renderSettings();

		expect(await screen.findByText("Orchestrator replacement pending")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retry when idle" })).toBeDisabled();
		expect(screen.getByText("Current orchestrator must be idle before retrying.")).toBeInTheDocument();
	});

	it("offers an AO daemon restart when replacement stopped the old orchestrator but could not record state", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				worker: { agent: "claude-code" },
				orchestrator: { agent: "claude-code" },
			},
		});
		mockAgents({
			supported: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
			],
			installed: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
			],
			authorized: [
				{ id: "claude-code", label: "Claude Code", authStatus: "authorized" },
				{ id: "codex", label: "Codex", authStatus: "authorized" },
			],
		});
		mockOrchestrators([
			{
				id: "proj-1-orchestrator",
				projectId: "proj-1",
				kind: "orchestrator",
				status: "idle",
				isTerminated: false,
			},
		]);
		mockGetResponses();
		postMock.mockResolvedValueOnce({
			data: undefined,
			error: {
				code: "ORCHESTRATOR_REPLACEMENT_RECOVERY_REQUIRED",
				message: "state could not be recorded",
			},
		});

		renderSettings();

		await chooseOption(await screen.findByRole("combobox", { name: "Default orchestrator agent" }), "Codex");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(
			await screen.findByText(
				"Saved. New orchestrator started and the previous orchestrator was stopped, but its session state could not be updated.",
			),
		).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Restart AO daemon" }));

		await waitFor(() => expect(stopDaemonMock).toHaveBeenCalledTimes(1));
		expect(startDaemonMock).toHaveBeenCalledTimes(1);
		expect(await screen.findByText("AO daemon restart requested.")).toBeInTheDocument();
	});

	it("keeps the retry card after reload when daemon default is the desired orchestrator agent", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			agent: "codex",
			config: {},
		});
		mockAgents({
			supported: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
			],
			installed: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
			],
			authorized: [
				{ id: "claude-code", label: "Claude Code", authStatus: "authorized" },
				{ id: "codex", label: "Codex", authStatus: "authorized" },
			],
		});
		mockOrchestrators([
			{
				id: "proj-1-orchestrator",
				projectId: "proj-1",
				kind: "orchestrator",
				harness: "claude-code",
				provider: "claude-code",
				status: "idle",
				isTerminated: false,
			},
		]);
		mockGetResponses();

		renderSettings();

		expect(await screen.findByText("Orchestrator replacement pending")).toBeInTheDocument();
		expect(
			screen.getByText(
				(_, node) =>
					node?.textContent ===
					"Saved orchestrator agent is Codex (daemon default), but the running orchestrator is still Claude Code.",
			),
		).toBeInTheDocument();
	});

	it("keeps a configured but missing agent visible with a warning", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				worker: { agent: "aider" },
				orchestrator: { agent: "codex" },
			},
		});
		mockAgents({
			supported: [
				{ id: "aider", label: "Aider" },
				{ id: "codex", label: "Codex" },
			],
			installed: [{ id: "codex", label: "Codex" }],
			authorized: [{ id: "codex", label: "Codex", authStatus: "authorized" }],
		});
		mockGetResponses();

		renderSettings();

		expect(await screen.findByText("Aider is configured but was not detected on this machine.")).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Default worker agent" })).toHaveTextContent("Aider");
		await userEvent.click(screen.getByRole("combobox", { name: "Default orchestrator agent" }));
		expect(screen.getByRole("option", { name: /Aider.*Needs install/i })).toHaveAttribute("aria-disabled", "true");
	});

	it("shows unavailable agents instead of disabling the dropdowns", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
		});
		mockAgents({
			supported: [{ id: "codex", label: "Codex" }],
			installed: [],
			authorized: [],
		});
		mockGetResponses();

		renderSettings();

		expect(await screen.findByRole("combobox", { name: "Default worker agent" })).toBeInTheDocument();
		const workerAgent = screen.getByRole("combobox", { name: "Default worker agent" });
		const orchestratorAgent = screen.getByRole("combobox", { name: "Default orchestrator agent" });
		expect(workerAgent).not.toBeDisabled();
		expect(orchestratorAgent).not.toBeDisabled();
		await userEvent.click(workerAgent);
		expect(screen.getByRole("option", { name: /Codex.*Needs install/i })).toHaveAttribute("aria-disabled", "true");
	});

	it("keeps a configured but unauthorized agent visible with a warning", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				worker: { agent: "claude-code" },
				orchestrator: { agent: "codex" },
			},
		});
		mockAgents({
			supported: [
				{ id: "claude-code", label: "Claude Code" },
				{ id: "codex", label: "Codex" },
			],
			installed: [
				{ id: "claude-code", label: "Claude Code", authStatus: "unauthorized" },
				{ id: "codex", label: "Codex", authStatus: "authorized" },
			],
			authorized: [{ id: "codex", label: "Codex", authStatus: "authorized" }],
		});
		mockGetResponses();

		renderSettings();

		expect(
			await screen.findByText("Claude Code is configured but is not authorized on this machine."),
		).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Default worker agent" })).toHaveTextContent("Claude Code");
		await userEvent.click(screen.getByRole("combobox", { name: "Default orchestrator agent" }));
		expect(screen.getByRole("option", { name: /Claude Code.*Needs auth/i })).toHaveAttribute("aria-disabled", "true");
	});

	it("sorts agent options by authorized, installed, then not installed", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
		});
		mockAgents({
			supported: [
				{ id: "z-missing", label: "Z Missing" },
				{ id: "b-auth", label: "B Authorized", authStatus: "authorized" },
				{ id: "a-auth", label: "A Authorized", authStatus: "authorized" },
				{ id: "installed", label: "Installed Only", authStatus: "unauthorized" },
			],
			installed: [
				{ id: "b-auth", label: "B Authorized", authStatus: "authorized" },
				{ id: "a-auth", label: "A Authorized", authStatus: "authorized" },
				{ id: "installed", label: "Installed Only", authStatus: "unauthorized" },
			],
			authorized: [
				{ id: "b-auth", label: "B Authorized", authStatus: "authorized" },
				{ id: "a-auth", label: "A Authorized", authStatus: "authorized" },
			],
		});
		mockGetResponses();

		renderSettings();

		await userEvent.click(await screen.findByRole("combobox", { name: "Default worker agent" }));
		const options = screen.getAllByRole("option").map((option) => option.textContent);
		expect(options).toEqual([
			"Daemon default",
			"A Authorized",
			"B Authorized",
			"Installed OnlyNeeds auth",
			"Z MissingNeeds install",
		]);
	});

	it("prompts for login when installed agents have no authorized status", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				worker: { agent: "codex" },
				orchestrator: { agent: "codex" },
			},
		});
		mockAgents({
			supported: [
				{ id: "codex", label: "Codex" },
				{ id: "aider", label: "Aider" },
			],
			installed: [{ id: "codex", label: "Codex" }],
		});
		mockGetResponses();

		renderSettings();

		expect(await screen.findByRole("dialog", { name: "Agent login needed" })).toBeInTheDocument();
		expect(screen.getByText(/Log in to one of/)).toHaveTextContent("Log in to one of Codex, then reload settings.");
		await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

		const workerAgent = await screen.findByRole("combobox", { name: "Default worker agent" });
		await userEvent.click(workerAgent);
		expect(screen.getByRole("option", { name: /Codex.*Needs auth/i })).toHaveAttribute("aria-disabled", "true");
		expect(screen.getByRole("option", { name: /Aider.*Needs install/i })).toHaveAttribute("aria-disabled", "true");
	});

	it("shows the daemon validation message when save fails", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				worker: { agent: "codex" },
				orchestrator: { agent: "codex" },
			},
		});
		mockAgents({
			supported: [{ id: "codex", label: "Codex" }],
			installed: [{ id: "codex", label: "Codex" }],
			authorized: [{ id: "codex", label: "Codex", authStatus: "authorized" }],
		});
		mockGetResponses();
		putMock.mockResolvedValue({
			data: undefined,
			error: { message: "invalid permissions" },
		});

		renderSettings();

		await userEvent.click(await screen.findByRole("button", { name: "Save changes" }));

		expect(await screen.findByText("invalid permissions")).toBeInTheDocument();
		expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
	});

	it("requires worker and orchestrator agents for existing projects missing role config", async () => {
		getMock.mockResolvedValue({
			data: {
				status: "ok",
				project: {
					id: "proj-1",
					name: "Project One",
					kind: "single_repo",
					path: "/repo/project-one",
					repo: "",
					defaultBranch: "main",
					config: {},
				},
			},
			error: undefined,
		});

		renderSettings();

		expect(await screen.findByText("Worker and orchestrator agents are required.")).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Default worker agent" })).toHaveTextContent("Daemon default");
		expect(screen.getByRole("combobox", { name: "Default orchestrator agent" })).toHaveTextContent("Daemon default");

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(await screen.findAllByText("Worker and orchestrator agents are required.")).toHaveLength(2);
		expect(putMock).not.toHaveBeenCalled();
	});
});

function mockProject(project: unknown) {
	projectResponse = {
		data: {
			status: "ok",
			project,
		},
		error: undefined,
	};
	if (project && typeof project === "object") {
		const summary = project as { id?: unknown; name?: unknown; path?: unknown };
		projectsListResponse = {
			data: {
				projects: [
					{
						id: summary.id,
						name: summary.name,
						path: summary.path,
					},
				],
			},
			error: undefined,
		};
	}
}

function mockAgents(agents: unknown) {
	agentsResponse = {
		data: agents,
		error: undefined,
	};
}

function mockOrchestrators(sessions: unknown[]) {
	orchestratorsResponse = {
		data: { sessions },
		error: undefined,
	};
	sessionsListResponse = {
		data: { sessions },
		error: undefined,
	};
}

function mockGetResponses() {
	getMock.mockImplementation((path: string) => {
		if (path === "/api/v1/agents") return Promise.resolve(agentsResponse);
		if (path === "/api/v1/projects") return Promise.resolve(projectsListResponse);
		if (path === "/api/v1/orchestrators") return Promise.resolve(orchestratorsResponse);
		if (path === "/api/v1/sessions") return Promise.resolve(sessionsListResponse);
		return Promise.resolve(projectResponse);
	});
}

function agentRequestCount() {
	return getMock.mock.calls.filter(([path]) => path === "/api/v1/agents").length;
}
