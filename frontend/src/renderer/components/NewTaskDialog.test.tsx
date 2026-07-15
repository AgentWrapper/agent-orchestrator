import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewTaskDialog } from "./NewTaskDialog";

const { getMock, postMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
}));
let projectConfig: Record<string, unknown>;

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
	const view = render(
		<QueryClientProvider client={new QueryClient()}>
			<NewTaskDialog open projectId="proj-1" onCreated={onCreated} onOpenChange={onOpenChange} />
		</QueryClientProvider>,
	);
	return { ...view, onCreated, onOpenChange };
}

function spawnBody() {
	return (postMock.mock.calls[0][1] as { body: Record<string, unknown> }).body;
}

async function waitForAgentCatalog() {
	await waitFor(() => expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0));
}

beforeEach(() => {
	window.localStorage.clear();
	projectConfig = { worker: { agent: "claude-code" } };
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
			data: { status: "ok", project: { id: "proj-1", config: projectConfig } },
			error: undefined,
		};
	});
	postMock.mockReset().mockResolvedValue({ data: { session: { id: "task-1" } }, error: undefined });
});

afterEach(() => vi.restoreAllMocks());

describe("NewTaskDialog", () => {
	it("aligns the Agent and Branch fields with matching labels and compact controls", async () => {
		renderDialog();
		await waitForAgentCatalog();

		const agentLabel = screen.getByText("Agent", { selector: "label" });
		const branchLabel = screen.getByText("Branch", { selector: "label" });
		expect(agentLabel).toHaveAttribute("data-slot", "label");
		expect(branchLabel).toHaveAttribute("data-slot", "label");
		expect(screen.getByRole("combobox", { name: "Agent" })).toHaveAttribute("data-size", "sm");
		expect(screen.getByLabelText("Branch")).toHaveClass("h-control-form");
		expect(screen.getByRole("combobox", { name: "Model" })).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Effort" })).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Permission" })).toBeInTheDocument();
	});

	it("preselects the project's default agent and omits harness so the daemon applies it", async () => {
		const { onCreated, onOpenChange } = renderDialog();
		const user = userEvent.setup();

		await waitForAgentCatalog();

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
				agentConfig: undefined,
			},
		});
		expect(onCreated).toHaveBeenCalledWith("task-1");
		expect(onOpenChange).toHaveBeenCalledWith(false);
	}, 20_000);

	it("sends the chosen harness when the user overrides the default", async () => {
		renderDialog();
		const user = userEvent.setup();
		await waitForAgentCatalog();

		await user.type(screen.getByLabelText("Title"), "T");
		await user.type(screen.getByLabelText("Brief"), "B");

		await user.click(screen.getByRole("combobox", { name: "Agent" }));
		await user.click(await screen.findByRole("option", { name: "Cursor" }));

		await user.click(screen.getByRole("button", { name: "Start task" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(spawnBody().harness).toBe("cursor");
	});

	it("sends per-task model, effort, and permission overrides", async () => {
		renderDialog();
		const user = userEvent.setup();
		await waitForAgentCatalog();

		await user.type(screen.getByLabelText("Title"), "Tune worker runtime");
		await user.type(screen.getByLabelText("Brief"), "Use the selected runtime profile.");

		await user.click(screen.getByRole("combobox", { name: "Model" }));
		await user.click(await screen.findByRole("option", { name: "Claude Opus (latest)" }));
		await user.click(screen.getByRole("combobox", { name: "Effort" }));
		await user.click(await screen.findByRole("option", { name: "High" }));
		await user.click(screen.getByRole("combobox", { name: "Permission" }));
		await user.click(await screen.findByRole("option", { name: "Automatic" }));

		await user.click(screen.getByRole("button", { name: "Start task" }));
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(spawnBody().agentConfig).toEqual({
			model: "opus",
			reasoningEffort: "high",
			permissions: "auto",
		});
	});

	it("remembers the last model, effort, and permission choices for the next task", async () => {
		const first = renderDialog();
		const user = userEvent.setup();
		await waitForAgentCatalog();

		await user.click(screen.getByRole("combobox", { name: "Model" }));
		await user.click(await screen.findByRole("option", { name: "Claude Opus (latest)" }));
		await user.click(screen.getByRole("combobox", { name: "Effort" }));
		await user.click(await screen.findByRole("option", { name: "High" }));
		await user.click(screen.getByRole("combobox", { name: "Permission" }));
		await user.click(await screen.findByRole("option", { name: "Automatic" }));
		first.unmount();

		renderDialog();
		await waitForAgentCatalog();
		await waitFor(() => {
			expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent("Claude Opus (latest)");
			expect(screen.getByRole("combobox", { name: "Effort" })).toHaveTextContent("High");
			expect(screen.getByRole("combobox", { name: "Permission" })).toHaveTextContent("Automatic");
		});
	});

	it("locks every new subagent to complete access while bypass mode is enabled", async () => {
		projectConfig = {
			autoBypassWorkerPermissions: true,
			worker: { agent: "claude-code" },
		};
		renderDialog();
		const user = userEvent.setup();
		await waitForAgentCatalog();

		expect(screen.getByRole("combobox", { name: "Permission" })).toBeDisabled();
		expect(screen.getByText("All subagents have complete access.")).toBeInTheDocument();
		await user.type(screen.getByLabelText("Title"), "Run without prompts");
		await user.type(screen.getByLabelText("Brief"), "Keep all work in the orchestrator conversation.");
		await user.click(screen.getByRole("button", { name: "Start task" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(spawnBody().agentConfig).toEqual({
			model: undefined,
			reasoningEffort: undefined,
			permissions: "bypass-permissions",
		});
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

		await user.type(screen.getByLabelText("Title"), "T");
		await user.type(screen.getByLabelText("Brief"), "B");
		await user.click(screen.getByRole("button", { name: "Start task" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(spawnBody().harness).toBe("kiro");
	});

	it("requires both title and brief", async () => {
		renderDialog();
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: "Start task" }));

		expect(await screen.findByText("Title and brief are required.")).toBeInTheDocument();
		expect(postMock).not.toHaveBeenCalled();
	});

	it.each([
		{
			code: "AGENT_BINARY_NOT_FOUND",
			message: "agent binary not found on PATH",
		},
		{
			code: "RUNTIME_PREREQUISITE_MISSING",
			message: "tmux required on macOS/Linux but not in PATH",
		},
		{
			code: "INTERNAL",
			message: "runtime launch failed",
		},
	])("displays daemon spawn errors for $code", async ({ code, message }) => {
		postMock.mockResolvedValueOnce({
			data: undefined,
			error: { code, message },
		});
		renderDialog();
		const user = userEvent.setup();
		await waitForAgentCatalog();

		await user.type(screen.getByLabelText("Title"), "Fix fallback renderer");
		await user.type(screen.getByLabelText("Brief"), "Restore fallback renderer.");
		await user.click(screen.getByRole("button", { name: "Start task" }));

		expect(await screen.findByText(`${message} (${code})`)).toBeInTheDocument();
	});
});
