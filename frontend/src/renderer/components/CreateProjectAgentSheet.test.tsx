import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsQueryKey } from "../hooks/useAgentsQuery";
import { initializeRendererI18n } from "../i18n";
import { CreateProjectAgentSheet, RequiredAgentField } from "./CreateProjectAgentSheet";

const { deleteMock, getMock, postMock, putMock } = vi.hoisted(() => ({
	deleteMock: vi.fn(),
	getMock: vi.fn(),
	postMock: vi.fn(),
	putMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { DELETE: deleteMock, GET: getMock, POST: postMock, PUT: putMock },
	apiErrorCode: (error: unknown) =>
		typeof error === "object" && error !== null && "code" in error
			? String((error as { code: unknown }).code)
			: undefined,
	apiErrorMessage: (error: unknown) =>
		typeof error === "object" && error !== null && "message" in error
			? String((error as { message: unknown }).message)
			: "Request failed",
}));

const gitlabConnection = {
	id: "gitlab-main",
	provider: "gitlab" as const,
	displayName: "GitLab Main",
	webBaseUrl: "https://gitlab.example.com",
	apiBaseUrl: "https://gitlab.example.com/api/v4",
	credentialConfigured: true,
	status: "unknown" as const,
};

beforeEach(() => {
	getMock.mockReset();
	postMock.mockReset();
	putMock.mockReset();
	deleteMock.mockReset();
	getMock.mockResolvedValue({ data: { connections: [gitlabConnection] }, error: undefined });
});

function renderSheet(
	onSubmit = vi.fn().mockResolvedValue(undefined),
	props: {
		error?: string;
		errorCode?: string;
		isCreating?: boolean;
		isInitializing?: boolean;
		kind?: "single_repo" | "workspace";
		origin?: string;
		repositorySetupNeeded?: boolean;
	} = {},
) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClient.setQueryData(agentsQueryKey, {
		supported: [
			{ id: "claude-code", label: "claude-code" },
			{ id: "codex", label: "codex" },
		],
		installed: [
			{ id: "claude-code", label: "claude-code", authStatus: "authorized" },
			{ id: "codex", label: "codex", authStatus: "authorized" },
		],
		authorized: [
			{ id: "claude-code", label: "claude-code", authStatus: "authorized" },
			{ id: "codex", label: "codex", authStatus: "authorized" },
		],
	});
	render(
		<QueryClientProvider client={queryClient}>
			<CreateProjectAgentSheet
				error={props.error}
				errorCode={props.errorCode}
				isCreating={props.isCreating ?? false}
				isInitializing={props.isInitializing}
				kind={props.kind ?? "single_repo"}
				onOpenChange={() => undefined}
				onSubmit={onSubmit}
				open={true}
				origin={props.origin}
				path="/repo/new-project"
				repositorySetupNeeded={props.repositorySetupNeeded}
			/>
		</QueryClientProvider>,
	);
	return onSubmit;
}

afterEach(async () => {
	await initializeRendererI18n("en");
});

async function chooseOption(trigger: HTMLElement, optionName: string) {
	await userEvent.click(trigger);
	await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

describe("CreateProjectAgentSheet", () => {
	it("localizes project-agent controls while preserving path and agent names", async () => {
		await initializeRendererI18n("zh-CN");
		renderSheet(undefined, { repositorySetupNeeded: true });

		expect(screen.getByRole("dialog", { name: "项目智能体" })).toBeInTheDocument();
		expect(screen.getByText("/repo/new-project")).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "工作智能体" })).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "协调智能体" })).toBeInTheDocument();
		expect(screen.getByLabelText("自动唤醒空闲协调器")).toBeInTheDocument();
		expect(screen.getByText(/如果此文件夹需要 Git 初始化/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "创建并启动" })).toBeInTheDocument();
	});

	it("uses a stable error code for localized guidance and keeps raw detail unchanged", async () => {
		await initializeRendererI18n("zh-CN");
		renderSheet(undefined, {
			errorCode: "PROJECT_PATH_NOT_REPO_ROOT",
			error: "服务器返回：目录位于父仓库中",
		});

		expect(screen.getByText("请选择仓库根目录")).toBeInTheDocument();
		expect(screen.getByText("此文件夹位于另一个 Git 仓库内。请选择顶层文件夹后重试。")).toBeInTheDocument();
		expect(screen.getByText("服务器返回：目录位于父仓库中")).toBeInTheDocument();
	});

	it("does not parse setup prefixes or trailing codes out of display text", () => {
		const raw = "Setup failed: raw detail (PROJECT_BARE_REPOSITORY)";
		renderSheet(undefined, { error: raw });

		expect(screen.getByText("Could not create project")).toBeInTheDocument();
		expect(screen.getByText(raw)).toBeInTheDocument();
		expect(screen.queryByText("Choose a normal checkout")).not.toBeInTheDocument();
	});

	it("renders agent refresh failures from the current locale instead of a cached message", async () => {
		postMock.mockRejectedValueOnce(new Error("cached English refresh failure"));
		renderSheet();

		await userEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
		expect(await screen.findByText("Could not refresh agent catalog.")).toBeInTheDocument();
		expect(screen.queryByText("cached English refresh failure")).not.toBeInTheDocument();

		await act(async () => {
			await initializeRendererI18n("zh-CN");
		});
		expect(screen.getByText("无法刷新智能体目录。")).toBeInTheDocument();
	});

	it("uses the compact trigger size for agent fields", () => {
		render(
			<RequiredAgentField
				id="agent"
				label="Agent"
				onChange={() => undefined}
				placeholder="Project default"
				value="claude-code"
			/>,
		);

		expect(screen.getByLabelText("Agent")).toHaveAttribute("data-size", "sm");
	});

	it("caps the agent menu height with a theme token", async () => {
		render(
			<RequiredAgentField id="agent" label="Agent" onChange={() => undefined} placeholder="Project default" value="" />,
		);

		await userEvent.click(screen.getByLabelText("Agent"));

		expect(await screen.findByRole("listbox")).toHaveClass("max-h-select-menu-max!");
	});

	it("creates without intake when the toggle is left off", async () => {
		const onSubmit = renderSheet();
		await chooseOption(screen.getByLabelText("Worker agent"), "claude-code");
		await chooseOption(screen.getByLabelText("Orchestrator agent"), "codex");

		await userEvent.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit).toHaveBeenCalledWith({
			workerAgent: "claude-code",
			orchestratorAgent: "codex",
			trackerIntake: undefined,
		});
	});

	it("allows a new project to opt into coordinator auto-wake", async () => {
		const onSubmit = renderSheet();
		await chooseOption(screen.getByLabelText("Worker agent"), "claude-code");
		await chooseOption(screen.getByLabelText("Orchestrator agent"), "codex");
		await userEvent.click(screen.getByLabelText("Automatically wake idle coordinator"));

		await userEvent.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit).toHaveBeenCalledWith({
			workerAgent: "claude-code",
			orchestratorAgent: "codex",
			coordinator: { autoWake: true },
			trackerIntake: undefined,
		});
	});

	it("blocks submit when intake is enabled with no assignee, then passes the intake payload once one is set", async () => {
		const onSubmit = renderSheet();
		await chooseOption(screen.getByLabelText("Worker agent"), "claude-code");
		await chooseOption(screen.getByLabelText("Orchestrator agent"), "codex");

		await userEvent.click(screen.getByLabelText("Enable issue intake"));
		// Enabled with no eligibility rule → submit stays disabled (compact sheet
		// carries no inline guard prose; gating is the disabled button).
		expect(screen.getByRole("button", { name: "Create and start" })).toBeDisabled();

		await userEvent.type(screen.getByLabelText("Assignee"), "octocat");
		await userEvent.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit).toHaveBeenCalledWith({
			workerAgent: "claude-code",
			orchestratorAgent: "codex",
			trackerIntake: { enabled: true, provider: "github", assignee: "octocat" },
		});
	});

	it("creates a project with an explicitly tested project-level GitLab connection", async () => {
		postMock.mockResolvedValue({
			data: {
				result: {
					status: "connected",
					identity: { username: "alice" },
					capabilities: { read: true, write: true },
				},
			},
			error: undefined,
		});
		const onSubmit = renderSheet();
		await chooseOption(screen.getByLabelText("Worker agent"), "claude-code");
		await chooseOption(screen.getByLabelText("Orchestrator agent"), "codex");
		await chooseOption(screen.getByLabelText("Provider"), "GitLab");
		await userEvent.type(screen.getByLabelText("Repository"), "group/subgroup/app");

		expect(screen.getByRole("button", { name: "Create and start" })).toBeDisabled();
		await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
		expect(await screen.findByText("Connected as alice")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit).toHaveBeenCalledWith({
			workerAgent: "claude-code",
			orchestratorAgent: "codex",
			scm: { provider: "gitlab", connectionId: "gitlab-main", repo: "group/subgroup/app" },
			trackerIntake: undefined,
		});
	});

	it("keeps the intake controls minimal while exposing the project-level SCM repository", async () => {
		renderSheet();
		// Info affordance is present even before enabling; the descriptive prose is not.
		expect(screen.getByLabelText("What does enabling issue intake do?")).toBeInTheDocument();
		expect(screen.queryByText(/Auto-spawn worker sessions from matching tracker issues/)).not.toBeInTheDocument();

		await userEvent.click(screen.getByLabelText("Enable issue intake"));
		expect(screen.getByLabelText("Repository")).toBeInTheDocument();
		expect(screen.queryByText(/Reads credentials from/)).not.toBeInTheDocument();
	});

	it("derives the repository from the selected folder origin", () => {
		renderSheet(undefined, { origin: "git@github.com:acme/new-project.git" });

		expect(screen.getByLabelText("Repository")).toHaveAttribute("placeholder", "acme/new-project");
	});
});
