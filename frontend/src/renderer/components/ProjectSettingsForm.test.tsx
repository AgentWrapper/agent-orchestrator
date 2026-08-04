import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMock, putMock, postMock, navigateMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	putMock: vi.fn(),
	postMock: vi.fn(),
	navigateMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => navigateMock,
	};
});

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

function renderSettings(projectId = "proj-1", workspaces?: WorkspaceSummary[], section?: "general" | "agents" | "workflow" | "intake") {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	if (workspaces) {
		queryClient.setQueryData(workspaceQueryKey, workspaces);
	}
	render(
		<QueryClientProvider client={queryClient}>
			<ProjectSettingsForm projectId={projectId} section={section} />
		</QueryClientProvider>,
	);
	return queryClient;
}

async function chooseOption(trigger: HTMLElement, optionName: string) {
	await userEvent.click(trigger);
	const escaped = optionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	await userEvent.click(await screen.findByRole("menuitem", { name: new RegExp(escaped, "i") }));
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
		reviewerInstalled: [{ id: "greptile", label: "Greptile CLI", authStatus: "authorized" }],
	},
	error: undefined,
};

function mockProject(project: Record<string, unknown>) {
	getMock.mockImplementation(async (path: string) => {
		if (path === "/api/v1/agents") return agentCatalogResponse;
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
	navigateMock.mockReset();
	putMock.mockResolvedValue({ data: { project: {} }, error: undefined });
	postMock.mockResolvedValue({
		data: { orchestrator: { id: "proj-1-orch-2" } },
		error: undefined,
		response: { status: 200 },
	});
});

describe("ProjectSettingsForm", () => {
	it("does not have its own close button (dialog handles closing)", async () => {
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
		await screen.findByText("Identity");

		// Close button is now in SettingsDialog, not in the form itself
		expect(screen.queryByRole("button", { name: "Close settings" })).not.toBeInTheDocument();
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("does not navigate on Escape (dialog handles closing)", async () => {
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
		await screen.findByText("Identity");

		await userEvent.keyboard("{Escape}");

		// Escape is handled by the Radix Dialog in SettingsDialog, not the form
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("atomically saves the project display name and config without changing its stable ID", async () => {
		mockProject({
			id: "tg_content_factory_5863f66be3",
			name: "tg_content_factory_5863f66be3",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "",
			defaultBranch: "main",
			config: {
				worker: { agent: "codex" },
				orchestrator: { agent: "claude-code" },
			},
		});

		renderSettings("tg_content_factory_5863f66be3");

		const projectName = await screen.findByLabelText("Project name");
		await userEvent.clear(projectName);
		await userEvent.type(projectName, "TG Content Factory");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		expect(putMock).toHaveBeenCalledWith("/api/v1/projects/{id}", {
			params: { path: { id: "tg_content_factory_5863f66be3" } },
			body: expect.objectContaining({ displayName: "TG Content Factory" }),
		});
		expect(screen.getByText("tg_content_factory_5863f66be3")).toBeInTheDocument();
	});

	it("loads agents fields and saves without dropping hidden workflow config", async () => {
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

		renderSettings("proj-1", undefined, "agents");

		expect(screen.queryByLabelText("Default branch")).not.toBeInTheDocument();
		expect(await screen.findByLabelText("Model override")).toHaveValue("claude-opus-4-5");

		const workerAgent = screen.getByRole("button", { name: "Default worker agent" });
		const orchestratorAgent = screen.getByRole("button", { name: "Default orchestrator agent" });
		const permissionMode = screen.getByRole("button", { name: "Permission mode" });
		expect(workerAgent).toHaveTextContent("codex");
		expect(orchestratorAgent).toHaveTextContent("claude-code");
		expect(permissionMode).toHaveTextContent("Auto");

		await userEvent.clear(screen.getByLabelText("Model override"));
		await userEvent.type(screen.getByLabelText("Model override"), "gpt-5-codex");
		await chooseOption(workerAgent, "OpenCode");
		await chooseOption(orchestratorAgent, "Goose");
		await userEvent.click(permissionMode);
		await userEvent.click(await screen.findByRole("menuitem", { name: "Bypass permissions" }));

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		expect(putMock).toHaveBeenCalledWith("/api/v1/projects/{id}", {
			params: { path: { id: "proj-1" } },
			body: {
				displayName: "Project One",
				config: expect.objectContaining({
					// Hidden workflow config is preserved
					defaultBranch: "develop",
					sessionPrefix: "po",
					env: { FOO: "bar" },
					reviewers: [{ harness: "claude-code" }],
					// Agents changes applied
					worker: {
						agent: "opencode",
						agentConfig: { model: "worker-model" },
					},
					orchestrator: { agent: "goose" },
					agentConfig: {
						model: "gpt-5-codex",
						permissions: "bypass-permissions",
					},
				}),
			},
		});
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(await screen.findByText("Saved.")).toBeInTheDocument();
	}, 20_000);

	it("loads workflow fields correctly", async () => {
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
				worker: { agent: "codex" },
				orchestrator: { agent: "claude-code" },
				reviewers: [{ harness: "claude-code" }],
			},
		});

		renderSettings("proj-1", undefined, "workflow");

		expect(await screen.findByLabelText("Default branch")).toHaveValue("develop");
		expect(screen.getByLabelText("Session prefix")).toHaveValue("po");
		const reviewerAgent = screen.getByRole("button", { name: "Default reviewer agent" });
		expect(reviewerAgent).toHaveTextContent("claude-code");
	});

	it("shows the daemon validation message when the atomic settings save fails", async () => {
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

		const projectName = await screen.findByLabelText("Project name");
		await userEvent.clear(projectName);
		await userEvent.type(projectName, "Updated Project");
		await userEvent.click(await screen.findByRole("button", { name: "Save changes" }));

		expect(await screen.findByText("invalid permissions")).toBeInTheDocument();
		expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
		expect(postMock).not.toHaveBeenCalled();
	});

	it("offers the reviewer-only Greptile CLI even though it is not a worker agent", async () => {
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
		renderSettings("proj-1", undefined, "workflow");

		const reviewerAgent = await screen.findByRole("button", { name: "Default reviewer agent" });
		await userEvent.click(reviewerAgent);
		const greptileOption = await screen.findByRole("menuitem", { name: /Greptile CLI/i });
		expect(greptileOption).not.toHaveAttribute("aria-disabled", "true");
		expect(greptileOption).not.toHaveTextContent("Auth unknown");
		await userEvent.click(greptileOption);
		expect(reviewerAgent).toHaveTextContent("Greptile CLI");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		expect(putMock).toHaveBeenCalledWith("/api/v1/projects/{id}", {
			params: { path: { id: "proj-1" } },
			body: {
				displayName: "Project One",
				config: {
					defaultBranch: "main",
					sessionPrefix: undefined,
					worker: { agent: "codex" },
					orchestrator: { agent: "claude-code" },
					agentConfig: undefined,
					reviewers: [{ harness: "greptile" }],
					trackerIntake: undefined,
				},
			},
		});
	});

	it("rejects a blank project name before sending the settings update", async () => {
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

		const projectName = await screen.findByLabelText("Project name");
		await userEvent.clear(projectName);
		await userEvent.type(projectName, "   ");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(await screen.findByText("Project name is required.")).toBeInTheDocument();
		expect(putMock).not.toHaveBeenCalled();
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

		renderSettings("proj-1", undefined, "agents");

		expect(await screen.findByText("Worker and orchestrator agents are required.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Default worker agent" })).toHaveTextContent("Select worker agent");
		expect(screen.getByRole("button", { name: "Default orchestrator agent" })).toHaveTextContent(
			"Select orchestrator agent",
		);

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(await screen.findAllByText("Worker and orchestrator agents are required.")).toHaveLength(2);
		expect(putMock).not.toHaveBeenCalled();
	});

	it("uses the localized default label for the project reviewer picker", async () => {
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

		renderSettings("proj-1", undefined, "workflow");

		const reviewerAgent = await screen.findByRole("button", { name: "Default reviewer agent" });
		expect(reviewerAgent).toHaveTextContent("Project default");

		await userEvent.click(reviewerAgent);
		expect(await screen.findByRole("menuitem", { name: "Project default" })).toBeInTheDocument();
	});

	it("disables agent selectors while the initial agent catalog is loading", async () => {
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/agents") {
				return new Promise(() => {});
			}
			return {
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
			};
		});

		renderSettings("proj-1", undefined, "agents");

		expect(await screen.findByRole("button", { name: "Default worker agent" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Default orchestrator agent" })).toBeDisabled();
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

		renderSettings("proj-1", undefined, "agents");

		const workerAgent = await screen.findByRole("button", { name: "Default worker agent" });
		await userEvent.click(workerAgent);
		const options = await screen.findAllByRole("menuitem");
		expect(options.map((option) => option.textContent)).toEqual([
			"Claude Code",
			"Codex",
			"OpenCode",
			"Goose",
			"KiroAuth unknown",
		]);
		expect(options[4]).not.toHaveAttribute("aria-disabled", "true");
	});

	it("shows scratch identity and saves only scratch-supported settings", async () => {
		mockProject({
			id: "scratch",
			name: "Scratch",
			kind: "scratch",
			path: "/home/me/.ao/scratch/default",
			repo: "",
			defaultBranch: "",
			config: {
				defaultBranch: "main",
				sessionPrefix: "ao",
				env: { FOO: "bar" },
				symlinks: [".env"],
				postCreate: ["npm install"],
				agentRules: "keep work small",
				worker: { agent: "codex" },
				orchestrator: { agent: "claude-code" },
				agentConfig: {
					model: "gpt-5-codex",
					permissions: "auto",
				},
				reviewers: [{ harness: "codex" }],
				trackerIntake: { enabled: true, provider: "github", assignee: "octocat" },
			},
		});

		renderSettings("scratch");

		const kindRow = (await screen.findByText("kind")).closest(".settings-row-bar");
		expect(kindRow).toHaveTextContent("scratch");
		expect(screen.queryByLabelText("Default branch")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Session prefix")).not.toBeInTheDocument();
		expect(screen.queryByText("Reviewers")).not.toBeInTheDocument();
		expect(screen.queryByText("Tracker intake")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		expect(putMock).toHaveBeenCalledWith("/api/v1/projects/{id}", {
			params: { path: { id: "scratch" } },
			body: {
				displayName: "Scratch",
				config: {
					env: { FOO: "bar" },
					sessionPrefix: "ao",
					symlinks: [".env"],
					postCreate: ["npm install"],
					agentRules: "keep work small",
					worker: { agent: "codex" },
					orchestrator: { agent: "claude-code" },
					agentConfig: {
						model: "gpt-5-codex",
						permissions: "auto",
					},
				},
			},
		});
		expect(postMock).not.toHaveBeenCalled();
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

		renderSettings("proj-1", undefined, "intake");

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
		expect(body.config.trackerIntake).toEqual({
			enabled: true,
			provider: "github",
			assignee: "octocat",
		});
	});

	it("blocks save when intake is enabled with no assignee", async () => {
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

		renderSettings("proj-1", undefined, "intake");

		await userEvent.click(await screen.findByLabelText("Enable issue intake"));
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(await screen.findAllByText("Enabling intake requires an assignee.")).toHaveLength(2);
		expect(putMock).not.toHaveBeenCalled();
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
		], "agents");

		const orchestratorAgent = await screen.findByRole("button", { name: "Default orchestrator agent" });
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

		const queryClient = renderSettings("proj-1", undefined, "agents");
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const orchestratorAgent = await screen.findByRole("button", { name: "Default orchestrator agent" });
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
