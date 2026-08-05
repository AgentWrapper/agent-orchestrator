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
			const body = error as { code?: unknown; message: unknown };
			const message = String(body.message);
			return typeof body.code === "string" && body.code !== "" ? `${message} (${body.code})` : message;
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

function requestBody() {
	return (postMock.mock.calls[0][1] as { body: Record<string, unknown> }).body;
}

async function waitForAgentCatalog() {
	await waitFor(() => expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0));
}

beforeEach(() => {
	getMock.mockReset().mockImplementation(async (path: string) => {
		if (path === "/api/v1/agents") {
			return {
				data: {
					supported: [
						{ id: "claude-code", label: "Claude Code" },
						{ id: "cursor", label: "Cursor" },
						{ id: "kiro", label: "Kiro" },
					],
					installed: [
						{ id: "claude-code", label: "Claude Code", authStatus: "authorized" },
						{ id: "cursor", label: "Cursor", authStatus: "authorized" },
						{ id: "kiro", label: "Kiro", authStatus: "unknown" },
					],
					authorized: [
						{ id: "claude-code", label: "Claude Code", authStatus: "authorized" },
						{ id: "cursor", label: "Cursor", authStatus: "authorized" },
					],
				},
				error: undefined,
			};
		}
		return {
			data: { status: "ok", project: { id: "proj-1", config: { worker: { agent: "claude-code" } } } },
			error: undefined,
		};
	});
	postMock.mockReset().mockResolvedValue({ data: { ok: true, workerId: "worker-1", orchestratorId: "orch-1" }, error: undefined });
});

afterEach(() => vi.restoreAllMocks());

describe("NewTaskDialog", () => {
	it("shows Task, Agent, and an empty Model field without Title or Branch", async () => {
		renderDialog();
		await waitForAgentCatalog();

		const agentLabel = screen.getByText("Agent", { selector: "label" });
		const modelLabel = screen.getByText("Model", { selector: "label" });
		expect(agentLabel).toHaveAttribute("data-slot", "label");
		expect(modelLabel).toHaveAttribute("data-slot", "label");
		expect(screen.getByRole("combobox", { name: "Agent" })).toHaveAttribute("data-size", "sm");
		expect(screen.getByLabelText("Model")).toHaveValue("");
		expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Branch")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Add image" })).not.toBeInTheDocument();
	});

	it("starts the original task with project-default agent intent and optional model", async () => {
		const { onCreated, onOpenChange } = renderDialog();
		const user = userEvent.setup();
		const brief = "  Restore the fallback renderer after WebGL init fails.  ";

		await waitForAgentCatalog();

		await user.type(screen.getByLabelText("Task"), brief);
		await user.type(screen.getByLabelText("Model"), "placeholder-model");
		await user.click(screen.getByRole("button", { name: "Start task" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/orchestrators/delegate", {
			body: {
				projectId: "proj-1",
				brief,
				agent: undefined,
				model: "placeholder-model",
			},
		});
		expect(requestBody()).not.toHaveProperty("issueId");
		expect(requestBody()).not.toHaveProperty("branch");
		expect(requestBody()).not.toHaveProperty("harness");
		expect(onCreated).toHaveBeenCalledWith("worker-1");
		expect(onOpenChange).toHaveBeenCalledWith(false);
	}, 20_000);

	it("sends the chosen agent when the user overrides the default", async () => {
		renderDialog();
		const user = userEvent.setup();
		await waitForAgentCatalog();

		await user.type(screen.getByLabelText("Task"), "B");

		await user.click(screen.getByRole("combobox", { name: "Agent" }));
		await user.click(await screen.findByRole("option", { name: "Cursor" }));

		await user.click(screen.getByRole("button", { name: "Start task" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(requestBody().agent).toBe("cursor");
	});

	it("allows selecting an installed agent with unknown auth", async () => {
		renderDialog();
		const user = userEvent.setup();
		await waitForAgentCatalog();

		await user.click(screen.getByRole("combobox", { name: "Agent" }));
		const options = await screen.findAllByRole("option");
		expect(options.map((option) => option.textContent)).toEqual(["Claude Code", "Cursor", "KiroAuth unknown"]);
		expect(options[2]).not.toHaveAttribute("aria-disabled", "true");
		await user.click(options[2]);

		await user.type(screen.getByLabelText("Task"), "B");
		await user.click(screen.getByRole("button", { name: "Start task" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(requestBody().agent).toBe("kiro");
	});

	it("requires task text", async () => {
		renderDialog();
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: "Start task" }));

		expect(await screen.findByText("Task is required.")).toBeInTheDocument();
		expect(postMock).not.toHaveBeenCalled();
	});

	it("shows an empty Model field for scratch projects and omits it from delegation", async () => {
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/agents") {
				return {
					data: {
						supported: [{ id: "claude-code", label: "Claude Code" }],
						installed: [{ id: "claude-code", label: "Claude Code", authStatus: "authorized" }],
						authorized: [{ id: "claude-code", label: "Claude Code", authStatus: "authorized" }],
					},
					error: undefined,
				};
			}
			return {
				data: {
					status: "ok",
					project: { id: "proj-1", kind: "scratch", config: { worker: { agent: "claude-code" } } },
				},
				error: undefined,
			};
		});

		renderDialog();
		const user = userEvent.setup();
		await waitForAgentCatalog();

		expect(screen.queryByLabelText("Branch")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Model")).toHaveValue("");

		await user.type(screen.getByLabelText("Task"), "Build a quick prototype in scratch.");
		await user.click(screen.getByRole("button", { name: "Start task" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(requestBody()).not.toHaveProperty("branch");
		expect(requestBody().model).toBeUndefined();
	});

	it("submits on Enter and inserts a newline on Shift+Enter in the task", async () => {
		renderDialog();
		const user = userEvent.setup();
		await waitForAgentCatalog();

		const task = screen.getByLabelText("Task");
		await user.type(task, "First line");
		// Shift+Enter must NOT submit — it adds a newline.
		await user.keyboard("{Shift>}{Enter}{/Shift}");
		await user.type(task, "Second line");
		expect(postMock).not.toHaveBeenCalled();

		// Plain Enter submits the task.
		await user.keyboard("{Enter}");
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(requestBody().brief).toContain("\n");
	});

	it("does not submit on Alt+Enter or Shift+Enter but does on plain Enter in the task", async () => {
		renderDialog();
		const user = userEvent.setup();
		await waitForAgentCatalog();

		const task = screen.getByLabelText("Task");
		await user.type(task, "Line");

		// Alt+Enter must NOT submit — Alt is excluded so it can't submit by accident.
		await user.keyboard("{Alt>}{Enter}{/Alt}");
		expect(postMock).not.toHaveBeenCalled();

		// Shift+Enter must NOT submit — it inserts a newline.
		await user.keyboard("{Shift>}{Enter}{/Shift}");
		expect(postMock).not.toHaveBeenCalled();

		// Plain Enter submits the task.
		await user.keyboard("{Enter}");
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
	});

	it.each([
		{
			code: "UNKNOWN_HARNESS",
			message: "Unknown requested agent",
		},
		{
			code: "INTERNAL",
			message: "task start failed",
		},
	])("displays daemon start errors for $code", async ({ code, message }) => {
		postMock.mockResolvedValueOnce({
			data: undefined,
			error: { code, message },
		});
		renderDialog();
		const user = userEvent.setup();
		await waitForAgentCatalog();

		await user.type(screen.getByLabelText("Task"), "Restore fallback renderer.");
		await user.click(screen.getByRole("button", { name: "Start task" }));

		expect(await screen.findByText(`${message} (${code})`)).toBeInTheDocument();
	});
});
