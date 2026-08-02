/**
 * A run of consecutive tool calls, collapsed to one line.
 *
 * The agent may run fifteen commands to answer one question. Rendering each as
 * its own row turns the conversation into a log: the prose that actually answers
 * the question gets pushed off screen by the mechanics of finding it.
 *
 * So a run summarizes itself — "Explored 4 files, 3 searches" — and expands to the
 * individual calls only when asked. The summary is not decoration: it counts what
 * the agent did by category, so a reader can tell "it looked around" from "it
 * changed something" without opening anything.
 */

import { useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { ActivityRow } from "./ChatTimelineItems";
import type { ConversationActivity } from "../../types/conversation";

/** Commands that read a file's contents. */
const READERS = new Set(["cat", "sed", "nl", "head", "tail", "bat", "less", "more", "wc", "jq"]);
/** Commands that search for files or content. */
const SEARCHERS = new Set(["rg", "grep", "find", "fd", "ls", "tree", "glob", "ag"]);
/** Commands that inspect version control. */
const VCS = new Set(["git", "gh"]);

export function ActivityRun({ activities }: { activities: ConversationActivity[] }) {
	// null until someone decides, so a run holding a command that is printing right
	// now can open itself and close again once everything settles. A click pins the
	// choice either way.
	const [override, setOverride] = useState<boolean | null>(null);
	const running = activities.some((a) => a.status === "running");
	const failed = activities.filter((a) => a.status === "failed").length;

	// A single call is its own best summary — collapsing one row into a count of
	// one would be worse than just showing it.
	if (activities.length === 1) {
		return <ActivityRow activity={activities[0]!} />;
	}

	// Otherwise a command streaming output inside a run stays hidden behind this
	// summary line, and the live output is live to nobody.
	const streamingOutput = activities.some((a) => a.status === "running" && Boolean(a.detail?.output));
	const open = override ?? streamingOutput;

	return (
		<div className="flex flex-col">
			<button
				type="button"
				onClick={() => setOverride(!open)}
				aria-expanded={open}
				className="group/run flex w-full items-center gap-1.5 rounded-sm py-0.5 pr-1 text-left transition-colors hover:bg-interactive-hover"
			>
				<span className="text-[11.5px] text-muted-foreground">{summarize(activities)}</span>
				{failed > 0 ? (
					<span className="text-[11px] text-destructive">
						{failed} failed
					</span>
				) : null}
				{running ? (
					<Loader2 aria-hidden="true" className="size-3 animate-spin text-muted-foreground/60" />
				) : null}
				{/* Always visible: the line has to read as openable, or a reader who
				    wants the detail has no reason to think it is there. */}
				<ChevronRight
					aria-hidden="true"
					className={cn(
						"size-3 shrink-0 text-muted-foreground/40 transition-transform group-hover/run:text-muted-foreground",
						open && "rotate-90",
					)}
				/>
			</button>

			{open ? (
				<div className="mt-0.5 flex flex-col overflow-hidden rounded-lg border border-border bg-surface/40">
					{activities.map((activity) => (
						<ActivityRow key={activity.id} activity={activity} />
					))}
				</div>
			) : null}
		</div>
	);
}

/**
 * Describe a run by what it did, not by how many rows it has.
 *
 * "Ran 15 commands" tells the reader nothing they can act on. "Explored 6 files,
 * 4 searches" tells them the agent was looking rather than changing — which is
 * the distinction that decides whether they need to open it.
 */
function summarize(activities: ConversationActivity[]): string {
	let reads = 0;
	let searches = 0;
	let vcs = 0;
	let other = 0;
	let plans = 0;
	let tools = 0;
	let reviews = 0;

	for (const activity of activities) {
		if (activity.activityKind === "plan") {
			plans += 1;
			continue;
		}
		// Counted apart from commands, and named apart, because that is the whole
		// distinction the kind exists to draw: nothing ran in the worktree.
		if (activity.activityKind === "mcp_tool") {
			tools += 1;
			continue;
		}
		if (activity.activityKind === "auto_review") {
			reviews += 1;
			continue;
		}
		const binary = firstWord(activity.detail?.command ?? activity.summary);
		if (READERS.has(binary)) reads += 1;
		else if (SEARCHERS.has(binary)) searches += 1;
		else if (VCS.has(binary)) vcs += 1;
		else other += 1;
	}

	const parts: string[] = [];
	if (reads > 0) parts.push(`${reads} ${reads === 1 ? "file" : "files"}`);
	if (searches > 0) parts.push(`${searches} ${searches === 1 ? "search" : "searches"}`);
	if (vcs > 0) parts.push(`${vcs} git ${vcs === 1 ? "check" : "checks"}`);
	if (other > 0) parts.push(`${other} ${other === 1 ? "command" : "commands"}`);
	if (tools > 0) parts.push(`${tools} tool ${tools === 1 ? "call" : "calls"}`);
	// Said even though nobody was asked, because "the provider decided 3 things for
	// you" is not something a summary should quietly leave out.
	if (reviews > 0) parts.push(`${reviews} auto-${reviews === 1 ? "decision" : "decisions"}`);
	if (plans > 0) parts.push("updated plan");

	if (parts.length === 0) return `${activities.length} steps`;
	// "Explored" when the agent was reading or searching; "Ran" when it was doing.
	const verb = reads > 0 || searches > 0 ? "Explored" : "Ran";
	return `${verb} ${parts.join(", ")}`;
}

/** The command's binary, which is what classifies the call. */
function firstWord(text: string): string {
	const trimmed = text.trim();
	const space = trimmed.indexOf(" ");
	const head = space > 0 ? trimmed.slice(0, space) : trimmed;
	// Keep only the basename, so /bin/sed and sed classify the same.
	const slash = head.lastIndexOf("/");
	return slash >= 0 ? head.slice(slash + 1) : head;
}
