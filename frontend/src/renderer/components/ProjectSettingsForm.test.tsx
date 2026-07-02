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

	it("defaults worker and orchestrator to claude-code for projects missing role config", async () => {
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

		const workerAgent = await screen.findByRole("combobox", { name: "Default worker agent" });
		const orchestratorAgent = screen.getByRole("combobox", { name: "Default orchestrator agent" });
		expect(workerAgent).toHaveTextContent("claude-code");
		expect(orchestratorAgent).toHaveTextContent("claude-code");
		expect(screen.queryByText("Worker and orchestrator agents are required.")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		expect(putMock).toHaveBeenCalledWith("/api/v1/projects/{id}/config", {
			params: { path: { id: "proj-1" } },
			body: {
				config: {
					defaultBranch: "main",
					worker: { agent: "claude-code" },
					orchestrator: { agent: "claude-code" },
				},
			},
		});
		expect(await screen.findByText("Saved.")).toBeInTheDocument();
	});
});
