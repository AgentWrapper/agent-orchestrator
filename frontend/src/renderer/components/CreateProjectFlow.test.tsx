import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsQueryKey } from "../hooks/useAgentsQuery";
import { i18n, initializeRendererI18n } from "../i18n";
import { CreateProjectFlow, type CreateProjectInput } from "./CreateProjectFlow";

function codedError(message: string, code: string) {
	const error = new Error(message) as Error & { code: string };
	error.code = code;
	return error;
}

function renderFlow({
	mode = "single_repo",
	onCreateProject,
	onInitializeProject,
}: {
	mode?: "choose" | "single_repo" | "workspace";
	onCreateProject: (input: CreateProjectInput) => Promise<void>;
	onInitializeProject: (path: string) => Promise<void>;
}) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClient.setQueryData(agentsQueryKey, {
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
	return render(
		<QueryClientProvider client={queryClient}>
			<CreateProjectFlow mode={mode} onCreateProject={onCreateProject} onInitializeProject={onInitializeProject}>
				{({ choosePath, disabled, label }) => (
					<button type="button" disabled={disabled} onClick={choosePath}>
						{label}
					</button>
				)}
			</CreateProjectFlow>
		</QueryClientProvider>,
	);
}

async function chooseAgent(trigger: HTMLElement, optionName: string) {
	await userEvent.click(trigger);
	await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

beforeEach(() => {
	window.ao!.remoteServer.isRemoteClient = vi.fn().mockResolvedValue(false);
	window.ao!.app.chooseDirectory = vi.fn().mockResolvedValue("/repo/project");
	window.ao!.app.scanImportFolder = vi.fn().mockResolvedValue({
		path: "/repo/project",
		repos: [
			{
				name: "project",
				path: "/repo/project",
				relativePath: ".",
				branch: "main",
				remote: "origin",
				hasRemote: true,
				status: "ok",
			},
		],
	});
});

afterEach(async () => {
	await initializeRendererI18n("en");
});

describe("CreateProjectFlow stable error control flow", () => {
	it("uses the scanner setup code instead of its localized reason", async () => {
		window.ao!.app.scanImportFolder = vi.fn().mockResolvedValue({
			path: "/repo/project",
			repos: [
				{
					name: "project",
					path: "/repo/project",
					relativePath: ".",
					branch: "HEAD",
					remote: "",
					hasRemote: false,
					status: "error",
					setupCode: "PROJECT_UNBORN",
					reason: "该仓库还没有提交",
				},
			],
		});
		const onCreateProject = vi.fn().mockResolvedValue(undefined);
		const onInitializeProject = vi.fn().mockResolvedValue(undefined);
		renderFlow({ onCreateProject, onInitializeProject });

		await userEvent.click(screen.getByRole("button", { name: "New project" }));
		await chooseAgent(screen.getByRole("combobox", { name: "Worker agent" }), "Codex");
		await chooseAgent(screen.getByRole("combobox", { name: "Orchestrator agent" }), "Claude Code");
		await userEvent.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() => expect(onInitializeProject).toHaveBeenCalledWith("/repo/project"));
		expect(onCreateProject).toHaveBeenCalledTimes(1);
	});

	it("does not infer setup from an English scanner reason without a stable code", async () => {
		window.ao!.app.scanImportFolder = vi.fn().mockResolvedValue({
			path: "/repo/project",
			repos: [
				{
					name: "project",
					path: "/repo/project",
					relativePath: ".",
					branch: "HEAD",
					remote: "",
					hasRemote: false,
					status: "error",
					reason: "Repository must have at least one commit.",
				},
			],
		});
		const onCreateProject = vi.fn().mockResolvedValue(undefined);
		const onInitializeProject = vi.fn().mockResolvedValue(undefined);
		renderFlow({ onCreateProject, onInitializeProject });

		await userEvent.click(screen.getByRole("button", { name: "New project" }));
		await chooseAgent(screen.getByRole("combobox", { name: "Worker agent" }), "Codex");
		await chooseAgent(screen.getByRole("combobox", { name: "Orchestrator agent" }), "Claude Code");
		await userEvent.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(1));
		expect(onInitializeProject).not.toHaveBeenCalled();
	});

	it("does not initialize a bare repository scan without the unborn setup code", async () => {
		window.ao!.app.scanImportFolder = vi.fn().mockResolvedValue({
			path: "/repo/project.git",
			repos: [
				{
					name: "project.git",
					path: "/repo/project.git",
					relativePath: ".",
					branch: "HEAD",
					remote: "",
					hasRemote: false,
					status: "error",
					reason: "Bare repositories cannot be imported.",
				},
			],
		});
		window.ao!.app.chooseDirectory = vi.fn().mockResolvedValue("/repo/project.git");
		const onCreateProject = vi.fn().mockResolvedValue(undefined);
		const onInitializeProject = vi.fn().mockResolvedValue(undefined);
		renderFlow({ onCreateProject, onInitializeProject });

		await userEvent.click(screen.getByRole("button", { name: "New project" }));
		await chooseAgent(screen.getByRole("combobox", { name: "Worker agent" }), "Codex");
		await chooseAgent(screen.getByRole("combobox", { name: "Orchestrator agent" }), "Claude Code");
		await userEvent.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(1));
		expect(onInitializeProject).not.toHaveBeenCalled();
	});

	it("switches its application-owned project copy to Simplified Chinese", async () => {
		await initializeRendererI18n("zh-CN");
		renderFlow({
			onCreateProject: vi.fn().mockResolvedValue(undefined),
			onInitializeProject: vi.fn().mockResolvedValue(undefined),
		});

		expect(screen.getByRole("button", { name: "新建项目" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
		expect(await screen.findByRole("dialog", { name: "项目智能体" })).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "工作智能体" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "创建并启动" })).toBeInTheDocument();
		expect(screen.getByText("/repo/project")).toBeInTheDocument();
	});

	it("passes the selected local repository origin to the project agent sheet", async () => {
		window.ao!.app.scanImportFolder = vi.fn().mockResolvedValue({
			path: "/repo/project",
			repos: [
				{
					name: "project",
					path: "/repo/project",
					relativePath: ".",
					branch: "main",
					remote: "git@github.com:acme/project.git",
					hasRemote: true,
					status: "ok",
				},
			],
		});
		renderFlow({
			onCreateProject: vi.fn().mockResolvedValue(undefined),
			onInitializeProject: vi.fn().mockResolvedValue(undefined),
		});

		await userEvent.click(screen.getByRole("button", { name: "New project" }));

		expect(await screen.findByLabelText("Repository")).toHaveAttribute("placeholder", "acme/project");
	});

	it.each([
		["NOT_A_GIT_REPO", "该目录不是 Git 仓库"],
		["PROJECT_UNBORN", "该仓库还没有提交"],
	] as const)("recovers from %s without parsing its localized message", async (code, message) => {
		const onCreateProject = vi.fn().mockRejectedValueOnce(codedError(message, code)).mockResolvedValueOnce(undefined);
		const onInitializeProject = vi.fn().mockResolvedValue(undefined);
		renderFlow({ onCreateProject, onInitializeProject });
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: "New project" }));
		await screen.findByRole("dialog", { name: "Project agents" });
		await chooseAgent(screen.getByRole("combobox", { name: "Worker agent" }), "Codex");
		await chooseAgent(screen.getByRole("combobox", { name: "Orchestrator agent" }), "Claude Code");
		await user.click(screen.getByRole("button", { name: "Create and start" }));

		expect((await screen.findAllByText(message)).length).toBeGreaterThan(0);
		expect(screen.getByText(/If this folder needs Git setup/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() => expect(onInitializeProject).toHaveBeenCalledWith("/repo/project"));
		await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(2));
	});

	it("renders a stable repository validation code in the current language", async () => {
		window.ao!.app.scanImportFolder = vi.fn().mockResolvedValue({
			path: "/repo/project",
			repos: [
				{
					name: "project",
					path: "/repo/project",
					relativePath: ".",
					branch: "main",
					remote: "",
					hasRemote: false,
					status: "error",
					reasonCode: "NO_ORIGIN_REMOTE",
					reason: "Origin remote is required.",
				},
			],
		});
		const onCreateProject = vi
			.fn()
			.mockRejectedValueOnce(codedError("Workspace registration failed", "WORKSPACE_CHILD_ORIGIN_REQUIRED"));
		renderFlow({
			mode: "choose",
			onCreateProject,
			onInitializeProject: vi.fn().mockResolvedValue(undefined),
		});

		await userEvent.click(screen.getByRole("button", { name: "New project" }));
		await userEvent.click(await screen.findByRole("button", { name: /^Project/ }));
		await chooseAgent(await screen.findByRole("combobox", { name: "Worker agent" }), "Codex");
		await chooseAgent(screen.getByRole("combobox", { name: "Orchestrator agent" }), "Claude Code");
		await userEvent.click(screen.getByRole("button", { name: "Create and start" }));

		expect(await screen.findByText("Origin remote is required.")).toBeInTheDocument();
		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("必须配置 origin 远程仓库。")).toBeInTheDocument();
		expect(screen.queryByText("Origin remote is required.")).not.toBeInTheDocument();
	});
});
