import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "../types/workspace";
import { CenterPane } from "./CenterPane";
import { i18n } from "../i18n";

// The terminal body pulls in xterm/SSE machinery irrelevant to the toolbar under test.
vi.mock("./TerminalPane", () => ({ TerminalPane: () => <div>terminal body</div> }));

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
	it("switches toolbar controls to Chinese immediately while preserving the session title", async () => {
		render(<CenterPane session={worker} theme="dark" daemonReady />);

		await act(async () => i18n.changeLanguage("zh-CN"));

		expect(screen.getByText("终端")).toBeInTheDocument();
		expect(screen.getByText("do the thing")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "减小终端字体" })).toBeInTheDocument();
	});

	it("shows the session display name for a worker", () => {
		render(<CenterPane session={worker} theme="dark" daemonReady />);
		expect(screen.getByText("do the thing")).toBeInTheDocument();
		expect(screen.queryByText("sess-1")).not.toBeInTheDocument();
	});

	it("shows 'Orchestrator' for an orchestrator session", () => {
		render(<CenterPane session={{ ...worker, id: "sess-orch", kind: "orchestrator" }} theme="dark" daemonReady />);
		expect(screen.getByText("Orchestrator")).toBeInTheDocument();
	});

	it("shows 'No session' when there is no session", () => {
		render(<CenterPane theme="dark" daemonReady />);
		expect(screen.getByText("No session")).toBeInTheDocument();
	});
});
