import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// Drives the real useWorkspaceQuery + SessionsBoard end to end for the two
// first-run states, mocking only the HTTP client, the router, and the native
// folder picker: an empty daemon shows the import chooser (no column shells), a
// fresh project shows the task invitation, and any session brings the columns back.
const { getMock, navigateMock, chooseDirectoryMock, spawnOrchestratorMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	navigateMock: vi.fn(),
	chooseDirectoryMock: vi.fn(),
	spawnOrchestratorMock: vi.fn(),
}));

vi.mock("../../lib/spawn-orchestrator", () => ({ spawnOrchestrator: spawnOrchestratorMock }));

vi.mock("../../lib/api-client", () => ({
	apiClient: { GET: getMock, POST: vi.fn() },
	apiErrorMessage: (e: unknown) => (e instanceof Error ? e.message : "error"),
	hasTrustedApiBaseUrl: () => true,
}));

vi.mock("../../lib/bridge", () => ({
	aoBridge: { app: { chooseDirectory: chooseDirectoryMock } },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return { ...actual, useNavigate: () => navigateMock };
});

import { SessionsBoard } from "../../components/SessionsBoard";
import { ShellProvider, type ShellContextValue } from "../../lib/shell-context";
import { useUiStore } from "../../stores/ui-store";

type Project = { id: string; name: string; path: string };
type Session = Record<string, unknown>;

function respondWith(projects: Project[], sessions: Session[]) {
	getMock.mockImplementation(async (url: string) => {
		if (url === "/api/v1/projects") return { data: { projects }, error: undefined };
		if (url === "/api/v1/sessions") return { data: { sessions }, error: undefined };
		return { data: undefined, error: undefined };
	});
}

const project: Project = { id: "proj-1", name: "my-app", path: "/repo/my-app" };

const workerSession: Session = {
	id: "sess-1",
	projectId: "proj-1",
	displayName: "fix the bug",
	harness: "claude-code",
	kind: "worker",
	status: "working",
	isTerminated: false,
	updatedAt: "2026-07-04T10:00:00Z",
	prs: [],
};

const orchestratorSession: Session = {
	id: "proj-1-orchestrator",
	projectId: "proj-1",
	displayName: "orchestrator",
	harness: "claude-code",
	kind: "orchestrator",
	status: "working",
	isTerminated: false,
	updatedAt: "2026-07-04T10:00:00Z",
	prs: [],
};

const createProjectMock = vi.fn().mockResolvedValue(undefined);
const initializeProjectRepositoryMock = vi.fn().mockResolvedValue(undefined);

// Kept from the latest renderBoard call so tests can rerender with the same
// providers (e.g. simulating a projectId route-param change on a mounted board).
let lastQueryClient: QueryClient | null = null;
let lastShell: ShellContextValue | null = null;

function renderBoard(ui: ReactNode) {
	lastQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	lastShell = {
		daemonStatus: { state: "ready" } as ShellContextValue["daemonStatus"],
		createProject: createProjectMock,
		initializeProjectRepository: initializeProjectRepositoryMock,
	};
	return render(
		<QueryClientProvider client={lastQueryClient}>
			<ShellProvider value={lastShell}>{ui}</ShellProvider>
		</QueryClientProvider>,
	);
}

// The kanban columns render as <section> elements; the empty states render none.
const columnCount = () => document.querySelectorAll("section").length;

beforeEach(() => {
	vi.clearAllMocks();
	createProjectMock.mockResolvedValue(undefined);
	initializeProjectRepositoryMock.mockResolvedValue(undefined);
	useUiStore.setState({
		orchestratorReplacementErrors: {},
		orchestratorStartupErrors: {},
		restartingProjectIds: new Set(),
	});
});

describe("global board first launch", () => {
	it("shows the import chooser instead of empty columns when no projects exist", async () => {
		respondWith([], []);
		renderBoard(<SessionsBoard />);

		expect(await screen.findByText("Import to Agent Orchestrator")).toBeInTheDocument();
		expect(screen.getByText("What are you importing?")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Workspace" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Project" })).toBeInTheDocument();
		expect(columnCount()).toBe(0);
		// The welcome carries its own orientation — no dangling "Board" header.
		expect(screen.queryByText("Board")).not.toBeInTheDocument();
	});

	it("opens the native folder picker from the Project card", async () => {
		respondWith([], []);
		chooseDirectoryMock.mockResolvedValue(null);
		renderBoard(<SessionsBoard />);

		await userEvent.click(await screen.findByRole("button", { name: "Project" }));
		expect(chooseDirectoryMock).toHaveBeenCalledTimes(1);
		expect(chooseDirectoryMock).toHaveBeenCalledWith("Choose a project repository");
	});

	it("opens the native folder picker from the Workspace card", async () => {
		respondWith([], []);
		chooseDirectoryMock.mockResolvedValue(null);
		renderBoard(<SessionsBoard />);

		await userEvent.click(await screen.findByRole("button", { name: "Workspace" }));
		expect(chooseDirectoryMock).toHaveBeenCalledTimes(1);
		expect(chooseDirectoryMock).toHaveBeenCalledWith("Choose a workspace folder");
	});

	it("shows a visible error when the folder picker fails", async () => {
		respondWith([], []);
		chooseDirectoryMock.mockRejectedValue(new Error("dialog unavailable"));
		renderBoard(<SessionsBoard />);

		await userEvent.click(await screen.findByRole("button", { name: "Project" }));
		const messages = await screen.findAllByText("dialog unavailable");
		expect(messages.some((el) => !el.classList.contains("sr-only"))).toBe(true);
	});

	it("keeps the columns once a project exists", async () => {
		respondWith([project], [workerSession]);
		renderBoard(<SessionsBoard />);

		expect(await screen.findByText("fix the bug")).toBeInTheDocument();
		expect(screen.queryByText("Import to Agent Orchestrator")).not.toBeInTheDocument();
		expect(columnCount()).toBe(4);
	});
});

describe("project board with no sessions", () => {
	it("shows the task invitation instead of empty columns", async () => {
		respondWith([project], []);
		renderBoard(<SessionsBoard projectId="proj-1" />);

		expect(await screen.findByText("No worker sessions yet")).toBeInTheDocument();
		// Board header + empty state each offer the pair; the orchestrator is primary in both.
		expect(screen.getAllByRole("button", { name: "Spawn Orchestrator" }).length).toBeGreaterThan(0);
		expect(screen.getAllByRole("button", { name: "New task" }).length).toBeGreaterThan(0);
		expect(screen.queryByText("Import to Agent Orchestrator")).not.toBeInTheDocument();
		expect(columnCount()).toBe(0);
	});

	it("surfaces the daemon error when spawning the orchestrator fails", async () => {
		respondWith([project], []);
		spawnOrchestratorMock.mockRejectedValue(new Error("branch is already checked out in another worktree"));
		renderBoard(<SessionsBoard projectId="proj-1" />);

		await screen.findByText("No worker sessions yet");
		const [spawnButton] = screen.getAllByRole("button", { name: "Spawn Orchestrator" });
		await userEvent.click(spawnButton);

		expect(await screen.findByText(/branch is already checked out/)).toBeInTheDocument();
	});

	it("shows the project creation startup error after navigating to the project board", async () => {
		respondWith([project], []);
		useUiStore
			.getState()
			.setOrchestratorStartupError(
				"proj-1",
				"Project added, but orchestrator did not start: branch is already checked out in another worktree",
			);
		renderBoard(<SessionsBoard projectId="proj-1" />);

		expect(await screen.findByText(/Project added, but orchestrator did not start/)).toBeInTheDocument();
		expect(screen.getByText(/branch is already checked out/)).toBeInTheDocument();
	});

	it("clears the project creation startup error when retrying orchestrator spawn", async () => {
		respondWith([project], []);
		useUiStore
			.getState()
			.setOrchestratorStartupError(
				"proj-1",
				"Project added, but orchestrator did not start: branch is already checked out in another worktree",
			);
		spawnOrchestratorMock.mockResolvedValue("proj-1-orchestrator");
		renderBoard(<SessionsBoard projectId="proj-1" />);

		await screen.findByText(/Project added, but orchestrator did not start/);
		const [spawnButton] = screen.getAllByRole("button", { name: "Spawn Orchestrator" });
		await userEvent.click(spawnButton);

		await waitFor(() =>
			expect(screen.queryByText(/Project added, but orchestrator did not start/)).not.toBeInTheDocument(),
		);
		expect(useUiStore.getState().orchestratorStartupErrors["proj-1"]).toBeUndefined();
	});

	it("clears a project creation startup error when switching projects", async () => {
		const otherProject: Project = { id: "proj-2", name: "other-app", path: "/repo/other-app" };
		respondWith([project, otherProject], []);
		useUiStore
			.getState()
			.setOrchestratorStartupError(
				"proj-1",
				"Project added, but orchestrator did not start: branch is already checked out in another worktree",
			);
		const { rerender } = renderBoard(<SessionsBoard projectId="proj-1" />);

		await screen.findByText(/Project added, but orchestrator did not start/);
		rerender(
			<QueryClientProvider client={lastQueryClient!}>
				<ShellProvider value={lastShell!}>
					<SessionsBoard projectId="proj-2" />
				</ShellProvider>
			</QueryClientProvider>,
		);

		await screen.findByText("No worker sessions yet");
		await waitFor(() => expect(useUiStore.getState().orchestratorStartupErrors["proj-1"]).toBeUndefined());
		expect(screen.queryByText(/Project added, but orchestrator did not start/)).not.toBeInTheDocument();
	});

	it("clears a project creation startup error once an orchestrator exists", async () => {
		respondWith([project], [orchestratorSession]);
		useUiStore
			.getState()
			.setOrchestratorStartupError(
				"proj-1",
				"Project added, but orchestrator did not start: branch is already checked out in another worktree",
			);
		renderBoard(<SessionsBoard projectId="proj-1" />);

		await screen.findByText("No worker sessions yet");
		await waitFor(() => expect(useUiStore.getState().orchestratorStartupErrors["proj-1"]).toBeUndefined());
		expect(screen.queryByText(/Project added, but orchestrator did not start/)).not.toBeInTheDocument();
	});

	it("clears a stale spawn error when switching projects", async () => {
		const otherProject: Project = { id: "proj-2", name: "other-app", path: "/repo/other-app" };
		respondWith([project, otherProject], []);
		spawnOrchestratorMock.mockRejectedValue(new Error("branch is already checked out in another worktree"));
		const { rerender } = renderBoard(<SessionsBoard projectId="proj-1" />);

		await screen.findByText("No worker sessions yet");
		const [spawnButton] = screen.getAllByRole("button", { name: "Spawn Orchestrator" });
		await userEvent.click(spawnButton);
		await screen.findByText(/branch is already checked out/);

		rerender(
			<QueryClientProvider client={lastQueryClient!}>
				<ShellProvider value={lastShell!}>
					<SessionsBoard projectId="proj-2" />
				</ShellProvider>
			</QueryClientProvider>,
		);
		await screen.findByText("No worker sessions yet");
		expect(screen.queryByText(/branch is already checked out/)).not.toBeInTheDocument();
	});

	it("keeps the columns once the project has a session", async () => {
		respondWith([project], [workerSession]);
		renderBoard(<SessionsBoard projectId="proj-1" />);

		expect(await screen.findByText("fix the bug")).toBeInTheDocument();
		expect(screen.queryByText("No worker sessions yet")).not.toBeInTheDocument();
		expect(columnCount()).toBe(4);
	});
});
