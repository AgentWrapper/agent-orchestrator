import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShellProvider } from "../lib/shell-context";
import { SessionsBoard } from "./SessionsBoard";

const { getMock, postMock, navigateMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
	navigateMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock, POST: postMock },
	apiErrorMessage: (e: unknown) => (e instanceof Error ? e.message : "error"),
	hasTrustedApiBaseUrl: () => true,
	setApiBaseUrl: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return { ...actual, useNavigate: () => navigateMock };
});

function mockWorkspace() {
	getMock.mockImplementation(async (url: string) => {
		if (url === "/api/v1/projects") {
			return { data: { projects: [{ id: "proj-1", name: "my-app", path: "/repo/my-app" }] }, error: undefined };
		}
		if (url === "/api/v1/sessions") {
			return { data: { sessions: [] }, error: undefined };
		}
		throw new Error(`unexpected GET ${url}`);
	});
}

function renderBoard(status: { state: "ready" | "stopped"; port?: number; message?: string }) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={queryClient}>
			<ShellProvider value={{ daemonStatus: status, createProject: vi.fn() }}>
				<SessionsBoard projectId="proj-1" />
			</ShellProvider>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	getMock.mockReset();
	postMock.mockReset();
	navigateMock.mockReset();
	mockWorkspace();
	window.ao!.daemon.start = vi.fn().mockResolvedValue({ state: "ready", port: 4567 });
});

describe("SessionsBoard daemon recovery", () => {
	it("disables daemon-backed project actions while the daemon is stopped", async () => {
		renderBoard({ state: "stopped" });

		expect(await screen.findByRole("button", { name: "New task" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Spawn Orchestrator" })).toBeDisabled();
		expect(screen.getByText("AO daemon is stopped. Restart it to create tasks or start an orchestrator.")).toBeInTheDocument();
	});

	it("offers an explicit daemon restart action", async () => {
		renderBoard({ state: "stopped" });

		await userEvent.click(await screen.findByRole("button", { name: "Restart daemon" }));

		await waitFor(() => expect(window.ao!.daemon.start).toHaveBeenCalledTimes(1));
	});

	it("surfaces spawn errors instead of leaking an unhandled rejection", async () => {
		postMock.mockResolvedValue({ data: undefined, error: { message: "AO daemon is not ready" }, response: { status: 503 } });
		renderBoard({ state: "ready", port: 4567 });

		await userEvent.click(await screen.findByRole("button", { name: "Spawn Orchestrator" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("AO daemon is not ready");
	});
});
