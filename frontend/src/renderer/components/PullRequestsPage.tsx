import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { useSCMConnections } from "../hooks/useSCMConnections";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import {
	sessionScmSummaryQueryKey,
	sessionScmSummaryQueryOptions,
	type SessionPRSummary,
} from "../hooks/useSessionScmSummary";
import {
	changeRequestNumber,
	comparePRDisplaySummaries,
	prDiffSummary,
	sessionPRDisplaySummaries,
} from "../lib/pr-display";
import type { WorkspaceSession } from "../types/workspace";
import { DashboardSubhead } from "./DashboardSubhead";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { PRSummaryParts } from "./PRSummaryDisplay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cn } from "../lib/utils";
import { scmCapabilitiesQueryOptions } from "../lib/scm-capabilities";
import { deriveProviderRepo, type SCMProvider } from "../lib/scm-repo";

type PRState = SessionPRSummary["state"];
type Project = components["schemas"]["Project"];

type PRWriteAccess = { allowed: true } | { allowed: false; readOnly: boolean };

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
	const { t } = useTranslation();
	const navigate = useNavigate();
	const workspaceQuery = useWorkspaceQuery();
	const workspaces = workspaceQuery.data ?? [];
	const sessions = workspaces.flatMap((w) => w.sessions);
	const projectQueries = useQueries({
		queries: workspaces.map((workspace) => ({
			queryKey: ["project", workspace.id] as const,
			queryFn: async (): Promise<Project> => {
				const { data, error } = await apiClient.GET("/api/v1/projects/{id}", {
					params: { path: { id: workspace.id } },
				});
				if (error) throw error;
				if (data?.status !== "ok") throw data?.project ?? {};
				return data.project as Project;
			},
			retry: 1,
		})),
	});
	const connectionsQuery = useSCMConnections();
	const projectSCM = workspaces.map((workspace, index) => {
		const project = projectQueries[index]?.data;
		const provider = (project?.config?.scm?.provider ?? "github") as SCMProvider;
		const connectionId = project?.config?.scm?.connectionId ?? "github-default";
		const connection = connectionsQuery.data?.find((candidate) => candidate.id === connectionId);
		const repository =
			project?.config?.scm?.repo?.trim() || deriveProviderRepo(project?.repo, provider, connection?.webBaseUrl) || "";
		return { connectionId, project, provider, repository, workspaceId: workspace.id };
	});
	const capabilityQueries = useQueries({
		queries: projectSCM.map((selection) => scmCapabilitiesQueryOptions(selection.connectionId, selection.repository)),
	});
	const writeAccessByProject = new Map<string, PRWriteAccess>();
	for (const [index, selection] of projectSCM.entries()) {
		if (!selection.project) {
			writeAccessByProject.set(selection.workspaceId, {
				allowed: false,
				readOnly: false,
			});
			continue;
		}
		if (selection.provider === "github" && selection.connectionId === "github-default") {
			writeAccessByProject.set(selection.workspaceId, { allowed: true });
			continue;
		}
		const capabilities = capabilityQueries[index]?.data;
		writeAccessByProject.set(
			selection.workspaceId,
			capabilities?.write
				? { allowed: true }
				: {
						allowed: false,
						readOnly: capabilities !== undefined,
					},
		);
	}
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
			<DashboardSubhead title={t("pullRequests.title")} subtitle={t("pullRequests.subtitle")} count={rows.length} />

			<div className="min-h-0 flex-1 overflow-y-auto p-4.5">
				{rows.length === 0 ? (
					<p className="py-10 text-center text-xs text-passive">{t("pullRequests.empty")}</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-pr-col-number">{t("pullRequests.columns.request")}</TableHead>
								<TableHead>{t("pullRequests.columns.worker")}</TableHead>
								<TableHead className="w-pr-col-state">{t("pullRequests.columns.state")}</TableHead>
								<TableHead className="w-pr-table-actions text-right">{t("pullRequests.columns.actions")}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((row) => (
								<PRRowView
									key={`${row.session.id}-${row.pr.url}`}
									row={row}
									writeAccess={
										writeAccessByProject.get(row.session.workspaceId) ?? {
											allowed: false,
											readOnly: false,
										}
									}
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

function PRRowView({ row, onOpen, writeAccess }: { row: PRRow; onOpen: () => void; writeAccess: PRWriteAccess }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [note, setNote] = useState<
		| { kind: "merged"; method: string }
		| { kind: "resolved" }
		| { kind: "mergeError" | "resolveError"; error: unknown }
		| null
	>(null);
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		void queryClient.invalidateQueries({ queryKey: sessionScmSummaryQueryKey() });
	};

	const merge = useMutation({
		mutationFn: async () => {
			const { data, error } = await apiClient.POST("/api/v1/prs/{id}/merge", {
				params: { path: { id: String(row.pr.number) } },
				body: { sessionId: row.session.id, prUrl: row.pr.url, expectedHeadSha: row.pr.headSha },
			});
			if (error) throw error;
			return data;
		},
		onSuccess: (data) => {
			setNote({ kind: "merged", method: data?.method ?? "squash" });
			refresh();
		},
		onError: (error) => setNote({ kind: "mergeError", error }),
	});

	const resolve = useMutation({
		mutationFn: async () => {
			const { error } = await apiClient.POST("/api/v1/prs/{id}/resolve-comments", {
				params: { path: { id: String(row.pr.number) } },
				body: { sessionId: row.session.id, prUrl: row.pr.url },
			});
			if (error) throw error;
		},
		onSuccess: () => {
			setNote({ kind: "resolved" });
			refresh();
		},
		onError: (error) => setNote({ kind: "resolveError", error }),
	});

	const actionable = row.pr.state === "open" || row.pr.state === "draft";
	const mergeReady = writeAccess.allowed && Boolean(row.pr.headSha.trim());

	return (
		<TableRow className="cursor-pointer" onClick={onOpen}>
			<TableCell className="font-mono text-xs text-muted-foreground">{changeRequestNumber(row.pr)}</TableCell>
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
					{t(`changeRequests.states.${row.pr.state}`)}
				</Badge>
			</TableCell>
			<TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
				{note ? (
					<span
						className={cn(
							"text-caption",
							note.kind === "merged" || note.kind === "resolved" ? "text-success" : "text-error",
						)}
					>
						{note.kind === "merged"
							? t("pullRequests.notes.merged", { method: note.method })
							: note.kind === "resolved"
								? t("pullRequests.notes.resolved")
								: apiErrorMessage(
										note.error,
										t(note.kind === "mergeError" ? "pullRequests.errors.merge" : "pullRequests.errors.resolve"),
									)}
					</span>
				) : actionable ? (
					<div className="flex flex-col items-end gap-1">
						<div className="flex items-center justify-end gap-1.5">
							<Button
								size="sm"
								variant="ghost"
								className="h-6 px-2 text-caption"
								disabled={resolve.isPending || !writeAccess.allowed}
								onClick={() => writeAccess.allowed && resolve.mutate()}
							>
								{resolve.isPending ? "…" : t("pullRequests.actions.resolve")}
							</Button>
							<Button
								size="sm"
								variant="primary"
								className="h-6 px-2 text-caption"
								disabled={merge.isPending || !mergeReady}
								onClick={() => mergeReady && merge.mutate()}
							>
								{merge.isPending ? t("pullRequests.actions.merging") : t("pullRequests.actions.merge")}
							</Button>
						</div>
						{(!writeAccess.allowed || !row.pr.headSha) && (
							<span className="max-w-pr-table-actions whitespace-normal text-right text-micro text-warning">
								{writeAccess.allowed
									? t("pullRequests.capabilities.detailsUnavailable")
									: writeAccess.readOnly
										? t("pullRequests.capabilities.readOnly")
										: t("pullRequests.capabilities.unverified")}
							</span>
						)}
					</div>
				) : (
					<span className="text-caption text-passive">—</span>
				)}
			</TableCell>
		</TableRow>
	);
}
