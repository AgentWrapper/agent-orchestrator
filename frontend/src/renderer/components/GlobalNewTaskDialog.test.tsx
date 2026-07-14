import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalNewTaskDialog } from "./GlobalNewTaskDialog";
import { useUiStore } from "../stores/ui-store";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
}));

// Probe stand-in: surfaces the props the real dialog would receive and lets the
// test simulate a successful task creation.
vi.mock("./NewTaskDialog", () => ({
	NewTaskDialog: ({
		open,
		projectId,
		onCreated,
	}: {
		open: boolean;
		projectId?: string;
		onCreated: (id: string) => void;
	}) =>
		open ? (
			<div data-testid="new-task-dialog" data-project={projectId}>
				<button type="button" onClick={() => onCreated("sess-9")}>
					create
				</button>
			</div>
		) : null,
}));

function renderDialog() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={queryClient}>
			<GlobalNewTaskDialog />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	navigateMock.mockReset();
	useUiStore.setState({ newTaskRequest: null });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("GlobalNewTaskDialog", () => {
	it("stays closed until a new-task request arrives", () => {
		renderDialog();
		expect(screen.queryByTestId("new-task-dialog")).not.toBeInTheDocument();
	});

	it("opens for the requested project and navigates to the created session", async () => {
		const user = userEvent.setup();
		renderDialog();

		act(() => {
			useUiStore.getState().requestNewTask("proj-7");
		});

		const dialog = await screen.findByTestId("new-task-dialog");
		expect(dialog).toHaveAttribute("data-project", "proj-7");

		await user.click(screen.getByRole("button", { name: "create" }));
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: "proj-7", sessionId: "sess-9" },
		});
	});

	it("re-opens on a repeat request for the same project (nonce bump)", async () => {
		renderDialog();

		act(() => {
			useUiStore.getState().requestNewTask("proj-7");
		});
		await screen.findByTestId("new-task-dialog");

		// Close it, then request the same project again — the nonce must re-open it.
		act(() => {
			useUiStore.setState({ newTaskRequest: { projectId: "proj-7", nonce: 999 } });
		});
		expect(await screen.findByTestId("new-task-dialog")).toHaveAttribute("data-project", "proj-7");
	});
});
