import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "../types/workspace";
import {
	buildConversationGroups,
	buildConversationHistory,
	findConversationInputRequest,
	formatThinkingDuration,
	OrchestratorConversation,
} from "./OrchestratorConversation";

const postMock = vi.fn();
const saveDroppedFileMock = vi.fn();

vi.mock("../lib/api-client", () => ({
	apiClient: { POST: (...args: unknown[]) => postMock(...args) },
	apiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

const orchestrator = {
	id: "sess-orch",
	workspaceId: "proj-1",
	workspaceName: "my-app",
	title: "orchestrate",
	provider: "claude-code",
	kind: "orchestrator",
	branch: "ao/orchestrator",
	status: "working",
	updatedAt: "2026-06-10T00:00:00Z",
	prs: [],
} satisfies WorkspaceSession;

beforeEach(() => {
	window.localStorage.clear();
	postMock.mockReset();
	postMock.mockResolvedValue({ data: {} });
	saveDroppedFileMock.mockReset();
	saveDroppedFileMock.mockResolvedValue("C:\\Users\\test\\.ao\\attachments\\notes.txt");
	window.ao!.terminal.saveDroppedFile = saveDroppedFileMock;
});

afterEach(() => vi.restoreAllMocks());

describe("buildConversationGroups", () => {
	it("keeps only useful transcript blocks and summarizes each with its latest line", () => {
		expect(buildConversationGroups(["Inspecting project", "Reading files", "", "────", "", "Running tests"])).toEqual([
			{
				id: "0:Inspecting project",
				lines: ["Inspecting project", "Reading files"],
				summary: "Reading files",
			},
			{ id: "1:Running tests", lines: ["Running tests"], summary: "Running tests" },
		]);
	});

	it("reconstructs every completed prompt and response in chronological order", () => {
		const groups = buildConversationGroups([
			"> First prompt",
			"",
			"● First response",
			"",
			"> Second prompt",
			"",
			"● Second response",
		]);

		expect(buildConversationHistory(groups, false)).toEqual([
			{ id: expect.stringContaining("user:"), role: "user", text: "First prompt" },
			{ id: expect.stringContaining("assistant:"), role: "assistant", groups: [groups[1]] },
			{ id: expect.stringContaining("user:"), role: "user", text: "Second prompt" },
			{ id: expect.stringContaining("assistant:"), role: "assistant", groups: [groups[3]] },
		]);
	});

	it("turns a blocked proceed prompt into an approval request", () => {
		const groups = buildConversationGroups(["I need to run the test command.", "Do you want to proceed?"]);
		expect(
			findConversationInputRequest(
				{
					...orchestrator,
					status: "needs_input",
					activity: { state: "blocked", lastActivityAt: "2026-06-10T00:01:00Z" },
				},
				groups,
			),
		).toEqual({
			actions: [
				{ input: "1", label: "Approve once", tone: "primary" },
				{ input: "2", label: "Always allow", tone: "neutral" },
				{ input: "3", label: "Deny", tone: "neutral" },
			],
			kind: "approval",
			prompt: "Do you want to proceed?",
		});
	});
});

describe("OrchestratorConversation", () => {
	it("shows one Codex-style working indicator and toggles the full trace", () => {
		render(
			<OrchestratorConversation
				session={orchestrator}
				transcriptLines={["Inspecting project", "Reading files", "", "Running test suite", "All checks passed"]}
			/>,
		);

		const disclosure = screen.getByRole("button", { name: /Thinking.*All checks passed/ });
		expect(screen.queryByText("Inspecting project")).not.toBeInTheDocument();
		expect(screen.queryByText("Reading files")).not.toBeInTheDocument();
		expect(screen.getByText("All checks passed")).toBeInTheDocument();

		fireEvent.click(disclosure);
		expect(screen.getByText(/Inspecting project/)).toBeInTheDocument();
		expect(screen.getByText(/Running test suite/)).toBeInTheDocument();

		fireEvent.click(disclosure);
		expect(screen.queryByText(/Inspecting project/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Running test suite/)).not.toBeInTheDocument();
	});

	it("shows the completed output separately and keeps terminal chrome out of it", () => {
		render(
			<OrchestratorConversation
				session={{ ...orchestrator, status: "idle", activity: { state: "idle", lastActivityAt: "2026-06-10" } }}
				transcriptLines={[
					"> Build the campaign plan",
					"",
					"● Inspecting repository",
					"",
					"Reading the planning files",
					"",
					"● All four tasks are complete.",
					"",
					"Changed six planning documents.",
					"",
					"Verification passed.",
					"",
					"✻ Baked for 10m 22s",
					"",
					"● How is Claude doing this session?",
				]}
			/>,
		);

		const output = screen.getByLabelText("Output");
		expect(screen.getByRole("button", { name: /Finished.*Reading the planning files/ })).toBeInTheDocument();
		expect(within(output).getByText("● All four tasks are complete.")).toBeInTheDocument();
		expect(within(output).getByText("Changed six planning documents.")).toBeInTheDocument();
		expect(within(output).getByText("Verification passed.")).toBeInTheDocument();
		expect(screen.queryByText(/Baked for/)).not.toBeInTheDocument();
		expect(screen.queryByText(/How is Claude doing/)).not.toBeInTheDocument();
	});

	it("keeps the last completed output visible while showing a new turn's latest thinking", () => {
		render(
			<OrchestratorConversation
				session={orchestrator}
				transcriptLines={[
					"> First task",
					"",
					"● First task complete.",
					"",
					"Saved the result.",
					"",
					"> Follow-up task",
					"",
					"● Checking branch status",
				]}
			/>,
		);

		expect(screen.getByRole("button", { name: /Thinking.*Checking branch status/ })).toBeInTheDocument();
		expect(within(screen.getByLabelText("Output")).getByText("● First task complete.")).toBeInTheDocument();
		expect(within(screen.getByLabelText("Output")).getByText("Saved the result.")).toBeInTheDocument();
	});

	it("keeps prior turns and appends a new prompt below the previous output", async () => {
		render(
			<OrchestratorConversation
				session={{ ...orchestrator, status: "idle", activity: { state: "idle", lastActivityAt: "2026-06-10" } }}
				transcriptLines={["> First task", "", "● First task complete.", "", "Saved the result."]}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Message orchestrator"), { target: { value: "Follow-up task" } });
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() => expect(screen.getByText("Follow-up task")).toBeInTheDocument());
		expect(screen.getByRole("button", { name: /Thinking/ })).toBeInTheDocument();

		const priorOutput = screen.getByText("Saved the result.");
		const followUp = screen.getByText("Follow-up task");
		expect(priorOutput.compareDocumentPosition(followUp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("changes the clickable indicator from thinking to finished with elapsed time", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const view = render(
			<OrchestratorConversation session={orchestrator} transcriptLines={["Inspecting project"]} />,
		);

		expect(screen.getByRole("button", { name: /Thinking.*0s.*Inspecting project/ })).toBeInTheDocument();
		now.mockReturnValue(6_800);
		view.rerender(
			<OrchestratorConversation
				session={{ ...orchestrator, status: "idle", activity: { state: "idle", lastActivityAt: "2026-06-10" } }}
				transcriptLines={["Inspecting project"]}
			/>,
		);

		const finished = await screen.findByRole("button", { name: /Finished in 5s.*Inspecting project/ });
		fireEvent.click(finished);
		expect(screen.getAllByText("Inspecting project")).toHaveLength(2);
	});

	it("formats longer thinking durations compactly", () => {
		expect(formatThinkingDuration(0)).toBe("0s");
		expect(formatThinkingDuration(65_900)).toBe("1m 5s");
		expect(formatThinkingDuration(120_000)).toBe("2m");
	});

	it("requires confirmation before clearing visible chat history", () => {
		const onClearHistory = vi.fn();
		render(
			<OrchestratorConversation
				onClearHistory={onClearHistory}
				session={orchestrator}
				transcriptLines={["> Keep this", "", "● Kept response"]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Clear chat history" }));
		expect(screen.getByRole("alertdialog", { name: "Clear chat history confirmation" })).toBeInTheDocument();
		expect(screen.getByText(/Orbit keeps its working context/)).toBeInTheDocument();
		expect(onClearHistory).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Clear history now" }));
		expect(onClearHistory).toHaveBeenCalledOnce();
		expect(screen.queryByRole("alertdialog", { name: "Clear chat history confirmation" })).not.toBeInTheDocument();
	});

	it("sends messages through the existing orchestrator session", async () => {
		render(<OrchestratorConversation session={orchestrator} transcriptLines={[]} />);

		fireEvent.change(screen.getByLabelText("Message orchestrator"), { target: { value: "Continue with the tests" } });
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/send", {
				params: { path: { sessionId: "sess-orch" } },
				body: { message: "Continue with the tests" },
			}),
		);
		expect(screen.getByText("Continue with the tests")).toBeInTheDocument();
	});

	it("offers Codex-style file, access, model, and effort controls in the composer", () => {
		render(<OrchestratorConversation session={orchestrator} transcriptLines={[]} />);

		expect(screen.getByRole("button", { name: "Add files" })).toBeInTheDocument();
		expect(screen.getByLabelText("Access level")).toHaveValue("default");
		expect(screen.getByLabelText("Model choice")).toHaveValue("default");
		expect(screen.getByLabelText("Effort level")).toHaveValue("default");
		expect(screen.getByRole("option", { name: "Claude Opus" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Maximum effort" })).toBeInTheDocument();
	});

	it("attaches files and sends selected worker runtime preferences", async () => {
		render(<OrchestratorConversation session={orchestrator} transcriptLines={[]} />);
		const file = new File(["project notes"], "notes.txt", { type: "text/plain" });
		Object.defineProperty(file, "arrayBuffer", {
			value: async () => new TextEncoder().encode("project notes").buffer,
		});

		fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [file] } });
		await waitFor(() =>
			expect(saveDroppedFileMock).toHaveBeenCalledWith(expect.objectContaining({ name: "notes.txt" })),
		);
		expect(await screen.findByText("notes.txt")).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText("Access level"), { target: { value: "bypass-permissions" } });
		fireEvent.change(screen.getByLabelText("Model choice"), { target: { value: "opus" } });
		fireEvent.change(screen.getByLabelText("Effort level"), { target: { value: "high" } });
		fireEvent.change(screen.getByLabelText("Message orchestrator"), { target: { value: "Use these notes" } });
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledOnce());
		const sent = postMock.mock.calls[0]?.[1] as { body: { message: string } };
		expect(sent.body.message).toContain("Use these notes");
		expect(sent.body.message).toContain("C:\\Users\\test\\.ao\\attachments\\notes.txt");
		expect(sent.body.message).toContain(
			"Subagent runtime defaults (apply to every subagent): model=opus;effort=high;permissions=bypass-permissions.",
		);
		expect(screen.getByText("Use these notes")).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText("Message orchestrator"), { target: { value: "Continue" } });
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
		const followUp = postMock.mock.calls[1]?.[1] as { body: { message: string } };
		expect(followUp.body.message).toBe("Continue");

		fireEvent.change(screen.getByLabelText("Access level"), { target: { value: "default" } });
		fireEvent.change(screen.getByLabelText("Model choice"), { target: { value: "default" } });
		fireEvent.change(screen.getByLabelText("Effort level"), { target: { value: "default" } });
		fireEvent.change(screen.getByLabelText("Message orchestrator"), { target: { value: "Reset choices" } });
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(3));
		const reset = postMock.mock.calls[2]?.[1] as { body: { message: string } };
		expect(reset.body.message).toContain("Subagent runtime defaults: reset.");
	});

	it("remembers the last composer model, effort, and access choices", () => {
		const first = render(<OrchestratorConversation session={orchestrator} transcriptLines={[]} />);

		fireEvent.change(screen.getByLabelText("Access level"), { target: { value: "bypass-permissions" } });
		fireEvent.change(screen.getByLabelText("Model choice"), { target: { value: "opus" } });
		fireEvent.change(screen.getByLabelText("Effort level"), { target: { value: "high" } });
		first.unmount();

		render(<OrchestratorConversation session={orchestrator} transcriptLines={[]} />);
		expect(screen.getByLabelText("Access level")).toHaveValue("bypass-permissions");
		expect(screen.getByLabelText("Model choice")).toHaveValue("opus");
		expect(screen.getByLabelText("Effort level")).toHaveValue("high");
	});

	it("shows one-click approval choices without opening the terminal", () => {
		const onOpenTerminal = vi.fn();
		const onTerminalInput = vi.fn();
		render(
			<OrchestratorConversation
				onOpenTerminal={onOpenTerminal}
				onTerminalInput={onTerminalInput}
				session={{
					...orchestrator,
					status: "needs_input",
					activity: { state: "blocked", lastActivityAt: "2026-06-10T00:01:00Z" },
				}}
				transcriptLines={["I need to run a command.", "Do you want to proceed?"]}
			/>,
		);

		const actionCard = screen.getByLabelText("Action required");
		expect(actionCard).toBeInTheDocument();
		expect(screen.getByText("Approval needed")).toBeInTheDocument();
		expect(within(actionCard).getByText("Do you want to proceed?")).toBeInTheDocument();
		expect(screen.getByLabelText("Message orchestrator")).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Review request" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Approve once" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Always allow" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
		expect(onTerminalInput).toHaveBeenCalledWith("1");
		expect(onOpenTerminal).not.toHaveBeenCalled();
	});

	it("turns explicit terminal choices into Codex-style approval buttons", () => {
		const onTerminalInput = vi.fn();
		render(
			<OrchestratorConversation
				onTerminalInput={onTerminalInput}
				session={{
					...orchestrator,
					status: "needs_input",
					activity: { state: "blocked", lastActivityAt: "2026-06-10T00:01:00Z" },
				}}
				transcriptLines={["Do you want to proceed?", "› [1] Yes, proceed", "2) Yes, and always allow", "3: No, cancel"]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Yes, proceed" }));
		expect(onTerminalInput).toHaveBeenCalledWith("1");
		expect(screen.getByText("Sent: Yes, proceed")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Yes, and always allow" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "No, cancel" })).toBeDisabled();
	});

	it("focuses the reply composer for ordinary questions", () => {
		render(
			<OrchestratorConversation
				session={{
					...orchestrator,
					status: "needs_input",
					activity: { state: "waiting_input", lastActivityAt: "2026-06-10T00:01:00Z" },
				}}
				transcriptLines={["Which folder should I use?"]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Reply below" }));
		expect(screen.getByLabelText("Message orchestrator")).toHaveFocus();
	});
});
