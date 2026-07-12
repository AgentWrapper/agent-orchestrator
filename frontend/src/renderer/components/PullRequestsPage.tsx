import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import {
	sessionScmSummaryQueryKey,
	sessionScmSummaryQueryOptions,
	type SessionPRSummary,
} from "../hooks/useSessionScmSummary";
import { comparePRDisplaySummaries, prDiffSummary, sessionPRDisplaySummaries } from "../lib/pr-display";
import type { WorkspaceSession } from "../types/workspace";
import { DashboardSubhead } from "./DashboardSubhead";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
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
// flatMap the session's prs list rather than assuming one. Actions hit
// /prs/{number}/merge and /resolve-comments. Per-PR CI/review facts also live on
// the session route's inspector.
export function PullRequestsPage() {
	const navigate = useNavigate();
	const workspaceQuery = useWorkspaceQuery();
	const sessions = (workspaceQuery.data ?? []).flatMap((w) => w.sessions);
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
				subtitle="Open PRs across every agent session, ready to resolve and merge."
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
								<TableHead className="w-pr-table-actions text-right">Actions</TableHead>
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
	const queryClient = useQueryClient();
	const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		void queryClient.invalidateQueries({ queryKey: sessionScmSummaryQueryKey() });
	};

	const merge = useMutation({
		mutationFn: async () => {
			const { data, error } = await apiClient.POST("/api/v1/prs/{id}/merge", {
				params: { path: { id: String(row.pr.number) } },
			});
			if (error) throw new Error(apiErrorMessage(error));
			return data;
		},
		onSuccess: (data) => {
			setNote({ ok: true, text: `merged (${data?.method ?? "squash"})` });
			refresh();
		},
		onError: (e) => setNote({ ok: false, text: e instanceof Error ? e.message : "merge failed" }),
	});

	const resolve = useMutation({
		mutationFn: async () => {
			const { error } = await apiClient.POST("/api/v1/prs/{id}/resolve-comments", {
				params: { path: { id: String(row.pr.number) } },
			});
			if (error) throw new Error(apiErrorMessage(error));
		},
		onSuccess: () => {
			setNote({ ok: true, text: "comments resolved" });
			refresh();
		},
		onError: (e) => setNote({ ok: false, text: e instanceof Error ? e.message : "resolve failed" }),
	});

	const actionable = row.pr.state === "open" || row.pr.state === "draft";

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
			<TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
				{note ? (
					<span className={cn("text-caption", note.ok ? "text-success" : "text-error")}>{note.text}</span>
				) : actionable ? (
					<div className="flex items-center justify-end gap-1.5">
						<Button
							size="sm"
							variant="ghost"
							className="h-6 px-2 text-caption"
							disabled={resolve.isPending}
							onClick={() => resolve.mutate()}
						>
							{resolve.isPending ? "…" : "Resolve"}
						</Button>
						<Button
							size="sm"
							variant="primary"
							className="h-6 px-2 text-caption"
							disabled={merge.isPending}
							onClick={() => merge.mutate()}
						>
							{merge.isPending ? "Merging…" : "Merge"}
						</Button>
					</div>
				) : (
					<span className="text-caption text-passive">—</span>
				)}
			</TableCell>
		</TableRow>
	);
}
