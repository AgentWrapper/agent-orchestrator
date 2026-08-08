import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ConversationActivity } from "../../types/conversation";
import { ActivityRun } from "./ActivityRun";

function tool(
	id: string,
	providerItemId: string,
	summary: string,
	parentProviderItemId?: string,
): ConversationActivity {
	return {
		kind: "activity",
		id,
		providerItemId,
		sequence: Number(id.replace(/\D/g, "")),
		revision: 0,
		activityKind: "mcp_tool",
		status: "completed",
		summary,
		detail: { parentProviderItemId },
		createdAt: "2026-08-04T00:00:00Z",
	};
}

function command(id: string, text: string): ConversationActivity {
	return {
		kind: "activity",
		id,
		sequence: Number(id.replace(/\D/g, "")),
		revision: 0,
		activityKind: "command",
		status: "completed",
		summary: text,
		detail: { command: text },
		createdAt: "2026-08-04T00:00:00Z",
	};
}

describe("ActivityRun spacing", () => {
	it("insets contained command rows without shifting the run summary", async () => {
		const user = userEvent.setup();
		render(
			<ActivityRun
				activities={[
					command("activity-1", "git status --short"),
					command("activity-2", "go test ./..."),
				]}
			/>,
		);

		const summary = screen.getByRole("button", { name: /Ran 1 git check, 1 command/i });
		expect(summary).not.toHaveClass("px-[11px]");
		await user.click(summary);

		expect(screen.getByText("Checked repository").closest("button")).toHaveClass("px-[11px]");
		expect(screen.getByText("Ran command").closest("button")).toHaveClass("px-[11px]");
	});
});

describe("ActivityRun nested agents", () => {
	it("keeps child-agent work under its parent and collapsed by default", async () => {
		const user = userEvent.setup();
		render(
			<ActivityRun
				activities={[
					tool("activity-1", "agent-tool", "Delegate repository scan"),
					tool("activity-2", "child-tool", "Search source files", "agent-tool"),
				]}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /Ran 2 tool calls/i }));
		expect(screen.getByRole("button", { name: /Subagent 1 step/i })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		expect(screen.queryByText("Search source files")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /Subagent 1 step/i }));
		expect(screen.getByText("Search source files")).toBeInTheDocument();
	});

	it("keeps malformed provider cycles visible at the top level", async () => {
		const user = userEvent.setup();
		render(
			<ActivityRun
				activities={[
					tool("activity-1", "tool-a", "First", "tool-b"),
					tool("activity-2", "tool-b", "Second", "tool-a"),
				]}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /Ran 2 tool calls/i }));
		expect(screen.getByText("First")).toBeInTheDocument();
		expect(screen.getByText("Second")).toBeInTheDocument();
	});
});
