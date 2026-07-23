import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function spawnBody() {
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

	it("attaches a pasted image as a numbered chip and sends it in the spawn body", async () => {
		renderDialog();
		const user = userEvent.setup();
		await waitForAgentCatalog();

		const brief = screen.getByLabelText("Brief");
		const png = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
		fireEvent.paste(brief, { clipboardData: { files: [png], items: [] } });

		expect(await screen.findByText("Image 1")).toBeInTheDocument();

		await user.type(screen.getByLabelText("Title"), "T");
		await user.type(brief, "B");
		await user.click(screen.getByRole("button", { name: "Start task" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		const attachments = spawnBody().attachments as Array<{ mimeType: string; data: string }>;
		expect(attachments).toHaveLength(1);
		expect(attachments[0].mimeType).toBe("image/png");
		expect(attachments[0].data.length).toBeGreaterThan(0);
	});

	it("removes an attached image and renumbers the remaining chips", async () => {
		renderDialog();
		const user = userEvent.setup();
		await waitForAgentCatalog();

		const brief = screen.getByLabelText("Brief");
		const a = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
		const b = new File([new Uint8Array([4, 5, 6])], "b.png", { type: "image/png" });
		fireEvent.paste(brief, { clipboardData: { files: [a, b], items: [] } });

		expect(await screen.findByText("Image 1")).toBeInTheDocument();
		expect(screen.getByText("Image 2")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Remove image 1" }));

		await waitFor(() => expect(screen.queryByText("Image 2")).not.toBeInTheDocument());
		expect(screen.getByText("Image 1")).toBeInTheDocument();
	});

	it("ignores a paste that carries no image", async () => {
		renderDialog();
		await waitForAgentCatalog();

		const brief = screen.getByLabelText("Brief");
		fireEvent.paste(brief, { clipboardData: { files: [], items: [] } });

		expect(screen.queryByText("Image 1")).not.toBeInTheDocument();
	});

	it("caps attachments at 8 and shows an inline error instead of a late submit rejection", async () => {
		renderDialog();
		await waitForAgentCatalog();

		const brief = screen.getByLabelText("Brief");
		const files = Array.from(
			{ length: 10 },
			(_, i) => new File([new Uint8Array([i + 1])], `shot-${i}.png`, { type: "image/png" }),
		);
		fireEvent.paste(brief, { clipboardData: { files, items: [] } });

		expect(await screen.findByText("Image 8")).toBeInTheDocument();
		expect(screen.queryByText("Image 9")).not.toBeInTheDocument();
		expect(screen.getByText(/up to 8 images/i)).toBeInTheDocument();
	});

	it("requires both title and brief", async () => {
		renderDialog();
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: "Start task" }));

		expect(await screen.findByText("Title and brief are required.")).toBeInTheDocument();
		expect(postMock).not.toHaveBeenCalled();
	});

	it("submits on Enter and inserts a newline on Shift+Enter in the brief", async () => {
		renderDialog();
		const user = userEvent.setup();
		await waitForAgentCatalog();

		await user.type(screen.getByLabelText("Title"), "Fix fallback renderer");
		const brief = screen.getByLabelText("Brief");
		await user.type(brief, "First line");
		// Shift+Enter must NOT submit — it adds a newline.
		await user.keyboard("{Shift>}{Enter}{/Shift}");
		await user.type(brief, "Second line");
		expect(postMock).not.toHaveBeenCalled();

		// Plain Enter submits the task.
		await user.keyboard("{Enter}");
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(spawnBody().prompt).toContain("\n");
	});

	it("does not submit on Alt+Enter or Shift+Enter but does on plain Enter in the brief", async () => {
		renderDialog();
		const user = userEvent.setup();
		await waitForAgentCatalog();

		await user.type(screen.getByLabelText("Title"), "Fix fallback renderer");
		const brief = screen.getByLabelText("Brief");
		await user.type(brief, "Line");

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
