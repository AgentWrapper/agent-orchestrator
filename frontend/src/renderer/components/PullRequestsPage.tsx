import { useNavigate } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { sessionScmSummaryQueryOptions, type SessionPRSummary } from "../hooks/useSessionScmSummary";
import { comparePRDisplaySummaries, prDiffSummary, sessionPRDisplaySummaries } from "../lib/pr-display";
import type { WorkspaceSession } from "../types/workspace";
import { DashboardSubhead } from "./DashboardSubhead";
import { Badge } from "./ui/badge";
import { PRSummaryParts } from "./PRSummaryDisplay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cn } from "../lib/utils";

type PRState = SessionPRSummary["state"];

const stateTone: Record<PRState, string> = {
	open: "border-success/40 bg-success/10 text-success",
	draft: "border-border bg-raised text-muted-foreground",
	merged: "border-accent/40 bg-accent-weak text-accent",
	closed: "border-error/40 bg-error/10 text-error",
};

type PRRow = {
	pr: SessionPRSummary;
	session: WorkspaceSession;
};

// The PR board, ported from agent-orchestrator's PullRequestsPage. One row per
// attributed PR — a session can own several (a stack or independent PRs), so we
// flatMap the session's prs list rather than assuming one. Per-PR CI/review
// facts also live on the session route's inspector.
//
// The board is READ-ONLY (#293 M7). It used to render Merge and Resolve buttons,
// but no repository-aware SCM action service ever existed, so the mutation
// endpoints they targeted were removed entirely (#313). Review and merge PRs on
// your SCM provider; bring the controls back only alongside a real action service.
export function PullRequestsPage() {
	const navigate = useNavigate();
	const workspaceQuery = useWorkspaceQuery();
	const sessions = (workspaceQuery.data?.workspaces ?? []).flatMap((w) => w.sessions);
	const prQueries = useQueries({
		queries: sessions.map((session) => sessionScmSummaryQueryOptions(session.id)),
	});
	const rows: PRRow[] = sessions
		.flatMap((session, index) =>
			sessionPRDisplaySummaries(session, prQueries[index]?.data).map((pr) => ({ pr, session })),
		)
		.sort((a, b) => comparePRDisplaySummaries(a.pr, b.pr));

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<DashboardSubhead
				title="Pull requests"
				subtitle="Open PRs across every agent session. Review and merge them on your SCM provider."
				count={rows.length}
			/>

			<div className="min-h-0 flex-1 overflow-y-auto p-4.5">
				{rows.length === 0 ? (
					<p className="py-10 text-center text-xs text-passive">No open pull requests.</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-pr-col-number">PR</TableHead>
								<TableHead>Worker</TableHead>
								<TableHead className="w-pr-col-state">State</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((row) => (
								<PRRowView
									key={`${row.session.id}-${row.pr.number}`}
									row={row}
									onOpen={() =>
										void navigate({
											to: "/projects/$projectId/sessions/$sessionId",
											params: { projectId: row.session.workspaceId, sessionId: row.session.id },
										})
									}
								/>
							))}
						</TableBody>
					</Table>
				)}
			</div>
		</div>
	);
}

function PRRowView({ row, onOpen }: { row: PRRow; onOpen: () => void }) {
	return (
		<TableRow className="cursor-pointer" onClick={onOpen}>
			<TableCell className="font-mono text-xs text-muted-foreground">#{row.pr.number}</TableCell>
			<TableCell className="max-w-0">
				<div className="truncate text-control text-foreground">{row.pr.title || row.session.title}</div>
				<div className="truncate font-mono text-micro text-passive">
					{[
						row.session.workspaceName,
						row.pr.sourceBranch || row.session.branch,
						row.pr.targetBranch ? `-> ${row.pr.targetBranch}` : "",
						prDiffSummary(row.pr),
					]
						.filter(Boolean)
						.join(" · ")}
				</div>
				<PRSummaryParts className="mt-1" maxLinks={2} pr={row.pr} />
			</TableCell>
			<TableCell>
				<Badge variant="outline" className={cn("h-5 px-1.5 text-micro font-medium", stateTone[row.pr.state])}>
					{row.pr.state}
				</Badge>
			</TableCell>
		</TableRow>
	);
}
