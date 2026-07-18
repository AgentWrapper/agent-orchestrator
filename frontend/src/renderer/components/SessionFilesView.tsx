import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileText, Maximize2, Minimize2, RefreshCw, Search, X } from "lucide-react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type WorkspaceFileSummary = components["schemas"]["WorkspaceFileSummary"];
type WorkspaceFileDetail = components["schemas"]["WorkspaceFileResponse"];
type WorkspaceFileStatus = WorkspaceFileSummary["status"];

type SessionFilesViewProps = {
	sessionId: string;
	onClose: () => void;
	isMaximized?: boolean;
	onToggleMaximized?: (next: boolean) => void;
};

const emptyFiles: WorkspaceFileSummary[] = [];

const statusLabel: Record<WorkspaceFileStatus, string> = {
	added: "A",
	deleted: "D",
	modified: "M",
	renamed: "R",
	unmodified: "",
};

const statusTone: Record<WorkspaceFileStatus, string> = {
	added: "border-success/40 bg-success/10 text-success",
	deleted: "border-error/40 bg-error/10 text-error",
	modified: "border-warning/40 bg-warning/10 text-warning",
	renamed: "border-accent/40 bg-accent-weak text-accent",
	unmodified: "border-border bg-raised text-passive",
};

export function SessionFilesView({
	sessionId,
	onClose,
	isMaximized = false,
	onToggleMaximized,
}: SessionFilesViewProps) {
	const queryClient = useQueryClient();
	const [filter, setFilter] = useState("");
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
	const initializedExpansionFor = useRef<string | null>(null);

	const filesQuery = useQuery({
		queryKey: ["session-workspace-files", sessionId],
		refetchInterval: 3500,
		queryFn: async () => {
			const { data, error } = await apiClient.GET("/api/v1/sessions/{sessionId}/workspace/files", {
				params: { path: { sessionId } },
			});
			if (error) throw new Error(apiErrorMessage(error, "Unable to load workspace files"));
			return data ?? { sessionId, files: [], truncated: false };
		},
	});
	const files = filesQuery.data?.files ?? emptyFiles;
	const changedFiles = useMemo(() => files.filter(isChanged), [files]);

	useEffect(() => {
		initializedExpansionFor.current = null;
		setExpandedPaths(new Set());
		setFilter("");
	}, [sessionId]);

	useEffect(() => {
		if (filesQuery.isPending) return;
		if (initializedExpansionFor.current === sessionId) return;
		initializedExpansionFor.current = sessionId;
		setExpandedPaths(changedFiles[0] ? new Set([changedFiles[0].path]) : new Set());
	}, [changedFiles, filesQuery.isPending, sessionId]);

	const normalizedFilter = filter.trim().toLowerCase();
	const visibleFiles = useMemo(
		() =>
			normalizedFilter
				? changedFiles.filter((file) => file.path.toLowerCase().includes(normalizedFilter))
				: changedFiles,
		[changedFiles, normalizedFilter],
	);
	const changedCount = changedFiles.length;
	const expandedVisibleCount = visibleFiles.filter((file) => expandedPaths.has(file.path)).length;

	const refresh = () => {
		void filesQuery.refetch();
		void queryClient.invalidateQueries({ queryKey: ["session-workspace-file", sessionId] });
	};

	const toggleFile = (path: string) => {
		setExpandedPaths((current) => {
			const next = new Set(current);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			return next;
		});
	};

	const toggleVisibleFiles = () => {
		setExpandedPaths((current) => {
			const next = new Set(current);
			if (expandedVisibleCount > 0) {
				for (const file of visibleFiles) next.delete(file.path);
				return next;
			}
			for (const file of visibleFiles) next.add(file.path);
			return next;
		});
	};

	return (
		<section className="flex h-full min-h-0 flex-col bg-background text-foreground" aria-label="Session files">
			<header className="flex h-13 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
				<div className="flex min-w-0 items-center gap-2">
					<FileText className="size-icon-md shrink-0 text-passive" aria-hidden="true" />
					<h2 className="truncate text-md-sm font-semibold text-foreground">Files</h2>
					<span className="shrink-0 font-mono text-caption text-passive">
						{changedCount === 1 ? "1 file changed" : `${changedCount} files changed`}
					</span>
				</div>
				<label className="relative ml-auto min-w-0 flex-1 max-w-[360px]">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 size-icon-sm -translate-y-1/2 text-passive" />
					<Input
						className="h-8 pl-8 font-mono text-xs"
						onChange={(event) => setFilter(event.target.value)}
						placeholder="Search changed files"
						value={filter}
					/>
				</label>
				<Button
					aria-label="Refresh files"
					disabled={filesQuery.isFetching}
					onClick={refresh}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<RefreshCw className={cn("size-icon-sm", filesQuery.isFetching && "animate-spin")} aria-hidden="true" />
				</Button>
				{onToggleMaximized ? (
					<Button
						aria-label={isMaximized ? "Minimize files" : "Maximize files"}
						onClick={() => onToggleMaximized(!isMaximized)}
						size="icon-sm"
						type="button"
						variant="ghost"
					>
						{isMaximized ? (
							<Minimize2 className="size-icon-sm" aria-hidden="true" />
						) : (
							<Maximize2 className="size-icon-sm" aria-hidden="true" />
						)}
					</Button>
				) : null}
				<Button aria-label="Close files" onClick={onClose} size="icon-sm" type="button" variant="ghost">
					<X className="size-icon-sm" aria-hidden="true" />
				</Button>
			</header>

			<div className="min-h-0 flex-1 overflow-auto bg-background">
				<div className="mx-auto flex min-h-full w-full max-w-[1200px] flex-col px-6 py-5">
					<div className="mb-4 flex shrink-0 items-center gap-3">
						<h3 className="text-md-sm font-medium text-foreground">Review</h3>
						<div className="ml-auto flex items-center gap-2">
							<Button
								disabled={visibleFiles.length === 0}
								onClick={toggleVisibleFiles}
								size="sm"
								type="button"
								variant="outline"
							>
								{expandedVisibleCount > 0 ? "Collapse all" : "Expand all"}
							</Button>
						</div>
					</div>
					<ReviewFileList
						error={filesQuery.error}
						expandedPaths={expandedPaths}
						files={visibleFiles}
						isLoading={filesQuery.isPending}
						onRetry={() => void filesQuery.refetch()}
						onToggle={toggleFile}
						sessionId={sessionId}
					/>
				</div>
			</div>
		</section>
	);
}

function ReviewFileList({
	error,
	expandedPaths,
	files,
	isLoading,
	onRetry,
	onToggle,
	sessionId,
}: {
	error: Error | null;
	expandedPaths: Set<string>;
	files: WorkspaceFileSummary[];
	isLoading: boolean;
	onRetry: () => void;
	onToggle: (path: string) => void;
	sessionId: string;
}) {
	if (isLoading) {
		return <PanelMessage>Loading files...</PanelMessage>;
	}
	if (error) {
		return (
			<PanelMessage action={<RetryButton onClick={onRetry} />}>{error.message || "Unable to load files."}</PanelMessage>
		);
	}
	if (files.length === 0) {
		return <PanelMessage>No changed files found.</PanelMessage>;
	}
	return (
		<ul className="session-files-review-list overflow-hidden border-y border-border/70">
			{files.map((file) => (
				<li className="border-b border-border/60 last:border-b-0" key={file.path}>
					<ReviewFileCard
						expanded={expandedPaths.has(file.path)}
						file={file}
						onToggle={() => onToggle(file.path)}
						sessionId={sessionId}
					/>
				</li>
			))}
		</ul>
	);
}

function ReviewFileCard({
	expanded,
	file,
	onToggle,
	sessionId,
}: {
	expanded: boolean;
	file: WorkspaceFileSummary;
	onToggle: () => void;
	sessionId: string;
}) {
	const detailQuery = useQuery({
		queryKey: ["session-workspace-file", sessionId, file.path],
		enabled: expanded,
		refetchInterval: expanded ? 3500 : false,
		queryFn: () => loadWorkspaceFile(sessionId, file.path),
	});

	return (
		<article className="session-files-review-row overflow-hidden bg-transparent">
			<div className="flex min-h-14 items-center">
				<button
					aria-controls={`workspace-diff-${file.path}`}
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Expand"} ${file.path}`}
					className={cn(
						"flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition-colors",
						expanded ? "bg-interactive-active/45" : "hover:bg-interactive-hover/50",
					)}
					onClick={onToggle}
					type="button"
				>
					{expanded ? (
						<ChevronDown className="size-icon-sm shrink-0 text-passive" aria-hidden="true" />
					) : (
						<ChevronRight className="size-icon-sm shrink-0 text-passive" aria-hidden="true" />
					)}
					<StatusMark status={file.status} />
					<span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-foreground">{file.path}</span>
					<ChangeBadges additions={file.additions} deletions={file.deletions} />
				</button>
			</div>
			{expanded ? (
				<div id={`workspace-diff-${file.path}`} className="border-t border-border/60 bg-background/40">
					{detailQuery.isPending ? <PanelMessage>Loading diff...</PanelMessage> : null}
					{!detailQuery.isPending && detailQuery.error ? (
						<PanelMessage action={<RetryButton onClick={() => void detailQuery.refetch()} />}>
							{detailQuery.error.message || "Unable to load this file."}
						</PanelMessage>
					) : null}
					{!detailQuery.isPending && !detailQuery.error && detailQuery.data ? (
						<ReviewDiffBody detail={detailQuery.data} />
					) : null}
				</div>
			) : null}
		</article>
	);
}

async function loadWorkspaceFile(sessionId: string, path: string) {
	const { data, error } = await apiClient.GET("/api/v1/sessions/{sessionId}/workspace/file", {
		params: { path: { sessionId }, query: { path } },
	});
	if (error) throw new Error(apiErrorMessage(error, "Unable to load workspace file"));
	if (!data) throw new Error("Workspace file response was empty");
	return data;
}

function ReviewDiffBody({ detail }: { detail: WorkspaceFileDetail }) {
	if (detail.binary) {
		return <PanelMessage>Binary file preview is not available.</PanelMessage>;
	}
	return (
		<CodePanel
			notice={detail.diffTruncated ? "Diff preview truncated." : undefined}
			text={detail.diff || "No diff against HEAD."}
			variant="diff"
		/>
	);
}

function CodePanel({ notice, text, variant }: { notice?: string; text: string; variant: "diff" | "file" }) {
	const lines = text === "" ? [""] : text.replace(/\r\n/g, "\n").split("\n");
	return (
		<div className="flex min-h-[220px] max-h-[min(620px,calc(100vh-18rem))] flex-col">
			{notice ? (
				<div className="shrink-0 border-b border-border bg-warning/10 px-4 py-2 text-xs text-warning">{notice}</div>
			) : null}
			<pre className="session-files-diff-scrollbar min-h-0 flex-1 overflow-auto bg-terminal py-3 font-mono text-xs leading-row text-terminal-foreground">
				{lines.map((line, index) => (
					<div className={cn("min-w-max px-4", variant === "diff" && diffLineClass(line))} key={`${index}-${line}`}>
						<span className="mr-4 inline-block w-8 select-none text-right text-passive">{index + 1}</span>
						<span>{line || " "}</span>
					</div>
				))}
			</pre>
		</div>
	);
}

function ChangeBadges({ additions, deletions }: { additions: number; deletions: number }) {
	return (
		<span className="flex shrink-0 items-center gap-1 font-mono text-xs font-semibold">
			{additions > 0 ? <span className="rounded bg-success/20 px-1.5 py-0.5 text-success">+{additions}</span> : null}
			{deletions > 0 ? <span className="rounded bg-error/20 px-1.5 py-0.5 text-error">-{deletions}</span> : null}
		</span>
	);
}

function PanelMessage({ action, children }: { action?: ReactNode; children: ReactNode }) {
	return (
		<div className="grid min-h-[180px] place-items-center p-6 text-center text-xs text-muted-foreground">
			<div className="flex max-w-sm flex-col items-center gap-3">
				<p>{children}</p>
				{action ?? null}
			</div>
		</div>
	);
}

function RetryButton({ onClick }: { onClick: () => void }) {
	return (
		<Button onClick={onClick} size="sm" type="button" variant="outline">
			Retry
		</Button>
	);
}

function StatusMark({ status }: { status: WorkspaceFileStatus }) {
	const label = statusLabel[status];
	return (
		<span
			className={cn(
				"inline-flex size-5 shrink-0 items-center justify-center rounded border font-mono text-micro font-semibold",
				statusTone[status],
			)}
			title={status}
		>
			{label}
		</span>
	);
}

function isChanged(file: WorkspaceFileSummary) {
	return file.status !== "unmodified";
}

function diffLineClass(line: string) {
	if (line.startsWith("+") && !line.startsWith("+++")) return "bg-success/10 text-success";
	if (line.startsWith("-") && !line.startsWith("---")) return "bg-error/10 text-error";
	if (line.startsWith("@@")) return "text-accent";
	return "";
}
