import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
import { buildIntake, deriveGitHubRepo } from "./IntakeFields";
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
		queryClient.setQueryData(workspaceQueryKey, workspaces);
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

function mockProject(project: Record<string, unknown>) {
	getMock.mockImplementation(async (path: string) => {
		if (path === "/api/v1/agents") return agentCatalogResponse;
		if (path === "/api/v1/tracker-intake/github/user") {
			return { data: { login: "octocat" }, error: undefined };
		}
		if (path === "/api/v1/projects/{id}/tracker-intake/github/labels") {
			return {
				data: {
					labels: [
						{ name: "bug", color: "d73a4a", description: "Something is broken" },
						{ name: "ready", color: "4d8dff", description: "Ready for an agent" },
					],
				},
				error: undefined,
			};
		}
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
	postMock.mockImplementation(async (path: string) => {
		if (path === "/api/v1/projects/{id}/tracker-intake/github/preview") {
			return { data: { count: 3 }, error: undefined, response: { status: 200 } };
		}
		return {
			data: { orchestrator: { id: "proj-1-orch-2" } },
			error: undefined,
			response: { status: 200 },
		};
	});
});

describe("ProjectSettingsForm", () => {
	it("derives intake repos only from GitHub origins", () => {
		expect(deriveGitHubRepo("https://github.com/acme/project-one.git")).toBe("acme/project-one");
		expect(deriveGitHubRepo("alice@github.com:acme/project-one.git")).toBe("acme/project-one");
		expect(deriveGitHubRepo("github.com:acme/project-one.git")).toBe("acme/project-one");
		expect(deriveGitHubRepo("alice@gitlab.com:acme/project-one.git")).toBeUndefined();
		expect(deriveGitHubRepo("gitlab.com:acme/project-one.git")).toBeUndefined();
		expect(deriveGitHubRepo("acme/project-one")).toBeUndefined();
	});

	it("clears tracker intake config when disabled", () => {
		expect(buildIntake({ enabled: false, repo: "acme/demo", labels: ["bug"] })).toBeUndefined();
	});

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

		renderSettings();

		expect(await screen.findByText("git@github.com:acme/project-one.git")).toBeInTheDocument();
		expect(screen.getByLabelText("Default branch")).toHaveValue("develop");
		expect(screen.getByLabelText("Session prefix")).toHaveValue("po");
		expect(screen.getByLabelText("Model override")).toHaveValue("claude-opus-4-5");

		const workerAgent = screen.getByRole("combobox", { name: "Default worker agent" });
		const orchestratorAgent = screen.getByRole("combobox", { name: "Default orchestrator agent" });
		const permissionMode = screen.getByRole("combobox", { name: "Permission mode" });
		const reviewerAgent = screen.getByRole("combobox", { name: "Default reviewer agent" });
		expect(workerAgent).toHaveTextContent("codex");
		expect(orchestratorAgent).toHaveTextContent("claude-code");
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
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/orchestrators", {
			body: { projectId: "proj-1", clean: true },
		});
		expect(await screen.findByText("Saved.")).toBeInTheDocument();
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
			"OpenCode",
			"Goose",
			"KiroAuth unknown",
		]);
		expect(options[4]).not.toHaveAttribute("aria-disabled", "true");
	});

	it("saves GitHub tracker intake settings, deriving the repo from the project's git origin", async () => {
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

		await userEvent.click(await screen.findByLabelText("Enable issue intake"));

		// Repository and assignee are both display-only links in one compact row.
		const repositoryLink = screen.getByRole("link", { name: "acme/project-one" });
		expect(repositoryLink).toHaveAttribute("href", "https://github.com/acme/project-one");
		const assigneeLink = await screen.findByRole("link", { name: "octocat" });
		expect(assigneeLink).toHaveAttribute("href", "https://github.com/octocat");
		expect(repositoryLink.parentElement?.parentElement).toHaveClass("grid-cols-2");
		await userEvent.click(screen.getByRole("button", { name: "Labels" }));
		await userEvent.click(await screen.findByRole("option", { name: /bug/i }));
		await userEvent.click(screen.getByRole("option", { name: /ready/i }));
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.getByText("Matching open issues").parentElement).toHaveTextContent("3"));
		expect(screen.getByText("3")).toHaveClass("rounded-full");
		expect(postMock).toHaveBeenCalledWith("/api/v1/projects/{id}/tracker-intake/github/preview", {
			params: { path: { id: "proj-1" } },
			body: { labels: ["bug", "ready"] },
		});

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0]?.[1]?.body;
		expect(body.config.trackerIntake).toEqual({
			enabled: true,
			provider: "github",
			labels: ["bug", "ready"],
		});
	});

	it("does not persist stale labels after selecting labels and disabling intake", async () => {
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

		const intakeToggle = await screen.findByLabelText("Enable issue intake");
		await userEvent.click(intakeToggle);
		await userEvent.click(screen.getByRole("button", { name: "Labels" }));
		await userEvent.click(await screen.findByRole("option", { name: /bug/i }));
		await userEvent.keyboard("{Escape}");
		await userEvent.click(intakeToggle);
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0]?.[1]?.body;
		expect(body.config.trackerIntake).toBeUndefined();
	});

	it("does not render a GitHub repository link for non-GitHub remotes", async () => {
		mockProject({
			id: "proj-1",
			name: "Project One",
			kind: "single_repo",
			path: "/repo/project-one",
			repo: "alice@gitlab.com:acme/project-one.git",
			defaultBranch: "main",
			config: {
				worker: { agent: "codex" },
				orchestrator: { agent: "claude-code" },
			},
		});

		renderSettings();

		await userEvent.click(await screen.findByLabelText("Enable issue intake"));

		expect(screen.queryByRole("link", { name: "acme/project-one" })).not.toBeInTheDocument();
		expect(screen.getByText("Could not detect a GitHub repo from this project's git origin.")).toBeInTheDocument();
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
