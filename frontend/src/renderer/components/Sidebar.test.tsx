import { SidebarProvider } from "@/components/ui/sidebar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";
import { agentsQueryKey } from "../hooks/useAgentsQuery";
import { useUiStore } from "../stores/ui-store";

const { getMock, navigateMock, mockParams, renameSessionMock, updateStatusMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	navigateMock: vi.fn(),
	mockParams: { projectId: undefined as string | undefined },
	renameSessionMock: vi.fn().mockResolvedValue(undefined),
	updateStatusMock: vi.fn(),
}));

vi.mock("../lib/rename-session", () => ({ renameSession: renameSessionMock }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => navigateMock,
		useParams: () => ({}),
		useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
			select({ location: { pathname: "/" } }),
	};
});

vi.mock("../lib/bridge", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/bridge")>();
	return {
		aoBridge: {
			...actual.aoBridge,
			updates: { ...actual.aoBridge.updates, getStatus: updateStatusMock },
		},
	};
});

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock },
	apiErrorMessage: (error: unknown) => {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
			return error.message;
		}
		return "Request failed";
	},
}));

const workspace: WorkspaceSummary = {
	id: "proj-1",
	name: "Project One",
	path: "/repo/project-one",
	sessions: [],
};

const session: WorkspaceSession = {
	id: "proj-1-1",
	workspaceId: "proj-1",
	workspaceName: "Project One",
	title: "fix login",
	provider: "claude-code",
	kind: "worker",
	branch: "session/proj-1-1",
	status: "working",
	updatedAt: "2026-06-30T00:00:00Z",
	prs: [],
};

type CreateProjectInput = {
	path: string;
	workerAgent: string;
	orchestratorAgent: string;
	trackerIntake?: unknown;
	asWorkspace?: boolean;
};
type CreateProjectHandler = (input: CreateProjectInput) => Promise<void>;
type InitializeProjectHandler = (path: string) => Promise<void>;
type RemoveProjectHandler = (projectId: string) => Promise<void>;

function renderSidebar({
	onCreateProject = vi.fn().mockResolvedValue(undefined) as CreateProjectHandler,
	onInitializeProject = vi.fn().mockResolvedValue(undefined) as InitializeProjectHandler,
	onRemoveProject = vi.fn().mockResolvedValue(undefined) as RemoveProjectHandler,
	seedAgents = true,
	workspaces = [workspace],
}: {
	onCreateProject?: CreateProjectHandler;
	onInitializeProject?: InitializeProjectHandler;
	onRemoveProject?: RemoveProjectHandler;
	seedAgents?: boolean;
	workspaces?: WorkspaceSummary[];
} = {}) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	if (seedAgents) {
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
	}
	render(
		<QueryClientProvider client={queryClient}>
			<SidebarProvider>
				<Sidebar
					onCreateProject={onCreateProject}
					onInitializeProject={onInitializeProject}
					onRemoveProject={onRemoveProject}
					workspaces={workspaces}
				/>
			</SidebarProvider>
		</QueryClientProvider>,
	);
	return onRemoveProject;
}

async function chooseOption(trigger: HTMLElement, optionName: string) {
	await userEvent.click(trigger);
	await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

function codedError(message: string, code: "NOT_A_GIT_REPO" | "PROJECT_UNBORN") {
	const error = new Error(message) as Error & { code: string };
	error.code = code;
	return error;
}

async function openCreateProjectDialog(
	path = "/repo/new-project",
	scan: {
		path: string;
		repos: Array<{
			name: string;
			path: string;
			relativePath: string;
			branch: string;
			remote: string;
			hasRemote: boolean;
			status?: "ok" | "error";
			reason?: string;
		}>;
	} = {
		path,
		repos: [
			{ name: "project", path, relativePath: ".", branch: "main", remote: "origin", hasRemote: true, status: "ok" },
		],
	},
) {
	const user = userEvent.setup();
	window.ao!.app.chooseDirectory = vi.fn().mockResolvedValue(path);
	window.ao!.app.scanImportFolder = vi.fn().mockResolvedValue(scan);
	await user.click(screen.getByLabelText("New project"));
	await user.click(screen.getByRole("button", { name: /^Project/i }));
	await screen.findByText(path);
	await chooseOption(screen.getByRole("combobox", { name: "Worker agent" }), "Codex");
	await chooseOption(screen.getByRole("combobox", { name: "Orchestrator agent" }), "Claude Code");
	return user;
}

beforeEach(() => {
	window.localStorage.clear();
	document.documentElement.style.removeProperty("--ao-sidebar-w");
	getMock.mockReset();
	getMock.mockResolvedValue({
		data: {
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
		},
		error: undefined,
	});
	navigateMock.mockReset();
	renameSessionMock.mockReset().mockResolvedValue(undefined);
	updateStatusMock.mockReset().mockResolvedValue({ state: "idle" });
	mockParams.projectId = undefined;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Sidebar", () => {
	it("shows a ConfirmDialog and calls onRemoveProject when confirmed", async () => {
		const user = userEvent.setup();
		const onRemoveProject = renderSidebar();

		await user.click(screen.getByLabelText("Project actions for Project One"));
		await user.click(await screen.findByRole("menuitem", { name: "Remove project" }));

		// The ConfirmDialog renders via Radix Portal — find it by role
		const dialog = await screen.findByRole("dialog", { name: "Remove project" });
		expect(dialog).toBeInTheDocument();
		expect(dialog).toHaveTextContent("Project One");

		await user.click(screen.getByRole("button", { name: "Remove" }));
		await waitFor(() => expect(onRemoveProject).toHaveBeenCalledTimes(1));
	});

	it("does not remove the project when cancellation is clicked in the ConfirmDialog", async () => {
		const user = userEvent.setup();
		const onRemoveProject = renderSidebar();

		await user.click(screen.getByLabelText("Project actions for Project One"));
		await user.click(await screen.findByRole("menuitem", { name: "Remove project" }));

		await screen.findByRole("dialog", { name: "Remove project" });
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		// Dialog should close and the handler must not have fired
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove project" })).not.toBeInTheDocument());
		expect(onRemoveProject).not.toHaveBeenCalled();
	});

	it("shows an error message inside the ConfirmDialog when removal fails", async () => {
		const user = userEvent.setup();
		const onRemoveProject = vi
			.fn()
			.mockRejectedValueOnce(new Error("Failed to remove project")) as RemoveProjectHandler;
		renderSidebar({ onRemoveProject });

		await user.click(screen.getByLabelText("Project actions for Project One"));
		await user.click(await screen.findByRole("menuitem", { name: "Remove project" }));
		await screen.findByRole("dialog", { name: "Remove project" });
		await user.click(screen.getByRole("button", { name: "Remove" }));

		// The error text renders inside the dialog — find it by its destructive color class
		expect(await screen.findByText("Failed to remove project")).toBeInTheDocument();
		// Dialog stays open on failure so the user can retry or cancel
		expect(screen.getByRole("dialog", { name: "Remove project" })).toBeInTheDocument();
	});

	it("requests a new task for the project from the kebab menu", async () => {
		const user = userEvent.setup();
		renderSidebar();
		const before = useUiStore.getState().newTaskRequest?.nonce ?? 0;

		await user.click(screen.getByLabelText("Project actions for Project One"));
		await user.click(await screen.findByRole("menuitem", { name: /New session/ }));

		const request = useUiStore.getState().newTaskRequest;
		expect(request?.projectId).toBe("proj-1");
		expect(request?.nonce ?? 0).toBeGreaterThan(before);
	});

	it("opens the create-project flow when the no-project shortcut signal arrives", async () => {
		renderSidebar();

		act(() => {
			useUiStore.getState().requestCreateProject();
		});

		expect(await screen.findByRole("dialog", { name: "Import to Agent Orchestrator" })).toBeInTheDocument();
	});

	it("keeps the create-project shortcut available when there are no projects", async () => {
		renderSidebar({ workspaces: [] });

		act(() => {
			useUiStore.getState().requestCreateProject();
		});

		expect(await screen.findByRole("dialog", { name: "Import to Agent Orchestrator" })).toBeInTheDocument();
	});

	it("reveals dashboard and orchestrator buttons alongside the kebab on the project row", () => {
		renderSidebar();

		expect(screen.getByLabelText("Open Project One dashboard")).toBeInTheDocument();
		expect(screen.getByLabelText("Spawn Project One orchestrator")).toBeInTheDocument();
		expect(screen.getByLabelText("Project actions for Project One")).toBeInTheDocument();
	});

	it("navigates to the project board when the dashboard button is clicked", async () => {
		const user = userEvent.setup();
		renderSidebar();

		await user.click(screen.getByLabelText("Open Project One dashboard"));

		expect(navigateMock).toHaveBeenCalledWith({ to: "/projects/$projectId", params: { projectId: "proj-1" } });
	});

	it("defaults worker and orchestrator agents when creating a project", async () => {
		const user = userEvent.setup();
		const onCreateProject = vi.fn().mockResolvedValue(undefined) as CreateProjectHandler;
		window.ao!.app.chooseDirectory = vi.fn().mockResolvedValue("/repo/new-project");
		renderSidebar({ onCreateProject });

		await user.click(screen.getByLabelText("New project"));
		expect(screen.getByRole("dialog", { name: "Import to Agent Orchestrator" })).toBeInTheDocument();
		expect(window.ao!.app.chooseDirectory).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: /^Project/i }));

		expect(await screen.findByText("/repo/new-project")).toBeInTheDocument();
		expect(window.ao!.app.chooseDirectory).toHaveBeenCalledWith("Choose a project repository");
		const dialog = screen.getByRole("dialog", { name: "Project agents" });
		expect(dialog).toHaveClass("left-1/2", "top-1/2", "-translate-x-1/2", "-translate-y-1/2");
		await user.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() =>
			expect(onCreateProject).toHaveBeenCalledWith(
				expect.objectContaining({
					path: "/repo/new-project",
					workerAgent: "claude-code",
					orchestratorAgent: "claude-code",
				}),
			),
		);
	});

	it("prioritizes authorized project agents by preferred agent order", async () => {
		const user = userEvent.setup();
		const onCreateProject = vi.fn().mockResolvedValue(undefined) as CreateProjectHandler;
		window.ao!.app.chooseDirectory = vi.fn().mockResolvedValue("/repo/new-project");
		getMock.mockResolvedValueOnce({
			data: {
				supported: [
					{ id: "goose", label: "Goose" },
					{ id: "devin", label: "Devin" },
					{ id: "aider", label: "Aider" },
					{ id: "opencode", label: "OpenCode" },
					{ id: "cursor", label: "Cursor" },
				],
				installed: [
					{ id: "goose", label: "Goose", authStatus: "authorized" },
					{ id: "devin", label: "Devin", authStatus: "authorized" },
					{ id: "aider", label: "Aider", authStatus: "authorized" },
					{ id: "opencode", label: "OpenCode", authStatus: "authorized" },
					{ id: "cursor", label: "Cursor", authStatus: "authorized" },
				],
				authorized: [
					{ id: "goose", label: "Goose", authStatus: "authorized" },
					{ id: "devin", label: "Devin", authStatus: "authorized" },
					{ id: "aider", label: "Aider", authStatus: "authorized" },
					{ id: "opencode", label: "OpenCode", authStatus: "authorized" },
					{ id: "cursor", label: "Cursor", authStatus: "authorized" },
				],
			},
			error: undefined,
		});
		renderSidebar({ onCreateProject, seedAgents: false });

		await user.click(screen.getByLabelText("New project"));
		await user.click(screen.getByRole("button", { name: /^Project/i }));
		expect(await screen.findByText("/repo/new-project")).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Worker agent" })).toHaveTextContent(/cursor/i);
		expect(screen.getByRole("combobox", { name: "Orchestrator agent" })).toHaveTextContent(/cursor/i);

		await user.click(screen.getByRole("combobox", { name: "Worker agent" }));
		expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
			"Cursor",
			"OpenCode",
			"Aider",
			"Devin",
			"Goose",
		]);
		await user.keyboard("{Escape}");

		await user.click(screen.getByRole("button", { name: "Create and start" }));
		await waitFor(() =>
			expect(onCreateProject).toHaveBeenCalledWith(
				expect.objectContaining({
					workerAgent: "cursor",
					orchestratorAgent: "cursor",
				}),
			),
		);
	});

	it("explains Git setup before creating a non-git project", async () => {
		const onCreateProject = vi.fn().mockResolvedValue(undefined) as CreateProjectHandler;
		const onInitializeProject = vi.fn().mockResolvedValue(undefined) as InitializeProjectHandler;
		renderSidebar({ onCreateProject, onInitializeProject });
		const user = await openCreateProjectDialog("/repo/new-project", { path: "/repo/new-project", repos: [] });

		expect(await screen.findByText(/If this folder needs Git setup/i)).toBeInTheDocument();
		expect(onInitializeProject).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Create and start" }));
		await waitFor(() => expect(onInitializeProject).toHaveBeenCalledWith("/repo/new-project"));
		await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(1));
	});

	it("shows repository initialization recovery for git repos with no commits", async () => {
		const onCreateProject = vi.fn().mockResolvedValue(undefined) as CreateProjectHandler;
		const onInitializeProject = vi.fn().mockResolvedValue(undefined) as InitializeProjectHandler;
		renderSidebar({ onCreateProject, onInitializeProject });
		const user = await openCreateProjectDialog("/repo/unborn", {
			path: "/repo/unborn",
			repos: [
				{
					name: "unborn",
					path: "/repo/unborn",
					relativePath: ".",
					branch: "HEAD",
					remote: "",
					hasRemote: false,
					status: "error",
					reason: "Repository must have at least one commit.",
				},
			],
		});
		expect(await screen.findByText(/If this folder needs Git setup/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Create and start" }));
		await waitFor(() => expect(onInitializeProject).toHaveBeenCalledWith("/repo/unborn"));
		await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(1));
	});

	it("does not initialize Git when the project creation is cancelled", async () => {
		const onCreateProject = vi
			.fn()
			.mockRejectedValueOnce(
				codedError("This folder is not a Git repository.", "NOT_A_GIT_REPO"),
			) as unknown as CreateProjectHandler;
		const onInitializeProject = vi.fn().mockResolvedValue(undefined) as InitializeProjectHandler;
		renderSidebar({ onCreateProject, onInitializeProject });
		const user = await openCreateProjectDialog("/repo/new-project", { path: "/repo/new-project", repos: [] });
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onInitializeProject).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog", { name: "Project agents" })).not.toBeInTheDocument();
	});

	it("surfaces repository initialization failures", async () => {
		const onCreateProject = vi.fn().mockResolvedValue(undefined) as CreateProjectHandler;
		const onInitializeProject = vi.fn().mockRejectedValue(new Error("git init failed")) as InitializeProjectHandler;
		renderSidebar({ onCreateProject, onInitializeProject });
		const user = await openCreateProjectDialog("/repo/new-project", { path: "/repo/new-project", repos: [] });
		await user.click(screen.getByRole("button", { name: "Create and start" }));
		await waitFor(() => expect(onInitializeProject).toHaveBeenCalledWith("/repo/new-project"));
		expect(onCreateProject).not.toHaveBeenCalled();
	});

	it("can create a workspace project from the project add flow", async () => {
		const user = userEvent.setup();
		const onCreateProject = vi.fn().mockResolvedValue(undefined) as CreateProjectHandler;
		window.ao!.app.chooseDirectory = vi.fn().mockResolvedValue("/repo/workspace");
		renderSidebar({ onCreateProject });

		await user.click(screen.getByLabelText("New project"));
		await user.click(screen.getByRole("button", { name: /^Workspace/i }));

		expect(await screen.findByText("/repo/workspace")).toBeInTheDocument();
		expect(window.ao!.app.chooseDirectory).toHaveBeenCalledWith("Choose a workspace folder");
		expect(screen.getByRole("dialog", { name: "Workspace agents" })).toBeInTheDocument();
		await chooseOption(screen.getByRole("combobox", { name: "Worker agent" }), "Codex");
		await chooseOption(screen.getByRole("combobox", { name: "Orchestrator agent" }), "Claude Code");
		await user.click(screen.getByRole("button", { name: "Create workspace and start" }));

		await waitFor(() =>
			expect(onCreateProject).toHaveBeenCalledWith({
				path: "/repo/workspace",
				workerAgent: "codex",
				orchestratorAgent: "claude-code",
				asWorkspace: true,
			}),
		);
	});

	it("does not run single-repo Git setup recovery for workspace imports", async () => {
		const user = userEvent.setup();
		const onCreateProject = vi
			.fn()
			.mockRejectedValueOnce(
				codedError("This folder is not a Git repository.", "NOT_A_GIT_REPO"),
			) as unknown as CreateProjectHandler;
		const onInitializeProject = vi.fn().mockResolvedValue(undefined) as InitializeProjectHandler;
		window.ao!.app.chooseDirectory = vi.fn().mockResolvedValue("/repo/workspace");
		window.ao!.app.scanImportFolder = vi.fn().mockResolvedValue({ path: "/repo/workspace", repos: [] });
		renderSidebar({ onCreateProject, onInitializeProject });

		await user.click(screen.getByLabelText("New project"));
		await user.click(screen.getByRole("button", { name: /^Workspace/i }));
		await screen.findByRole("dialog", { name: "Workspace agents" });
		await chooseOption(screen.getByRole("combobox", { name: "Orchestrator agent" }), "Claude Code");
		await user.click(screen.getByRole("button", { name: "Create workspace and start" }));

		await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(1));
		expect(onInitializeProject).not.toHaveBeenCalled();
		expect(await screen.findByText(/Import failed · workspace not registered/i)).toBeInTheDocument();
		expect(screen.getByText("Review the error above or choose a different folder")).toBeInTheDocument();
		expect(window.ao!.app.scanImportFolder).toHaveBeenCalledWith({
			path: "/repo/workspace",
			mode: "workspace",
		});
	});

	it("shows detected repository validation when workspace import fails", async () => {
		const user = userEvent.setup();
		const onCreateProject = vi.fn().mockRejectedValue(new Error("workspace not registered")) as CreateProjectHandler;
		window.ao!.app.chooseDirectory = vi.fn().mockResolvedValue("/Users/test/dev/acme");
		window.ao!.app.scanImportFolder = vi.fn().mockResolvedValue({
			path: "/Users/test/dev/acme",
			repos: [
				{
					name: "web",
					path: "/Users/test/dev/acme/web",
					relativePath: "web",
					branch: "HEAD",
					remote: "",
					hasRemote: false,
					status: "error",
					reason: "Origin remote is required.",
				},
				{
					name: "api",
					path: "/Users/test/dev/acme/api",
					relativePath: "api",
					branch: "main",
					remote: "git@github.com:acme/api.git",
					hasRemote: true,
					status: "ok",
				},
			],
		});
		renderSidebar({ onCreateProject });

		await user.click(screen.getByLabelText("New project"));
		await user.click(screen.getByRole("button", { name: /^Workspace/i }));
		await screen.findByRole("dialog", { name: "Workspace agents" });
		await chooseOption(screen.getByRole("combobox", { name: "Orchestrator agent" }), "Claude Code");
		await user.click(screen.getByRole("button", { name: "Create workspace and start" }));

		expect(await screen.findByText(/Import failed · workspace not registered/i)).toBeInTheDocument();
		expect(screen.getByText("workspace not registered")).toBeInTheDocument();
		expect(screen.getByText("web")).toBeInTheDocument();
		expect(screen.getByText("Origin remote is required.")).toBeInTheDocument();
		expect(screen.getByText("api")).toBeInTheDocument();
		expect(screen.getByText("main github.com/acme/api")).toBeInTheDocument();
		expect(screen.getByText("Resolve 1 failed repository to continue")).toBeInTheDocument();
		expect(window.ao!.app.scanImportFolder).toHaveBeenCalledWith({
			path: "/Users/test/dev/acme",
			mode: "workspace",
		});
	});

	it("does not rescan folders for non-validation create failures", async () => {
		const user = userEvent.setup();
		const onCreateProject = vi.fn().mockRejectedValue(new Error("AO daemon is not ready.")) as CreateProjectHandler;
		window.ao!.app.chooseDirectory = vi.fn().mockResolvedValue("/repo/workspace");
		window.ao!.app.scanImportFolder = vi.fn();
		renderSidebar({ onCreateProject });

		await user.click(screen.getByLabelText("New project"));
		await user.click(screen.getByRole("button", { name: /^Workspace/i }));
		await screen.findByRole("dialog", { name: "Workspace agents" });
		await chooseOption(screen.getByRole("combobox", { name: "Orchestrator agent" }), "Claude Code");
		await user.click(screen.getByRole("button", { name: "Create workspace and start" }));

		expect(await screen.findByText("AO daemon is not ready.")).toBeInTheDocument();
		expect(window.ao!.app.scanImportFolder).not.toHaveBeenCalled();
	});

	it("opens global settings from the footer menu when no project is selected", async () => {
		const user = userEvent.setup();
		renderSidebar();

		await user.click(screen.getByRole("button", { name: /project actions/i }));

		expect(await screen.findByRole("menuitem", { name: /settings/i })).toBeInTheDocument();
	});

	it("shows needs-auth agents as unavailable while keeping authorized agents selectable", async () => {
		const user = userEvent.setup();
		const onCreateProject = vi.fn().mockResolvedValue(undefined) as CreateProjectHandler;
		window.ao!.app.chooseDirectory = vi.fn().mockResolvedValue("/repo/new-project");
		getMock.mockResolvedValueOnce({
			data: {
				supported: [
					{ id: "claude-code", label: "Claude Code" },
					{ id: "cursor", label: "Cursor" },
					{ id: "aider", label: "Aider" },
				],
				installed: [
					{ id: "claude-code", label: "Claude Code", authStatus: "authorized" },
					{ id: "cursor", label: "Cursor", authStatus: "unauthorized" },
				],
				authorized: [{ id: "claude-code", label: "Claude Code", authStatus: "authorized" }],
			},
			error: undefined,
		});
		renderSidebar({ onCreateProject, seedAgents: false });

		await user.click(screen.getByLabelText("New project"));
		await user.click(screen.getByRole("button", { name: /^Project/i }));
		expect(await screen.findByText("/repo/new-project")).toBeInTheDocument();

		await user.click(screen.getByRole("combobox", { name: "Orchestrator agent" }));
		const options = await screen.findAllByRole("option");
		expect(options.map((option) => option.textContent)).toEqual([
			"Claude Code",
			"CursorNeeds auth",
			"AiderNeeds install",
		]);
		expect(options[1]).toHaveAttribute("aria-disabled", "true");
		expect(options[2]).toHaveAttribute("aria-disabled", "true");
		await user.keyboard("{Escape}");

		await user.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() =>
			expect(onCreateProject).toHaveBeenCalledWith(expect.objectContaining({ orchestratorAgent: "claude-code" })),
		);
	});

	it("updates project agent options when the catalog loads after the dialog opens", async () => {
		const user = userEvent.setup();
		const onCreateProject = vi.fn().mockResolvedValue(undefined) as CreateProjectHandler;
		window.ao!.app.chooseDirectory = vi.fn().mockResolvedValue("/repo/new-project");
		let resolveAgents!: (value: {
			data: {
				supported: { id: string; label: string }[];
				installed: { id: string; label: string }[];
				authorized: { id: string; label: string; authStatus: "authorized" }[];
			};
			error: undefined;
		}) => void;
		getMock.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveAgents = resolve;
			}),
		);
		renderSidebar({ onCreateProject, seedAgents: false });

		await user.click(screen.getByLabelText("New project"));
		await user.click(screen.getByRole("button", { name: /^Project/i }));
		expect(await screen.findByText("/repo/new-project")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create and start" })).toBeDisabled();

		resolveAgents({
			data: {
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
			},
			error: undefined,
		});

		await chooseOption(screen.getByRole("combobox", { name: "Orchestrator agent" }), "Claude Code");
		await user.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() =>
			expect(onCreateProject).toHaveBeenCalledWith({
				path: "/repo/new-project",
				workerAgent: "claude-code",
				orchestratorAgent: "claude-code",
				trackerIntake: undefined,
				asWorkspace: false,
			}),
		);
	});

	it("navigates to settings when the footer Settings button is clicked", async () => {
		const user = userEvent.setup();
		renderSidebar();
		await user.click(screen.getAllByRole("button", { name: "Settings" })[0]);
		expect(navigateMock).toHaveBeenCalledWith({ to: "/settings" });
	});

	it("shows the project name and context in the ConfirmDialog description", async () => {
		const user = userEvent.setup();
		renderSidebar();

		await user.click(screen.getByLabelText("Project actions for Project One"));
		await user.click(await screen.findByRole("menuitem", { name: "Remove project" }));

		const dialog = await screen.findByRole("dialog", { name: "Remove project" });
		expect(dialog).toHaveTextContent("Project One");
		expect(dialog).toHaveTextContent("live sessions");
		expect(dialog).toHaveTextContent("repository folder");
	});

	it("renames a session inline and persists via the daemon", async () => {
		const user = userEvent.setup();
		const workspaceWithSession = { ...workspace, sessions: [session] };
		renderSidebar({ workspaces: [workspaceWithSession] });

		await user.click(screen.getByLabelText("Rename fix login"));
		const input = screen.getByLabelText("Rename fix login");
		await user.clear(input);
		await user.type(input, "polish login{Enter}");

		await waitFor(() => expect(renameSessionMock).toHaveBeenCalledWith("proj-1-1", "polish login"));
	});

	it("caps the inline rename input at 20 characters", async () => {
		const user = userEvent.setup();
		const workspaceWithSession = { ...workspace, sessions: [session] };
		renderSidebar({ workspaces: [workspaceWithSession] });

		await user.click(screen.getByLabelText("Rename fix login"));
		expect(screen.getByLabelText("Rename fix login")).toHaveAttribute("maxlength", "20");
	});

	it("cancels the inline rename on Escape without calling the daemon", async () => {
		const user = userEvent.setup();
		const workspaceWithSession = { ...workspace, sessions: [session] };
		renderSidebar({ workspaces: [workspaceWithSession] });

		await user.click(screen.getByLabelText("Rename fix login"));
		const input = screen.getByLabelText("Rename fix login");
		await user.clear(input);
		await user.type(input, "discard me{Escape}");

		expect(renameSessionMock).not.toHaveBeenCalled();
		expect(screen.getByLabelText("Open fix login")).toBeInTheDocument();
	});

	it("always shows action icons and reserves padding for them", () => {
		renderSidebar();

		const projectRow = screen.getByText("Project One").closest("button");

		if (!projectRow) throw new Error("Project row button not found");
		// Padding is always reserved for the action cluster (not hover-gated)
		expect(projectRow).toHaveClass("pr-sidebar-project-actions");
	});

	it("snaps to the real collapsed rail when dragged past the resize collapse threshold", async () => {
		renderSidebar();

		const resizeHandle = screen.getByTestId("resize-handle");
		expect(resizeHandle).toBeInTheDocument();

		expect(document.querySelector('[data-slot="sidebar"][data-state="expanded"]')).toBeInTheDocument();

		fireEvent.pointerDown(resizeHandle, { clientX: 240 });
		fireEvent.pointerMove(window, { clientX: 120 });

		await waitFor(() => {
			expect(document.querySelector('[data-slot="sidebar"][data-state="collapsed"]')).toBeInTheDocument();
		});
		expect(document.cookie).toContain("sidebar_state=false");
		expect(window.localStorage.getItem("ao-sidebar-w")).toBe("240");
		expect(document.documentElement.style.getPropertyValue("--ao-sidebar-w")).toBe("240px");
		expect(document.body).not.toHaveClass("is-resizing-x");

		const expandRail = document.querySelector('[data-sidebar="rail"]');
		if (!(expandRail instanceof HTMLElement)) throw new Error("Sidebar rail not found");
		fireEvent.pointerDown(expandRail, { clientX: 48 });
		fireEvent.pointerMove(window, { clientX: 128 });
		fireEvent.pointerUp(window);

		await waitFor(() => {
			expect(document.querySelector('[data-slot="sidebar"][data-state="expanded"]')).toBeInTheDocument();
		});
		expect(document.documentElement.style.getPropertyValue("--ao-sidebar-w")).toBe("280px");
		expect(window.localStorage.getItem("ao-sidebar-w")).toBe("280");
	});

	it("discards a queued narrow resize frame when collapsing", async () => {
		let queuedFrame: FrameRequestCallback | undefined;
		const requestAnimationFrameSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
			queuedFrame = callback;
			return 1;
		});
		const cancelAnimationFrameSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

		try {
			renderSidebar();

			const resizeHandle = screen.getByTestId("resize-handle");

			fireEvent.pointerDown(resizeHandle, { clientX: 240 });
			fireEvent.pointerMove(window, { clientX: 205 });
			fireEvent.pointerMove(window, { clientX: 120 });

			await waitFor(() => {
				expect(document.querySelector('[data-slot="sidebar"][data-state="collapsed"]')).toBeInTheDocument();
			});
			expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(1);
			expect(window.localStorage.getItem("ao-sidebar-w")).toBe("240");
			expect(document.documentElement.style.getPropertyValue("--ao-sidebar-w")).toBe("240px");

			queuedFrame?.(performance.now());
			expect(document.documentElement.style.getPropertyValue("--ao-sidebar-w")).toBe("240px");
		} finally {
			requestAnimationFrameSpy.mockRestore();
			cancelAnimationFrameSpy.mockRestore();
		}
	});

	it("renders sidebar dots from attention zones without activity overrides", () => {
		renderSidebar({
			workspaces: [
				{
					...workspace,
					sessions: [
						{ ...session, id: "proj-1-idle", title: "idle task", status: "idle" },
						{
							...session,
							id: "proj-1-work",
							title: "working task",
							status: "working",
							activity: { state: "active", lastActivityAt: "2026-06-30T00:00:00Z" },
						},
						{
							...session,
							id: "proj-1-ci",
							title: "ci failed task",
							status: "ci_failed",
							activity: { state: "active", lastActivityAt: "2026-06-30T00:00:00Z" },
						},
					],
				},
			],
		});

		const idleDot = screen.getByLabelText("Open idle task").querySelector('span[aria-hidden="true"]');
		expect(idleDot).toHaveClass("bg-working");
		expect(idleDot).not.toHaveClass("animate-status-pulse");

		const workingDot = screen.getByLabelText("Open working task").querySelector('span[aria-hidden="true"]');
		expect(workingDot).toHaveClass("bg-working");
		expect(workingDot).not.toHaveClass("animate-status-pulse");

		const ciFailedDot = screen.getByLabelText("Open ci failed task").querySelector('span[aria-hidden="true"]');
		expect(ciFailedDot).toHaveClass("bg-warning");
		expect(ciFailedDot).not.toHaveClass("bg-error");
		expect(ciFailedDot).not.toHaveClass("animate-status-pulse");
	});

	it("renders idle activity as quiet while preserving PR status color", () => {
		renderSidebar({
			workspaces: [
				{
					...workspace,
					sessions: [
						{
							...session,
							id: "proj-1-idle-activity",
							title: "idle activity task",
							status: "working",
							activity: { state: "idle", lastActivityAt: "2026-06-30T00:00:00Z" },
						},
						{
							...session,
							id: "proj-1-idle-draft",
							title: "idle draft task",
							status: "draft",
							activity: { state: "idle", lastActivityAt: "2026-06-30T00:00:00Z" },
						},
					],
				},
			],
		});

		const idleDot = screen.getByLabelText("Open idle activity task").querySelector('span[aria-hidden="true"]');
		expect(idleDot).toHaveClass("bg-working");
		expect(idleDot).not.toHaveClass("animate-status-pulse");

		const idleDraftDot = screen.getByLabelText("Open idle draft task").querySelector('span[aria-hidden="true"]');
		expect(idleDraftDot).toHaveClass("bg-accent-dim");
		expect(idleDraftDot).not.toHaveClass("animate-status-pulse");
	});

	it("does not render the restart-to-update row unless an update is downloaded", async () => {
		updateStatusMock.mockResolvedValue({ state: "available", version: "9.9.9" });
		renderSidebar();

		await waitFor(() => expect(updateStatusMock).toHaveBeenCalled());
		expect(screen.queryByLabelText(/Restart to install update/)).not.toBeInTheDocument();
	});

	it("renders the restart-to-update row with the working-orange treatment when escalated", async () => {
		updateStatusMock.mockResolvedValue({
			state: "downloaded",
			version: "9.9.9",
			stagedAt: Date.now(),
			escalated: true,
		});
		renderSidebar();

		// Both footer variants (expanded row and collapsed rail icon) are mounted.
		const buttons = await screen.findAllByLabelText("Restart to install update v9.9.9");
		expect(buttons.length).toBeGreaterThan(0);
		for (const button of buttons) {
			expect(button).toHaveClass("text-working", "bg-working/12");
		}
		expect(screen.getByText("v9.9.9 ready")).toBeInTheDocument();
	});
});
