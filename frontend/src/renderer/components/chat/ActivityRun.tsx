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
import { ACTIVITY_SUMMARY_BUTTON_CLASS, commandCategory } from "./activity-command";
import type { ConversationActivity } from "../../types/conversation";

export function ActivityRun({ activities }: { activities: ConversationActivity[] }) {
	// null until someone decides, so a run holding a command that is printing right
	// now can open itself and close again once everything settles. A click pins the
	// choice either way.
	const [override, setOverride] = useState<boolean | null>(null);
	const running = activities.some((a) => a.status === "running");
	const failed = activities.filter((a) => a.status === "failed").length;
	const cancelled = activities.filter((a) => a.status === "cancelled").length;

	// A single call is its own best summary — collapsing one row into a count of
	// one would be worse than just showing it.
	const hierarchy = buildHierarchy(activities);
	if (activities.length === 1 && hierarchy[0]?.children.length === 0) {
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
				className={ACTIVITY_SUMMARY_BUTTON_CLASS}
			>
				<span className="text-[11.5px] text-muted-foreground">{summarize(activities)}</span>
				{failed > 0 ? (
					<span className="text-[11px] text-destructive">
						{failed} failed
					</span>
				) : null}
				{cancelled > 0 ? (
					<span className="text-[11px] text-muted-foreground/70">
						{cancelled} stopped
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
				<div className="cursor-chat-activity-panel mt-0.5 flex flex-col overflow-hidden rounded-md border border-border">
					{hierarchy.map((node) => <ActivityTree key={node.activity.id} node={node} />)}
				</div>
			) : null}
		</div>
	);
}

type ActivityNode = { activity: ConversationActivity; children: ActivityNode[] };

function ActivityTree({ node }: { node: ActivityNode }) {
	return (
		<div className="flex flex-col">
			<ActivityRow activity={node.activity} />
			{node.children.length > 0 ? <NestedAgentRun nodes={node.children} /> : null}
		</div>
	);
}

function NestedAgentRun({ nodes }: { nodes: ActivityNode[] }) {
	const [open, setOpen] = useState(false);
	const count = countNodes(nodes);
	const running = nodes.some(nodeRunning);
	return (
		<div className="mx-3 mb-2 ml-8 overflow-hidden rounded-md border border-border/70 bg-background/40">
			<button
				type="button"
				onClick={() => setOpen((current) => !current)}
				aria-label={`Subagent ${count} ${count === 1 ? "step" : "steps"}`}
				aria-expanded={open}
				className="flex min-h-8 w-full items-center gap-2 px-2.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-interactive-hover"
			>
				<ChevronRight aria-hidden="true" className={cn("size-3 transition-transform", open && "rotate-90")} />
				<span className="font-medium text-foreground/80">Subagent</span>
				<span>{count} {count === 1 ? "step" : "steps"}</span>
				{running ? <Loader2 aria-hidden="true" className="ml-auto size-3 animate-spin" /> : null}
			</button>
			{open ? (
				<div className="border-t border-border/70">
					{nodes.map((node) => <ActivityTree key={node.activity.id} node={node} />)}
				</div>
			) : null}
		</div>
	);
}

function buildHierarchy(activities: ConversationActivity[]): ActivityNode[] {
	const byProvider = new Map<string, ActivityNode>();
	const nodes = activities.map((activity) => {
		const node = { activity, children: [] } satisfies ActivityNode;
		if (activity.providerItemId) byProvider.set(activity.providerItemId, node);
		return node;
	});
	const roots: ActivityNode[] = [];
	for (const node of nodes) {
		const parentId = node.activity.detail?.parentProviderItemId;
		const parent = parentId ? byProvider.get(parentId) : undefined;
		if (parent && !wouldCreateCycle(node, parent, byProvider)) parent.children.push(node);
		else roots.push(node);
	}
	return roots;
}

function wouldCreateCycle(
	node: ActivityNode,
	parent: ActivityNode,
	byProvider: Map<string, ActivityNode>,
): boolean {
	const visited = new Set<ActivityNode>([node]);
	let current: ActivityNode | undefined = parent;
	while (current) {
		if (visited.has(current)) return true;
		visited.add(current);
		const parentId: string | undefined = current.activity.detail?.parentProviderItemId;
		current = parentId ? byProvider.get(parentId) : undefined;
	}
	return false;
}

function countNodes(nodes: ActivityNode[]): number {
	return nodes.reduce((count, node) => count + 1 + countNodes(node.children), 0);
}

function nodeRunning(node: ActivityNode): boolean {
	return node.activity.status === "running" || node.children.some(nodeRunning);
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
		switch (commandCategory(activity.detail?.command ?? activity.summary)) {
			case "read":
				reads += 1;
				break;
			case "search":
				searches += 1;
				break;
			case "vcs":
				vcs += 1;
				break;
			default:
				other += 1;
		}
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
