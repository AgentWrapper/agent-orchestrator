import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMock, putMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	putMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: getMock,
		PUT: putMock,
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

beforeEach(() => {
	getMock.mockReset();
	putMock.mockReset();
	putMock.mockResolvedValue({ data: { project: {} }, error: undefined });
});

describe("ProjectSettingsForm", () => {
	it("loads the current project settings and saves the exposed fields without dropping hidden config", async () => {
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
				},
			},
			error: undefined,
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
		await chooseOption(workerAgent, "opencode");
		await chooseOption(orchestratorAgent, "goose");
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
		expect(await screen.findByText("Saved.")).toBeInTheDocument();
	}, 20_000);

	it("shows the daemon validation message when save fails", async () => {
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
		expect(screen.getByRole("combobox", { name: "Default worker agent" })).toHaveTextContent("Select worker agent");
		expect(screen.getByRole("combobox", { name: "Default orchestrator agent" })).toHaveTextContent(
			"Select orchestrator agent",
		);

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(await screen.findAllByText("Worker and orchestrator agents are required.")).toHaveLength(2);
		expect(putMock).not.toHaveBeenCalled();
	});

	it("enables tracker intake and saves a structured rule from the form", async () => {
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
		await userEvent.type(screen.getByLabelText("Labels"), "agent-ready, bug");
		await userEvent.type(screen.getByLabelText("Per-poll limit"), "5");

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0][1].body.config;
		expect(body.trackerIntake).toEqual({
			enabled: true,
			provider: "github",
			labels: ["agent-ready", "bug"],
			limit: 5,
		});
	});

	it("loads an existing tracker intake rule and preserves it on save", async () => {
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
							repo: "acme/project-one",
							labels: ["agent-ready", "bug"],
							assignee: "alice",
							limit: 7,
						},
					},
				},
			},
			error: undefined,
		});

		renderSettings();

		expect(await screen.findByLabelText("Enable issue intake")).toBeChecked();
		expect(screen.getByLabelText("Repository")).toHaveValue("acme/project-one");
		expect(screen.getByLabelText("Labels")).toHaveValue("agent-ready, bug");
		expect(screen.getByLabelText("Assignee")).toHaveValue("alice");
		expect(screen.getByLabelText("Per-poll limit")).toHaveValue(7);

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0][1].body.config;
		expect(body.trackerIntake).toEqual({
			enabled: true,
			provider: "github",
			repo: "acme/project-one",
			labels: ["agent-ready", "bug"],
			assignee: "alice",
			limit: 7,
		});
	});

	it("saves a Linear intake rule with team key", async () => {
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

		renderSettings();

		await userEvent.click(await screen.findByLabelText("Enable issue intake"));
		await chooseOption(screen.getByRole("combobox", { name: "Provider" }), "Linear");
		await userEvent.type(screen.getByLabelText("Team key"), "ENG");
		await userEvent.type(screen.getByLabelText("Labels"), "agent-ready");

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0][1].body.config;
		expect(body.trackerIntake).toEqual({
			enabled: true,
			provider: "linear",
			team: "ENG",
			labels: ["agent-ready"],
		});
	});

	it("saves a Jira intake rule with site URL and project key", async () => {
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

		renderSettings();

		await userEvent.click(await screen.findByLabelText("Enable issue intake"));
		await chooseOption(screen.getByRole("combobox", { name: "Provider" }), "Jira");
		await userEvent.type(screen.getByLabelText("Site URL"), "acme.atlassian.net");
		await userEvent.type(screen.getByLabelText("Project key"), "ENG");
		await userEvent.type(screen.getByLabelText("Labels"), "agent-ready");

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		const body = putMock.mock.calls[0][1].body.config;
		expect(body.trackerIntake).toEqual({
			enabled: true,
			provider: "jira",
			baseURL: "acme.atlassian.net",
			projectKey: "ENG",
			labels: ["agent-ready"],
		});
	});

	it("blocks saving Linear intake without a team key", async () => {
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

		renderSettings();

		await userEvent.click(await screen.findByLabelText("Enable issue intake"));
		await chooseOption(screen.getByRole("combobox", { name: "Provider" }), "Linear");
		await userEvent.type(screen.getByLabelText("Labels"), "agent-ready");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(await screen.findAllByText("Linear intake requires a team key.")).not.toHaveLength(0);
		expect(putMock).not.toHaveBeenCalled();
	});

	it("blocks saving Jira intake without site URL and project key", async () => {
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

		renderSettings();

		await userEvent.click(await screen.findByLabelText("Enable issue intake"));
		await chooseOption(screen.getByRole("combobox", { name: "Provider" }), "Jira");
		await userEvent.type(screen.getByLabelText("Labels"), "agent-ready");
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(await screen.findAllByText("Jira intake requires a site URL and project key.")).not.toHaveLength(0);
		expect(putMock).not.toHaveBeenCalled();
	});

	it("blocks saving when intake is enabled without a label or assignee", async () => {
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

		renderSettings();

		await userEvent.click(await screen.findByLabelText("Enable issue intake"));
		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		expect(await screen.findAllByText("Enabling intake requires at least one label or assignee.")).not.toHaveLength(0);
		expect(putMock).not.toHaveBeenCalled();
	});
});
