import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SUGGESTION_DISCUSSION_ISSUE_PREFIX, type WorkspaceSession } from "../types/workspace";
import { CenterPane } from "./CenterPane";

// The terminal body pulls in xterm/SSE machinery irrelevant to the toolbar under test.
vi.mock("./TerminalPane", () => ({
	TerminalPane: ({ viewMode }: { viewMode?: string }) => (
		<div data-testid="terminal-body" data-view-mode={viewMode}>
			terminal body
		</div>
	),
}));

const worker = {
	id: "sess-1",
	workspaceId: "proj-1",
	workspaceName: "my-app",
	title: "do the thing",
	provider: "claude-code",
	kind: "worker",
	branch: "ao/sess-1",
	status: "working",
	updatedAt: "2026-06-10T00:00:00Z",
	prs: [],
} satisfies WorkspaceSession;

describe("CenterPane toolbar session label", () => {
	it("shows the session display name for a worker", () => {
		render(<CenterPane session={worker} theme="dark" daemonReady />);
		expect(screen.getByText("do the thing")).toBeInTheDocument();
		expect(screen.queryByText("sess-1")).not.toBeInTheDocument();
	});

	it("shows 'Orchestrator' for an orchestrator session", () => {
		render(<CenterPane session={{ ...worker, id: "sess-orch", kind: "orchestrator" }} theme="dark" daemonReady />);
		expect(screen.getByText("Orchestrator")).toBeInTheDocument();
	});

	it("defaults orchestrators to the desktop conversation view and keeps the terminal available", () => {
		render(
			<CenterPane
				session={{ ...worker, id: "sess-orch", kind: "orchestrator" }}
				projectSessions={[worker]}
				theme="dark"
				daemonReady
			/>,
		);

		expect(screen.getByLabelText("Orbit profile, powered by Claude")).toBeInTheDocument();
		expect(screen.getByAltText("Claude logo")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Show conversation" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByTestId("terminal-body")).toHaveAttribute("data-view-mode", "conversation");
		expect(screen.getByRole("button", { name: "Show review board" })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Show review board" }));
		expect(screen.getByRole("button", { name: "Show review board" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByTestId("terminal-body")).toHaveAttribute("data-view-mode", "review");

		fireEvent.click(screen.getByRole("button", { name: "Show terminal" }));
		expect(screen.getByRole("button", { name: "Show terminal" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByTestId("terminal-body")).toHaveAttribute("data-view-mode", "terminal");
		expect(screen.getByRole("button", { name: "Decrease terminal font size" })).toBeInTheDocument();
	});

	it("opens marked suggestion discussion workers as a conversation", () => {
		render(
			<CenterPane
				session={{ ...worker, issueId: `${SUGGESTION_DISCUSSION_ISSUE_PREFIX}Refine cache` }}
				theme="dark"
				daemonReady
			/>,
		);

		expect(screen.getByText("Suggestion discussion")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Show conversation" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.queryByRole("button", { name: "Show review board" })).not.toBeInTheDocument();
		expect(screen.getByTestId("terminal-body")).toHaveAttribute("data-view-mode", "conversation");
	});

	it("shows 'No session' when there is no session", () => {
		render(<CenterPane theme="dark" daemonReady />);
		expect(screen.getByText("No session")).toBeInTheDocument();
	});
});
