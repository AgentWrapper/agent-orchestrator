import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "../types/workspace";
import { TerminalPane } from "./TerminalPane";

vi.mock("../lib/api-client", () => ({
	apiClient: { POST: vi.fn() },
	apiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

vi.mock("./XtermTerminal", () => ({
	XtermTerminal: () => <div>terminal</div>,
}));

const baseSession = {
	id: "sess-a",
	terminalHandleId: "sess-a/terminal_0",
	workspaceId: "proj-1",
	workspaceName: "my-app",
	title: "Session A",
	provider: "claude-code",
	kind: "worker",
	branch: "ao/sess-a",
	status: "working",
	updatedAt: "2026-06-10T00:00:00Z",
	prs: [],
} satisfies WorkspaceSession;

function renderPane(session: WorkspaceSession) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<TerminalPane session={session} theme="dark" daemonReady fontSize={13} />
		</QueryClientProvider>,
	);
}

describe("TerminalPane message composer", () => {
	it("clears draft text when navigating between sessions", async () => {
		const user = userEvent.setup();
		const { rerender } = renderPane(baseSession);

		await user.type(screen.getByRole("textbox", { name: "Message Session A" }), "status?");

		const nextSession = { ...baseSession, id: "sess-b", terminalHandleId: "sess-b/terminal_0", title: "Session B" };
		rerender(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TerminalPane session={nextSession} theme="dark" daemonReady fontSize={13} />
			</QueryClientProvider>,
		);

		expect(screen.getByRole("textbox", { name: "Message Session B" })).toHaveValue("");
	});

	it("does not show a send composer for archived merged sessions", () => {
		renderPane({ ...baseSession, status: "merged" });

		expect(screen.queryByRole("textbox", { name: /Message/ })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
	});
});
