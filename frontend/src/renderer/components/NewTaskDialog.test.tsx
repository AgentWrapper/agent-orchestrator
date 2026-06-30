import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewTaskDialog } from "./NewTaskDialog";

const { getMock, postMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: (...args: unknown[]) => getMock(...args),
		POST: (...args: unknown[]) => postMock(...args),
	},
	apiErrorMessage: (error: unknown, fallback = "Request failed") => {
		if (typeof error === "object" && error !== null && "message" in error) {
			return String((error as { message: unknown }).message);
		}
		return fallback;
	},
}));

function renderDialog() {
	const onCreated = vi.fn();
	const onOpenChange = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient()}>
			<NewTaskDialog open projectId="proj-1" onCreated={onCreated} onOpenChange={onOpenChange} />
		</QueryClientProvider>,
	);
	return { onCreated, onOpenChange };
}

function spawnBody() {
	return (postMock.mock.calls[0][1] as { body: Record<string, unknown> }).body;
}

beforeEach(() => {
	getMock.mockReset().mockResolvedValue({
		data: { status: "ok", project: { id: "proj-1", config: { worker: { agent: "claude-code" } } } },
		error: undefined,
	});
	postMock.mockReset().mockResolvedValue({ data: { session: { id: "task-1" } }, error: undefined });
});

afterEach(() => vi.restoreAllMocks());

describe("NewTaskDialog", () => {
	it("preselects the project's default agent and omits harness so the daemon applies it", async () => {
		const { onCreated, onOpenChange } = renderDialog();
		const user = userEvent.setup();

		await screen.findByText("claude-code");

		await user.type(screen.getByLabelText("Title"), "Fix fallback renderer");
		await user.type(screen.getByLabelText("Brief"), "Restore the fallback renderer after WebGL init fails.");
		await user.click(screen.getByRole("button", { name: "Start task" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/sessions", {
			body: {
				projectId: "proj-1",
				kind: "worker",
				harness: undefined,
				issueId: "Fix fallback renderer",
				prompt: "Restore the fallback renderer after WebGL init fails.",
				branch: undefined,
			},
		});
		expect(onCreated).toHaveBeenCalledWith("task-1");
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("sends the chosen harness when the user overrides the default, including agents beyond the legacy four", async () => {
		renderDialog();
		const user = userEvent.setup();
		await screen.findByText("claude-code");

		await user.type(screen.getByLabelText("Title"), "T");
		await user.type(screen.getByLabelText("Brief"), "B");

		await user.click(screen.getByRole("combobox", { name: "Agent" }));
		await user.click(await screen.findByRole("option", { name: "cursor" }));

		await user.click(screen.getByRole("button", { name: "Start task" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(spawnBody().harness).toBe("cursor");
	});

	it("requires both title and brief", async () => {
		renderDialog();
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: "Start task" }));

		expect(await screen.findByText("Title and brief are required.")).toBeInTheDocument();
		expect(postMock).not.toHaveBeenCalled();
	});
});
