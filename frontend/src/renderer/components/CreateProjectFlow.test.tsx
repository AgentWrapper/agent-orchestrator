import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentsQueryKey } from "../hooks/useAgentsQuery";
import { CreateProjectFlow, type CreateProjectInput } from "./CreateProjectFlow";

function codedError(message: string, code: string) {
	const error = new Error(message) as Error & { code: string };
	error.code = code;
	return error;
}

function renderFlow({
	onCreateProject,
	onInitializeProject,
}: {
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
			<CreateProjectFlow onCreateProject={onCreateProject} onInitializeProject={onInitializeProject}>
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

describe("CreateProjectFlow stable error control flow", () => {
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
});
