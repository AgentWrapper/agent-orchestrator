import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMock, putMock, postMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	putMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: getMock,
		PUT: putMock,
		POST: postMock,
	},
	apiErrorMessage: (error: unknown) => {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error) {
			return String((error as { message: unknown }).message);
		}
		return "Request failed";
	},
}));

import { ProjectSettingsForm } from "./ProjectSettingsForm";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import type { WorkspaceSummary } from "../types/workspace";

function renderSettings(projectId = "proj-1", workspaces?: WorkspaceSummary[]) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	if (workspaces) {
		queryClient.setQueryData(workspaceQueryKey, { workspaces });
	}
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

const agentCatalogResponse = {
	data: {
		supported: [
			{ id: "claude-code", label: "Claude Code" },
			{ id: "codex", label: "Codex" },
			{ id: "goose", label: "Goose" },
			{ id: "kiro", label: "Kiro" },
			{ id: "opencode", label: "OpenCode" },
		],
		installed: [
			{ id: "claude-code", label: "Claude Code", authStatus: "authorized" },
			{ id: "codex", label: "Codex", authStatus: "authorized" },
			{ id: "goose", label: "Goose", authStatus: "authorized" },
			{ id: "kiro", label: "Kiro", authStatus: "unknown" },
			{ id: "opencode", label: "OpenCode", authStatus: "authorized" },
		],
		authorized: [
			{ id: "claude-code", label: "Claude Code", authStatus: "authorized" },
			{ id: "codex", label: "Codex", authStatus: "authorized" },
			{ id: "goose", label: "Goose", authStatus: "authorized" },
			{ id: "opencode", label: "OpenCode", authStatus: "authorized" },
		],
	},
	error: undefined,
};

const modelAvailabilityResponse = {
	data: {
		checkedAt: "2026-07-10T12:00:00Z",
		harnesses: [
			{
				id: "claude-code",
				label: "Claude Code",
				catalogSource: "known-set",
				models: [{ model: "claude-opus-4-5", status: "unreachable", reason: "400 model not available" }],
			},
		],
	},
	error: undefined,
};

function mockProject(project: Record<string, unknown>) {
	getMock.mockImplementation(async (path: string) => {
		if (path === "/api/v1/agents") return agentCatalogResponse;
		if (path === "/api/v1/agents/models") return modelAvailabilityResponse;
		return {
			data: {
				status: "ok",
				project,
			},
			error: undefined,
		};
	});
}

beforeEach(() => {
	getMock.mockReset();
	putMock.mockReset();
	postMock.mockReset();
	putMock.mockResolvedValue({ data: { project: {} }, error: undefined });
	postMock.mockResolvedValue({
		data: { orchestrator: { id: "proj-1-orch-2" } },
		error: undefined,
		response: { status: 200 },
	});
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
				projectPrefix: "po",
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

		renderSettings();

		expect(await screen.findByText("git@github.com:acme/project-one.git")).toBeInTheDocument();
		expect(screen.getByLabelText("Default branch")).toHaveValue("develop");
		expect(screen.getByLabelText("Project prefix")).toHaveValue("po");
		expect(screen.getByLabelText("Model override")).toHaveValue("claude-opus-4-5");
		expect(await screen.findByText(/unreachable: 400 model not available/)).toBeInTheDocument();

		const workerAgent = screen.getByRole("combobox", { name: "Default worker agent" });
		const orchestratorAgent = screen.getByRole("combobox", { name: "Default orchestrator agent" });
		const permissionMode = screen.getByRole("combobox", { name: "Permission mode" });
		const reviewerAgent = screen.getByRole("combobox", { name: "Default reviewer agent" });
		expect(workerAgent).toHaveTextContent("Codex");
		expect(orchestratorAgent).toHaveTextContent("Claude Code");
		expect(permissionMode).toHaveTextContent("Auto");
		expect(reviewerAgent).toHaveTextContent("claude-code");

		await userEvent.clear(screen.getByLabelText("Default branch"));
		await userEvent.type(screen.getByLabelText("Default branch"), "release");
		await userEvent.clear(screen.getByLabelText("Project prefix"));
		await userEvent.type(screen.getByLabelText("Project prefix"), "rel");
		await userEvent.clear(screen.getByLabelText("Model override"));
		await userEvent.type(screen.getByLabelText("Model override"), "gpt-5-codex");
		await chooseOption(workerAgent, "OpenCode");
		await chooseOption(orchestratorAgent, "Goose");
		await chooseOption(permissionMode, "Bypass permissions");

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		expect(putMock).toHaveBeenCalledWith("/api/v1/projects/{id}/config", {
			params: { path: { id: "proj-1" } },
			body: {
				config: {
					defaultBranch: "release",
					projectPrefix: "rel",
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
					workerMix: undefined,
					trackerIntake: undefined,
				},
			},
		});
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/orchestrators", {
			body: { projectId: "proj-1", clean: true },
		});
		expect(await screen.findByText("Saved.")).toBeInTheDocument();
	}, 20_000);

	it("exposes workspace, env, role model, and intake concurrency project config", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "git@github.com:acme/project-one.git",
			defaultBranch: "main",
			config: {
				defaultBranch: "develop",
				workspace: "in-place",
				env: { FOO: "bar", REMOVE_ME: "yes" },
				worker: {
					agent: "codex",
					agentConfig: { model: "worker-model" },
				},
				orchestrator: {
					agent: "claude-code",
					agentConfig: { model: "orchestrator-model" },
				},
				agentConfig: {
					model: "project-model",
					permissions: "auto",
				},
				trackerIntake: {
					enabled: true,
					provider: "github",
					maxConcurrent: 3,
					excludeLabels: ["no-ao"],
				},
			},
		});

		renderSettings();

		const workspaceMode = await screen.findByRole("combobox", { name: "Workspace mode" });
		expect(workspaceMode).toHaveTextContent("In place");
		expect(screen.getByLabelText("Environment key 1")).toHaveValue("FOO");
		expect(screen.getByLabelText("Environment value 1")).toHaveValue("bar");
		expect(screen.getByLabelText("Environment key 2")).toHaveValue("REMOVE_ME");
		expect(screen.getByLabelText("Worker model override")).toHaveValue("worker-model");
		expect(screen.getByLabelText("Orchestrator model override")).toHaveValue("orchestrator-model");
		expect(screen.getByLabelText("Max concurrent sessions")).toHaveValue(3);

		await chooseOption(workspaceMode, "Worktree");
		await userEvent.clear(screen.getByLabelText("Environment value 1"));
		await userEvent.type(screen.getByLabelText("Environment value 1"), "baz");
		await userEvent.click(screen.getByRole("button", { name: "Remove environment variable REMOVE_ME" }));
		await userEvent.click(screen.getByRole("button", { name: "Add environment variable" }));
		await userEvent.type(screen.getByLabelText("Environment key 2"), "NEW_VAR");
		await userEvent.type(screen.getByLabelText("Environment value 2"), "from-ui");
		await userEvent.clear(screen.getByLabelText("Worker model override"));
		await userEvent.type(screen.getByLabelText("Worker model override"), "gpt-5-codex");
		await userEvent.clear(screen.getByLabelText("Orchestrator model override"));
		await userEvent.type(screen.getByLabelText("Orchestrator model override"), "claude-opus-4-5");
		await userEvent.clear(screen.getByLabelText("Max concurrent sessions"));
		await userEvent.type(screen.getByLabelText("Max concurrent sessions"), "5");

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0]?.[1]?.body;
		expect(body.config.workspace).toBe("worktree");
		expect(body.config.env).toEqual({ FOO: "baz", NEW_VAR: "from-ui" });
		expect(body.config.worker).toEqual({
			agent: "codex",
			agentConfig: { model: "gpt-5-codex" },
		});
		expect(body.config.orchestrator).toEqual({
			agent: "claude-code",
			agentConfig: { model: "claude-opus-4-5" },
		});
		expect(body.config.trackerIntake).toEqual({
			enabled: true,
			provider: "github",
			maxConcurrent: 5,
			excludeLabels: ["no-ao"],
		});
	}, 20_000);

	it("blocks invalid or duplicate project environment keys", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				env: { FOO: "bar" },
				worker: { agent: "codex" },
				orchestrator: { agent: "claude-code" },
			},
		});

		renderSettings();

		await userEvent.click(await screen.findByRole("button", { name: "Add environment variable" }));
		await userEvent.type(screen.getByLabelText("Environment key 2"), "FOO");
		await userEvent.type(screen.getByLabelText("Environment value 2"), "duplicate");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(await screen.findByText("Environment variable names must be unique.")).toBeInTheDocument();
		expect(putMock).not.toHaveBeenCalled();

		await userEvent.clear(screen.getByLabelText("Environment key 2"));
		await userEvent.type(screen.getByLabelText("Environment key 2"), "1 BAD");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(
			await screen.findByText(
				"Environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores.",
			),
		).toBeInTheDocument();
		expect(putMock).not.toHaveBeenCalled();
	}, 20_000);

	it("loads legacy sessionPrefix but saves projectPrefix", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				sessionPrefix: "old",
				worker: { agent: "codex" },
				orchestrator: { agent: "claude-code" },
			},
		});

		renderSettings();

		expect(await screen.findByLabelText("Project prefix")).toHaveValue("old");
		await userEvent.clear(screen.getByLabelText("Project prefix"));
		await userEvent.type(screen.getByLabelText("Project prefix"), "new");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0]?.[1]?.body;
		expect(body.config.projectPrefix).toBe("new");
		expect(body.config.sessionPrefix).toBeUndefined();
	}, 20_000);

	it("does not fabricate an explicit intake disable after a mounted form refetches enabled intake", async () => {
		const project = {
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "git@github.com:acme/project-one.git",
			defaultBranch: "main",
			config: {
				worker: { agent: "codex" },
				orchestrator: { agent: "claude-code" },
			},
		};
		mockProject(project);

		const queryClient = renderSettings();
		expect(await screen.findByLabelText("Enable issue intake")).not.toBeChecked();

		act(() => {
			queryClient.setQueryData(["project", "proj-1"], {
				...project,
				config: {
					...project.config,
					trackerIntake: {
						enabled: true,
						provider: "github",
						assignee: "octocat",
						maxConcurrent: 3,
					},
				},
			});
		});

		await userEvent.type(screen.getByLabelText("Project prefix"), "ao");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0]?.[1]?.body;
		expect(body.config.trackerIntake).toBeUndefined();
	}, 20_000);

	it("saves autonomous merge without dropping hidden config", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "git@github.com:acme/project-one.git",
			defaultBranch: "main",
			config: {
				defaultBranch: "develop",
				env: { FOO: "bar" },
				worker: { agent: "codex" },
				orchestrator: { agent: "claude-code" },
			},
		});

		renderSettings();

		await userEvent.click(await screen.findByLabelText("Autonomous merge"));
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0]?.[1]?.body;
		expect(body.config.autonomousMerge).toBe(true);
		expect(body.config.env).toEqual({ FOO: "bar" });
		expect(body.config.defaultBranch).toBe("develop");
	});

	it("preserves hidden intake fields when saving a disabled intake config", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "git@github.com:acme/project-one.git",
			defaultBranch: "main",
			config: {
				worker: { agent: "codex" },
				orchestrator: { agent: "claude-code" },
				trackerIntake: {
					provider: "github",
					assignee: "octocat",
					maxConcurrent: 3,
					excludeLabels: ["no-ao"],
				},
			},
		});

		renderSettings();
		expect(await screen.findByLabelText("Enable issue intake")).not.toBeChecked();

		await userEvent.type(screen.getByLabelText("Project prefix"), "ao");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0]?.[1]?.body;
		expect(body.config.trackerIntake).toEqual({
			enabled: false,
			provider: "github",
			assignee: "octocat",
			maxConcurrent: 3,
			excludeLabels: ["no-ao"],
		});
	}, 20_000);

	it("loads an existing worker mix and saves added rows summing to 100", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				worker: { agent: "codex" },
				orchestrator: { agent: "claude-code" },
				workerMix: [{ agent: "codex", weight: 100 }],
			},
		});

		renderSettings();

		// The existing single-row mix loads with its percentage.
		expect(await screen.findByLabelText("Row 1 percentage")).toHaveValue(100);

		// Drop it to 60, add a second bucket at 40 → sums to 100.
		await userEvent.clear(screen.getByLabelText("Row 1 percentage"));
		await userEvent.type(screen.getByLabelText("Row 1 percentage"), "60");
		await userEvent.click(screen.getByRole("button", { name: "Add row" }));
		await userEvent.type(screen.getByLabelText("Row 2 percentage"), "40");
		await chooseOption(
			screen.getByRole("combobox", { name: "Row 2 agent" }),
			"Claude Code — claude-opus-4-5 (unreachable)",
		);

		expect(screen.getByText(/Total: 100%/)).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0]?.[1]?.body;
		expect(body.config.workerMix).toEqual([
			{ agent: "codex", weight: 60 },
			{ agent: "claude-code", model: "claude-opus-4-5", weight: 40 },
		]);
	}, 20_000);

	it("saves a mix-only project with no default worker agent", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				// No worker.agent — the mix resolves the worker harness on its own.
				orchestrator: { agent: "claude-code" },
				workerMix: [{ agent: "codex", weight: 100 }],
			},
		});

		renderSettings();

		// The worker-agent-required error must NOT appear when a valid mix exists.
		await screen.findByLabelText("Row 1 percentage");
		expect(screen.queryByText("Worker and orchestrator agents are required.")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0]?.[1]?.body;
		expect(body.config.workerMix).toEqual([{ agent: "codex", weight: 100 }]);
	}, 20_000);

	it("blocks save when the worker mix does not sum to 100", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				worker: { agent: "codex" },
				orchestrator: { agent: "claude-code" },
			},
		});

		renderSettings();

		await userEvent.click(await screen.findByRole("button", { name: "Add row" }));
		await userEvent.type(screen.getByLabelText("Row 1 percentage"), "70");
		await chooseOption(screen.getByRole("combobox", { name: "Row 1 agent" }), "Codex");

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(
			await screen.findByText("Worker mix percentages must sum to 100% and every row needs an agent."),
		).toBeInTheDocument();
		expect(putMock).not.toHaveBeenCalled();
	}, 20_000);

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
				orchestrator: { agent: "claude-code" },
			},
		});
		putMock.mockResolvedValue({
			data: undefined,
			error: { message: "invalid permissions" },
		});

		renderSettings();

		await userEvent.click(await screen.findByRole("button", { name: "Save changes" }));

		expect(await screen.findByText("invalid permissions")).toBeInTheDocument();
		expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
		expect(postMock).not.toHaveBeenCalled();
	});

	it("requires worker and orchestrator agents for existing projects missing role config", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {},
		});

		renderSettings();

		expect(await screen.findByText("Worker and orchestrator agents are required.")).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Default worker agent" })).toHaveTextContent("Select worker agent");
		expect(screen.getByRole("combobox", { name: "Default orchestrator agent" })).toHaveTextContent(
			"Select orchestrator agent",
		);

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(await screen.findAllByText("Worker and orchestrator agents are required.")).toHaveLength(2);
		expect(putMock).not.toHaveBeenCalled();
	});

	it("shows unknown-auth agents as selectable with a warning in project settings", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				worker: { agent: "codex" },
				orchestrator: { agent: "claude-code" },
			},
		});

		renderSettings();

		await waitFor(() => expect(screen.getAllByText("/repo/project-one").length).toBeGreaterThan(0));
		const workerAgent = screen.getByRole("combobox", { name: "Default worker agent" });
		await userEvent.click(workerAgent);
		const options = await screen.findAllByRole("option");
		expect(options.map((option) => option.textContent)).toEqual([
			"Claude Code",
			"Codex",
			"Goose",
			"OpenCode",
			"KiroAuth unknown",
		]);
		expect(options[4]).not.toHaveAttribute("aria-disabled", "true");
	});

	it("saves GitHub tracker intake settings, deriving the repo from the project's git origin", async () => {
		getMock.mockResolvedValue({
			data: {
				status: "ok",
				project: {
					id: "proj-1",
					name: "Project One",
					kind: "single_repo",
					path: "/repo/project-one",
					repo: "git@github.com:acme/project-one.git",
					defaultBranch: "main",
					config: {
						worker: { agent: "codex" },
						orchestrator: { agent: "claude-code" },
					},
				},
			},
			error: undefined,
		});

		renderSettings();

		await userEvent.click(await screen.findByLabelText("Enable issue intake"));

		// Repository is display-only, derived from the project's own git origin — no input to
		// fill. Assignee is the only eligibility rule in v1.
		expect(screen.getByRole("link", { name: "acme/project-one" })).toHaveAttribute(
			"href",
			"https://github.com/acme/project-one",
		);
		await userEvent.type(screen.getByLabelText("Assignee"), "octocat");

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0]?.[1]?.body;
		// An unconfigured project shows the default opt-out taxonomy pre-filled, so
		// saving persists it explicitly (issue #80).
		expect(body.config.trackerIntake).toEqual({
			enabled: true,
			provider: "github",
			assignee: "octocat",
			excludeLabels: ["no-ao", "deferred", "charter", "charter-audit", "human-review"],
		});
	});

	it("documents every ao issue label group beside tracker intake settings", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "git@github.com:acme/project-one.git",
			defaultBranch: "main",
			config: {
				worker: { agent: "codex" },
				orchestrator: { agent: "claude-code" },
			},
		});

		renderSettings();

		expect(await screen.findByRole("heading", { name: "Issue labels" })).toBeInTheDocument();
		expect(screen.getByText("Opt-out labels")).toBeInTheDocument();
		for (const label of ["no-ao", "deferred", "charter", "charter-audit", "human-review"]) {
			expect(screen.getByText(label)).toBeInTheDocument();
		}
		expect(screen.getByText("Agent routing labels")).toBeInTheDocument();
		for (const label of ["agent:codex", "agent:fugu", "agent:codex-fugu", "agent:claude"]) {
			expect(screen.getByText(label)).toBeInTheDocument();
		}
		expect(screen.getByText("Pool escape labels")).toBeInTheDocument();
		expect(screen.getByText("nopool")).toBeInTheDocument();
		expect(screen.getByText(/Opt-out labels are per-project settings with a global default/i)).toBeInTheDocument();
	});

	it("saves intake with no assignee (opt-out-by-default) and honors opt-out label edits", async () => {
		getMock.mockResolvedValue({
			data: {
				status: "ok",
				project: {
					id: "proj-1",
					name: "Project One",
					kind: "single_repo",
					path: "/repo/project-one",
					repo: "git@github.com:acme/project-one.git",
					defaultBranch: "main",
					config: {
						worker: { agent: "codex" },
						orchestrator: { agent: "claude-code" },
					},
				},
			},
			error: undefined,
		});

		renderSettings();

		await userEvent.click(await screen.findByLabelText("Enable issue intake"));
		// No assignee is required anymore. Remove one default and add a custom one
		// to prove the tag list is editable and round-trips.
		await userEvent.click(screen.getByRole("button", { name: "Remove deferred" }));
		await userEvent.type(screen.getByLabelText("Add opt-out label"), "wontfix{Enter}");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0]?.[1]?.body;
		expect(body.config.trackerIntake).toEqual({
			enabled: true,
			provider: "github",
			excludeLabels: ["no-ao", "charter", "charter-audit", "human-review", "wontfix"],
		});
	});

	it("clearing every opt-out label omits excludeLabels so the daemon restores defaults", async () => {
		getMock.mockResolvedValue({
			data: {
				status: "ok",
				project: {
					id: "proj-1",
					name: "Project One",
					kind: "single_repo",
					path: "/repo/project-one",
					repo: "git@github.com:acme/project-one.git",
					defaultBranch: "main",
					config: {
						worker: { agent: "codex" },
						orchestrator: { agent: "claude-code" },
						trackerIntake: {
							enabled: true,
							provider: "github",
							assignee: "octocat",
							excludeLabels: ["no-ao", "deferred"],
						},
					},
				},
			},
			error: undefined,
		});

		renderSettings();

		await userEvent.click(await screen.findByRole("button", { name: "Remove no-ao" }));
		await userEvent.click(screen.getByRole("button", { name: "Remove deferred" }));
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0]?.[1]?.body;
		// excludeLabels omitted → persisted as unset → daemon re-materializes the
		// default taxonomy (clearing restores default opt-out protection).
		expect(body.config.trackerIntake).toEqual({
			enabled: true,
			provider: "github",
			assignee: "octocat",
		});
	});

	it("preserves intake fields the form does not expose (maxConcurrent) across a save", async () => {
		getMock.mockResolvedValue({
			data: {
				status: "ok",
				project: {
					id: "proj-1",
					name: "Project One",
					kind: "single_repo",
					path: "/repo/project-one",
					repo: "git@github.com:acme/project-one.git",
					defaultBranch: "main",
					config: {
						worker: { agent: "codex" },
						orchestrator: { agent: "claude-code" },
						trackerIntake: {
							enabled: true,
							provider: "github",
							assignee: "octocat",
							maxConcurrent: 3,
							excludeLabels: ["no-ao"],
						},
					},
				},
			},
			error: undefined,
		});

		renderSettings();

		// Touch an unrelated field and save; the CLI-set maxConcurrent + the loaded
		// excludeLabels must survive rather than being wiped by the settings PUT.
		await userEvent.type(await screen.findByLabelText("Project prefix"), "ao");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0]?.[1]?.body;
		expect(body.config.trackerIntake).toEqual({
			enabled: true,
			provider: "github",
			assignee: "octocat",
			maxConcurrent: 3,
			excludeLabels: ["no-ao"],
		});
	});

	it("sends an explicit tracker intake disable sentinel when unchecked", async () => {
		getMock.mockResolvedValue({
			data: {
				status: "ok",
				project: {
					id: "proj-1",
					name: "Project One",
					kind: "single_repo",
					path: "/repo/project-one",
					repo: "git@github.com:acme/project-one.git",
					defaultBranch: "main",
					config: {
						worker: { agent: "codex" },
						orchestrator: { agent: "claude-code" },
						trackerIntake: {
							enabled: true,
							provider: "github",
							assignee: "octocat",
							maxConcurrent: 3,
							excludeLabels: ["no-ao"],
						},
					},
				},
			},
			error: undefined,
		});

		renderSettings();

		await userEvent.click(await screen.findByLabelText("Enable issue intake"));
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0]?.[1]?.body;
		expect(body.config.trackerIntake).toEqual({
			enabled: false,
			provider: "github",
			assignee: "octocat",
			maxConcurrent: 3,
			excludeLabels: ["no-ao"],
		});
	});

	it("restarts when the saved orchestrator agent already differs from the running orchestrator", async () => {
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
					config: {
						worker: { agent: "codex" },
						orchestrator: { agent: "goose" },
					},
				},
			},
			error: undefined,
		});

		renderSettings("proj-1", [
			{
				id: "proj-1",
				name: "Project One",
				path: "/repo/project-one",
				orchestratorAgent: "goose",
				sessions: [
					{
						id: "proj-1-orchestrator",
						workspaceId: "proj-1",
						workspaceName: "Project One",
						title: "Orchestrator",
						provider: "claude-code",
						kind: "orchestrator",
						branch: "ao/proj-1-orchestrator",
						status: "working",
						createdAt: "2026-07-03T00:00:00Z",
						updatedAt: "2026-07-03T00:00:00Z",
						prs: [],
					},
				],
			},
		]);

		const orchestratorAgent = await screen.findByRole("combobox", { name: "Default orchestrator agent" });
		expect(orchestratorAgent).toHaveTextContent("goose");

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/orchestrators", {
			body: { projectId: "proj-1", clean: true },
		});
	});

	it("keeps the config save successful when orchestrator replacement fails", async () => {
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
					config: {
						worker: { agent: "codex" },
						orchestrator: { agent: "claude-code" },
					},
				},
			},
			error: undefined,
		});
		postMock.mockResolvedValue({
			data: undefined,
			error: { message: "missing goose binary" },
			response: { status: 500 },
		});

		const queryClient = renderSettings();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const orchestratorAgent = await screen.findByRole("combobox", { name: "Default orchestrator agent" });
		await chooseOption(orchestratorAgent, "goose");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(await screen.findByText("Saved.")).toBeInTheDocument();
		expect(await screen.findByText("Orchestrator restart failed: missing goose binary")).toBeInTheDocument();
		expect(screen.queryByText("Save failed")).not.toBeInTheDocument();
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["project", "proj-1"] });
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: workspaceQueryKey });
	});
});
