import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ActivityRow, TurnChangedFiles } from "./ChatTimelineItems";
import { ActivityRun } from "./ActivityRun";
import type { ConversationActivity, TurnDiff } from "../../types/conversation";

// These cover the two honesty rules this surface exists to keep: a changed-file
// list never claims to be complete when it was cut, and command output always says
// which channel it came from and why it may be missing its beginning.

function diff(overrides: Partial<TurnDiff> = {}): TurnDiff {
	return {
		files: [
			{ path: "src/a.ts", additions: 12, deletions: 3, status: "modified" },
			{ path: "src/new.ts", additions: 40, deletions: 0, status: "added" },
		],
		...overrides,
	};
}

function commandActivity(
	detail: ConversationActivity["detail"],
	status: ConversationActivity["status"] = "completed",
): ConversationActivity {
	return {
		kind: "activity",
		id: "act-1",
		sequence: 1,
		revision: 1,
		activityKind: "command",
		status,
		summary: "go test ./...",
		detail,
		createdAt: new Date().toISOString(),
	};
}

describe("TurnChangedFiles", () => {
	it("summarizes the turn's totals without being expanded", () => {
		render(<TurnChangedFiles diff={diff()} />);
		expect(screen.getByText("2 files changed")).toBeInTheDocument();
		expect(screen.getByText("+52")).toBeInTheDocument();
		expect(screen.getByText("−3")).toBeInTheDocument();
	});

	it("lists path and per-file counts when expanded", async () => {
		render(<TurnChangedFiles diff={diff()} />);
		await userEvent.click(screen.getByRole("button"));

		expect(screen.getByText("src/a.ts")).toBeInTheDocument();
		expect(screen.getByText("src/new.ts")).toBeInTheDocument();
		expect(screen.getByText("+12")).toBeInTheDocument();
		expect(screen.getByText("+40")).toBeInTheDocument();
		// Status is conveyed to assistive tech, not only by a coloured letter.
		expect(screen.getByLabelText("modified")).toBeInTheDocument();
		expect(screen.getByLabelText("added")).toBeInTheDocument();
	});

	it("shows both ends of a rename, so it does not read as an addition", async () => {
		render(
			<TurnChangedFiles
				diff={{
					files: [
						{ path: "src/new.ts", oldPath: "src/old.ts", additions: 1, deletions: 1, status: "renamed" },
					],
				}}
			/>,
		);
		await userEvent.click(screen.getByRole("button"));
		expect(screen.getByText("src/old.ts")).toBeInTheDocument();
		expect(screen.getByLabelText("renamed")).toBeInTheDocument();
	});

	it("says the list was cut rather than presenting it as the whole change", async () => {
		render(<TurnChangedFiles diff={diff({ truncated: true })} />);
		await userEvent.click(screen.getByRole("button"));
		expect(screen.getByText(/changed more files than AO lists/i)).toBeInTheDocument();
	});

	it("marks a running turn's diff as still growing", () => {
		render(<TurnChangedFiles diff={diff()} live />);
		expect(screen.getByLabelText("still changing")).toBeInTheDocument();
	});

	// An agent that reports no diff must not get an empty panel implying it changed
	// nothing.
	it("renders nothing when the turn changed no files", () => {
		const { container } = render(<TurnChangedFiles diff={{ files: [] }} />);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("ActivityRow command output", () => {
	it("opens itself while a command is still printing", () => {
		const { container } = render(
			<ActivityRow
				activity={commandActivity(
					{ output: "ok  pkg/a\n", outputSource: "stream", outputMayBePartial: true },
					"running",
				)}
			/>,
		);
		// No click: live output that needs a click is not live. Read off the <pre>
		// rather than via getByText, which normalizes the runs of whitespace that
		// real command output is full of.
		const pre = container.querySelector("pre");
		expect(pre?.textContent).toBe("ok  pkg/a\n");
	});

	it("explains a streamed partial as a dropped beginning, not a generic caveat", () => {
		render(
			<ActivityRow
				activity={commandActivity(
					{ output: "tick-2\n", outputSource: "stream", outputMayBePartial: true },
					"running",
				)}
			/>,
		);
		expect(screen.getByText(/Streamed live as the command runs/i)).toBeInTheDocument();
	});

	it("names the aggregate as the provider's post-hoc roll-up", async () => {
		render(
			<ActivityRow
				activity={commandActivity({
					output: "done\n",
					outputSource: "aggregate",
					outputMayBePartial: true,
				})}
			/>,
		);
		await userEvent.click(screen.getByRole("button"));
		expect(screen.getByText(/Rolled up by the provider after the command finished/i)).toBeInTheDocument();
	});

	it("warns when output hit the storage cap", async () => {
		render(
			<ActivityRow
				activity={commandActivity({
					output: "x".repeat(64),
					outputSource: "stream",
					outputMayBePartial: true,
					outputTruncated: true,
				})}
			/>,
		);
		await userEvent.click(screen.getByRole("button"));
		expect(screen.getByText(/printed more than AO stores/i)).toBeInTheDocument();
	});

	it("keeps a finished command collapsed so the timeline stays readable", () => {
		render(
			<ActivityRow
				activity={commandActivity({ output: "ok\n", outputSource: "aggregate" }, "completed")}
			/>,
		);
		expect(screen.queryByText("ok")).not.toBeInTheDocument();
	});

	it("renders structured ACP output from conversations written by older builds", async () => {
		const structuredOutput = {
			metadata: { exit: 0, output: "metadata copy" },
			output: "command output\n",
		};
		const activity = commandActivity({ output: structuredOutput as unknown as string });
		render(<ActivityRow activity={activity} />);

		await userEvent.click(screen.getByRole("button"));
		expect(screen.getByText("command output")).toBeInTheDocument();
	});
});

// A run collapses consecutive tool calls to one line. Without the same auto-open
// rule, a command streaming output inside a run is live to nobody.
describe("ActivityRun with a streaming command", () => {
	function plan(id: string): ConversationActivity {
		return {
			kind: "activity",
			id,
			sequence: 2,
			revision: 0,
			activityKind: "plan",
			status: "completed",
			summary: "Updated plan",
			createdAt: new Date().toISOString(),
		};
	}

	it("opens itself so live output inside it is visible", () => {
		const { container } = render(
			<ActivityRun
				activities={[
					commandActivity(
						{ output: "compiling…\n", outputSource: "stream", outputMayBePartial: true },
						"running",
					),
					plan("act-2"),
				]}
			/>,
		);
		expect(container.querySelector("pre")?.textContent).toBe("compiling…\n");
	});

	it("stays collapsed when nothing inside it is printing", () => {
		const { container } = render(
			<ActivityRun
				activities={[
					commandActivity({ output: "done\n", outputSource: "aggregate" }, "completed"),
					plan("act-2"),
				]}
			/>,
		);
		expect(container.querySelector("pre")).toBeNull();
	});
});

describe("ActivityRow command labels", () => {
	it("describes read-only shell inspection as file exploration", () => {
		render(
			<ActivityRow
				activity={commandActivity(
					{
						command:
							"sed -n '1,240p' ~/.ao/dev/data/skills/using-ao/SKILL.md && sed -n '1,240p' ~/.ao/dev/data/skills/other/SKILL.md",
						output: "skill contents",
					},
					"completed",
				)}
			/>,
		);
		expect(screen.getByText("Explored 2 files")).toBeInTheDocument();
		expect(screen.queryByText(/sed -n/)).not.toBeInTheDocument();
	});

	it("describes execution as a command", () => {
		render(
			<ActivityRow
				activity={commandActivity({ command: "go test ./...", output: "ok" }, "completed")}
			/>,
		);
		expect(screen.getByText("Ran command")).toBeInTheDocument();
		expect(screen.queryByText("go test ./...")).not.toBeInTheDocument();
	});

	it("uses the same compact treatment as a grouped command summary", () => {
		const { container } = render(
			<ActivityRow
				activity={commandActivity(
					{ command: "git status --short", output: "fatal: not a repository", exitCode: 1 },
					"failed",
				)}
			/>,
		);
		const row = screen.getByRole("button");
		expect(row).toHaveClass("py-0.5", "gap-1.5", "rounded-sm");
		expect(screen.getByText("Checked repository")).toHaveClass(
			"text-[11.5px]",
			"font-normal",
			"text-muted-foreground",
		);
		expect(screen.getByText("exit 1")).toHaveClass("text-destructive");
		expect(container.querySelector(".lucide-square-terminal")).toBeNull();
		expect(row.querySelector(".flex-1")).toBeNull();
		expect(row.textContent).toMatch(/^Checked repositoryexit 1/);
	});

	it("shows an interrupted command as stopped instead of leaving a live spinner", () => {
		render(
			<ActivityRow
				activity={commandActivity({ command: "sleep 60", output: "started\n" }, "cancelled")}
			/>,
		);
		expect(screen.getByText("stopped")).toBeInTheDocument();
		expect(screen.queryByLabelText("running")).not.toBeInTheDocument();
	});
});
