import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "../types/workspace";
import { CenterPane } from "./CenterPane";

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
	it("shows the session display name for a worker", () => {
		render(<CenterPane session={worker} theme="dark" daemonReady />);
		expect(screen.getByText("do the thing")).toBeInTheDocument();
		expect(screen.queryByText("sess-1")).not.toBeInTheDocument();
	});

	it("shows the descriptive session display name for an orchestrator session", () => {
		render(
			<CenterPane
				session={{ ...worker, id: "sess-orch", kind: "orchestrator", title: "agent-orchestrator Orchestrator" }}
				theme="dark"
				daemonReady
			/>,
		);
		expect(screen.getByText("agent-orchestrator Orchestrator")).toBeInTheDocument();
	});

	it("shows 'No session' when there is no session", () => {
		render(<CenterPane theme="dark" daemonReady />);
		expect(screen.getByText("No session")).toBeInTheDocument();
	});
});

describe("CenterPane scrollback control", () => {
	let bridge: typeof window.ao;

	beforeEach(() => {
		window.localStorage.clear();
	});

	afterEach(() => {
		if (bridge !== undefined) window.ao = bridge;
		bridge = undefined;
	});

	it("exposes a configurable scrollback control in browser mode and persists changes", async () => {
		bridge = window.ao;
		delete window.ao;
		const user = userEvent.setup();
		render(<CenterPane session={worker} theme="dark" daemonReady />);

		// Default cap surfaced in the toolbar.
		expect(screen.getByText(/5,000 sb/)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Increase terminal scrollback" }));
		expect(screen.getByText(/6,000 sb/)).toBeInTheDocument();
		expect(window.localStorage.getItem("ao.terminal.scrollback")).toBe("6000");
	});

	it("hides the scrollback control in Electron mode (scrollback is fixed at 0 there)", () => {
		// window.ao is present in the jsdom test bridge — Electron mode.
		expect(window.ao).toBeDefined();
		render(<CenterPane session={worker} theme="dark" daemonReady />);
		expect(screen.queryByRole("button", { name: "Increase terminal scrollback" })).not.toBeInTheDocument();
		expect(screen.queryByText(/sb$/)).not.toBeInTheDocument();
	});
});
