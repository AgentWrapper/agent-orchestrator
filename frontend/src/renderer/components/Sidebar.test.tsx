import { SidebarProvider } from "@/components/ui/sidebar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import type { WorkspaceSummary } from "../types/workspace";

const { navigateMock, mockParams } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
	mockParams: { projectId: undefined as string | undefined },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => navigateMock,
		useParams: () => mockParams,
		useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
			select({ location: { pathname: "/" } }),
	};
});

const workspace: WorkspaceSummary = {
	id: "proj-1",
	name: "Project One",
	path: "/repo/project-one",
	sessions: [],
};

type CreateProjectHandler = (input: { path: string; workerAgent: string; orchestratorAgent: string }) => Promise<void>;
type InitializeProjectHandler = (path: string) => Promise<void>;
type RemoveProjectHandler = (projectId: string) => Promise<void>;

function renderSidebar({
	onCreateProject = vi.fn().mockResolvedValue(undefined) as CreateProjectHandler,
	onInitializeProject = vi.fn().mockResolvedValue(undefined) as InitializeProjectHandler,
	onRemoveProject = vi.fn().mockResolvedValue(undefined) as RemoveProjectHandler,
}: {
	onCreateProject?: CreateProjectHandler;
	onInitializeProject?: InitializeProjectHandler;
	onRemoveProject?: RemoveProjectHandler;
} = {}) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<SidebarProvider>
				<Sidebar
					daemonStatus={{ state: "running" }}
					onCreateProject={onCreateProject}
					onInitializeProject={onInitializeProject}
					onRemoveProject={onRemoveProject}
					workspaces={[workspace]}
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

async function openCreateProjectDialog(path = "/repo/new-project") {
	const user = userEvent.setup();
	window.ao!.app.chooseDirectory = vi.fn().mockResolvedValue(path);
	await user.click(screen.getByLabelText("New project"));
	await screen.findByText(path);
	await chooseOption(screen.getByRole("combobox", { name: "Worker agent" }), "codex");
	await chooseOption(screen.getByRole("combobox", { name: "Orchestrator agent" }), "claude-code");
	return user;
}

beforeEach(() => {
	navigateMock.mockReset();
	mockParams.projectId = undefined;
	vi.spyOn(window, "confirm").mockReturnValue(true);
	vi.spyOn(window, "alert").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Sidebar", () => {
	it("confirms project removal before calling the remove handler", async () => {
		const user = userEvent.setup();
		const onRemoveProject = renderSidebar();

		await user.click(screen.getByLabelText("Project actions for Project One"));
		await user.click(await screen.findByRole("menuitem", { name: "Remove project" }));

		expect(window.confirm).toHaveBeenCalledWith(
			"Remove project Project One? This stops its live sessions and removes it from the sidebar, but keeps the repository folder and stored history on disk.",
		);
		await waitFor(() => expect(onRemoveProject).toHaveBeenCalledTimes(1));
	});

	it("does not remove the project when confirmation is cancelled", async () => {
		vi.mocked(window.confirm).mockReturnValue(false);
		const user = userEvent.setup();
		const onRemoveProject = renderSidebar();

		await user.click(screen.getByLabelText("Project actions for Project One"));
		await user.click(await screen.findByRole("menuitem", { name: "Remove project" }));

		expect(onRemoveProject).not.toHaveBeenCalled();
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

	it("requires explicit worker and orchestrator agents when creating a project", async () => {
		const user = userEvent.setup();
		const onCreateProject = vi.fn().mockResolvedValue(undefined) as CreateProjectHandler;
		window.ao!.app.chooseDirectory = vi.fn().mockResolvedValue("/repo/new-project");
		renderSidebar({ onCreateProject });

		await user.click(screen.getByLabelText("New project"));

		expect(await screen.findByText("/repo/new-project")).toBeInTheDocument();
		const dialog = screen.getByRole("dialog", { name: "Project agents" });
		expect(dialog).toHaveClass("left-1/2", "top-1/2", "-translate-x-1/2", "-translate-y-1/2");
		await chooseOption(screen.getByRole("combobox", { name: "Worker agent" }), "codex");
		await chooseOption(screen.getByRole("combobox", { name: "Orchestrator agent" }), "claude-code");
		await user.click(screen.getByRole("button", { name: "Create and start" }));

		await waitFor(() =>
			expect(onCreateProject).toHaveBeenCalledWith({
				path: "/repo/new-project",
				workerAgent: "codex",
				orchestratorAgent: "claude-code",
			}),
		);
	});

	it("shows repository initialization recovery for non-git folders and retries project creation", async () => {
		const onCreateProject = vi
			.fn()
			.mockRejectedValueOnce(
				codedError(
					"AO needs a Git repository with an initial commit before it can create agent workspaces.",
					"NOT_A_GIT_REPO",
				),
			)
			.mockResolvedValueOnce(undefined) as unknown as CreateProjectHandler;
		const onInitializeProject = vi.fn().mockResolvedValue(undefined) as InitializeProjectHandler;
		renderSidebar({ onCreateProject, onInitializeProject });
		const user = await openCreateProjectDialog();

		await user.click(screen.getByRole("button", { name: "Create and start" }));

		expect(await screen.findByText("Set up Git to continue")).toBeInTheDocument();
		expect(
			screen.getByText(
				"AO will initialize Git in this folder, create an empty initial commit, then continue automatically.",
			),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Create and start" })).not.toBeInTheDocument();
		await user.hover(screen.getByLabelText("Manual Git setup"));
		expect((await screen.findAllByText(/Prefer to do it yourself/)).length).toBeGreaterThan(0);
		expect(screen.getAllByText("git init").length).toBeGreaterThan(0);
		expect(screen.getAllByText('git commit --allow-empty -m "initial commit"').length).toBeGreaterThan(0);

		await user.click(screen.getByRole("button", { name: "Initialize Git and create commit" }));

		await waitFor(() => expect(onInitializeProject).toHaveBeenCalledWith("/repo/new-project"));
		await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(2));
		expect(onCreateProject).toHaveBeenLastCalledWith({
			path: "/repo/new-project",
			workerAgent: "codex",
			orchestratorAgent: "claude-code",
		});
	});

	it("shows repository initialization recovery for git repos with no commits", async () => {
		const onCreateProject = vi
			.fn()
			.mockRejectedValueOnce(
				codedError("This repo has no commits yet.", "PROJECT_UNBORN"),
			) as unknown as CreateProjectHandler;
		renderSidebar({ onCreateProject });
		const user = await openCreateProjectDialog("/repo/unborn");

		await user.click(screen.getByRole("button", { name: "Create and start" }));

		expect(await screen.findByText("Create the first commit to continue")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create initial commit" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Create and start" })).not.toBeInTheDocument();
		await user.hover(screen.getByLabelText("Manual Git setup"));
		expect((await screen.findAllByText('git commit --allow-empty -m "initial commit"')).length).toBeGreaterThan(0);
		expect(screen.queryByText("git init")).not.toBeInTheDocument();
	});

	it("surfaces repository initialization failures", async () => {
		const onCreateProject = vi
			.fn()
			.mockRejectedValueOnce(
				codedError("This folder is not a Git repository.", "NOT_A_GIT_REPO"),
			) as unknown as CreateProjectHandler;
		const onInitializeProject = vi.fn().mockRejectedValue(new Error("git init failed")) as InitializeProjectHandler;
		renderSidebar({ onCreateProject, onInitializeProject });
		const user = await openCreateProjectDialog();

		await user.click(screen.getByRole("button", { name: "Create and start" }));
		await user.click(await screen.findByRole("button", { name: "Initialize Git and create commit" }));

		expect((await screen.findAllByText("git init failed")).length).toBeGreaterThan(0);
	});
	it("opens global settings from the footer menu when no project is selected", async () => {
		const user = userEvent.setup();
		renderSidebar();

		await user.click(screen.getAllByLabelText("Settings")[0]);
		await user.click(await screen.findByRole("menuitem", { name: "Global settings" }));

		expect(navigateMock).toHaveBeenCalledWith({ to: "/settings" });
	});

	it("shows both project and global settings in the footer menu when a project is selected", async () => {
		mockParams.projectId = "proj-1";
		const user = userEvent.setup();
		renderSidebar();

		await user.click(screen.getAllByLabelText("Settings")[0]);
		expect(await screen.findByRole("menuitem", { name: "Project settings" })).toBeInTheDocument();
		await user.click(await screen.findByRole("menuitem", { name: "Global settings" }));

		expect(navigateMock).toHaveBeenCalledWith({ to: "/settings" });
	});

	it("always shows action icons and reserves padding for them", () => {
		renderSidebar();

		const projectRow = screen.getByText("Project One").closest("button");

		if (!projectRow) throw new Error("Project row button not found");
		// Padding is always reserved for the action cluster (not hover-gated)
		expect(projectRow).toHaveClass("pr-[84px]");
	});
});
