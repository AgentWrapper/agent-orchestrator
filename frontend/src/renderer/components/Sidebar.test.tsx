import { SidebarProvider } from "@/components/ui/sidebar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";

const { navigateMock, mockParams, renameSessionMock } = vi.hoisted(() => ({
	navigateMock: vi.fn(),
	mockParams: { projectId: undefined as string | undefined },
	renameSessionMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/rename-session", () => ({ renameSession: renameSessionMock }));

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

type CreateProjectHandler = (input: { path: string; workerAgent: string; orchestratorAgent: string }) => Promise<void>;
type RemoveProjectHandler = (projectId: string) => Promise<void>;

function renderSidebar({
	onCreateProject = vi.fn().mockResolvedValue(undefined) as CreateProjectHandler,
	onRemoveProject = vi.fn().mockResolvedValue(undefined) as RemoveProjectHandler,
	workspaces = [workspace],
}: {
	onCreateProject?: CreateProjectHandler;
	onRemoveProject?: RemoveProjectHandler;
	workspaces?: WorkspaceSummary[];
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

beforeEach(() => {
	navigateMock.mockReset();
	renameSessionMock.mockReset().mockResolvedValue(undefined);
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

	it("opens feedback above Settings and copies redacted report drafts", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		window.ao!.clipboard.writeText = writeText;
		window.ao!.app.getVersion = vi.fn().mockResolvedValue("9.9.9-test");
		window.ao!.daemon.getStatus = vi.fn().mockResolvedValue({
			state: "ready",
			message: "Listening at http://127.0.0.1:31001?token=secret",
		});
		renderSidebar();

		const feedbackButton = screen.getAllByRole("button", { name: "Feedback" })[0];
		const settingsButton = screen.getAllByRole("button", { name: "Settings" })[0];
		expect(feedbackButton.compareDocumentPosition(settingsButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		await user.click(feedbackButton);
		expect(await screen.findByRole("dialog", { name: "Report a problem" })).toBeInTheDocument();

		await user.type(screen.getByLabelText("Summary"), "Create project fails in /Users/alice/private-repo");
		await user.type(
			screen.getByLabelText("Details / repro"),
			"Open http://127.0.0.1:5173/projects/demo?access_token=local-secret and click Create.",
		);
		await user.type(screen.getByLabelText("Expected / request"), "Show a clear prerequisite error.");

		expect(screen.getByLabelText("Report preview")).toHaveTextContent("[redacted-local-path]");
		await user.click(screen.getByRole("button", { name: "Copy GitHub issue" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		const copied = writeText.mock.calls[0][0] as string;
		expect(copied).toContain("Create project fails");
		expect(copied).toContain("AO version: 9.9.9-test");
		expect(copied).toContain("Daemon: ready");
		expect(copied).toContain("[redacted-local-path]");
		expect(copied).toContain("[redacted-local-url]");
		expect(copied).not.toContain("/Users/alice");
		expect(copied).not.toContain("local-secret");
	});

	it("copies Discord and email drafts when daemon diagnostics are unavailable", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		window.ao!.clipboard.writeText = writeText;
		window.ao!.app.getVersion = vi.fn().mockRejectedValue(new Error("version unavailable"));
		window.ao!.daemon.getStatus = vi.fn().mockRejectedValue(new Error("daemon unavailable"));
		renderSidebar();

		await user.click(screen.getAllByRole("button", { name: "Feedback" })[0]);
		expect(await screen.findByRole("dialog", { name: "Report a problem" })).toBeInTheDocument();
		await user.type(screen.getByLabelText("Summary"), "Need help with setup");

		await user.click(screen.getByRole("button", { name: "Copy Discord summary" }));
		await user.click(screen.getByRole("button", { name: "Copy email draft" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
		expect(writeText.mock.calls[0][0]).toContain("Daemon: unknown");
		expect(writeText.mock.calls[1][0]).toContain("AO feedback");
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
		expect(projectRow).toHaveClass("pr-[84px]");
	});
});
