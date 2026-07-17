import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, RefreshCw, Search, X } from "lucide-react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type WorkspaceFileSummary = components["schemas"]["WorkspaceFileSummary"];
type WorkspaceFileDetail = components["schemas"]["WorkspaceFileResponse"];
type WorkspaceFileStatus = WorkspaceFileSummary["status"];
type DetailMode = "diff" | "file";

type SessionFilesViewProps = {
	sessionId: string;
	onClose: () => void;
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

export function SessionFilesView({ sessionId, onClose }: SessionFilesViewProps) {
	const [filter, setFilter] = useState("");
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [detailMode, setDetailMode] = useState<DetailMode>("diff");

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

	useEffect(() => {
		if (filesQuery.isPending) return;
		setSelectedPath((current) => {
			if (current && files.some((file) => file.path === current)) return current;
			return files.find(isChanged)?.path ?? files[0]?.path ?? null;
		});
	}, [files, filesQuery.isPending]);

	const detailQuery = useQuery({
		queryKey: ["session-workspace-file", sessionId, selectedPath],
		enabled: Boolean(selectedPath),
		refetchInterval: 3500,
		queryFn: async () => {
			if (!selectedPath) throw new Error("file path is required");
			const { data, error } = await apiClient.GET("/api/v1/sessions/{sessionId}/workspace/file", {
				params: { path: { sessionId }, query: { path: selectedPath } },
			});
			if (error) throw new Error(apiErrorMessage(error, "Unable to load workspace file"));
			if (!data) throw new Error("Workspace file response was empty");
			return data;
		},
	});

	const normalizedFilter = filter.trim().toLowerCase();
	const visibleFiles = useMemo(
		() =>
			normalizedFilter
				? files.filter((file) => file.path.toLowerCase().includes(normalizedFilter))
				: files,
		[files, normalizedFilter],
	);
	const changedCount = files.filter(isChanged).length;

	const refresh = () => {
		void filesQuery.refetch();
		if (selectedPath) void detailQuery.refetch();
	};

	return (
		<section className="flex h-full min-h-0 flex-col bg-background text-foreground" aria-label="Session files">
			<header className="flex h-13 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
				<div className="flex min-w-0 items-center gap-2">
					<FileText className="size-icon-md shrink-0 text-passive" aria-hidden="true" />
					<h2 className="truncate text-md-sm font-semibold text-foreground">Files</h2>
					<span className="shrink-0 font-mono text-caption text-passive">
						{changedCount === 1 ? "1 changed" : `${changedCount} changed`}
					</span>
				</div>
				<label className="relative ml-auto min-w-0 flex-1 max-w-[360px]">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 size-icon-sm -translate-y-1/2 text-passive" />
					<Input
						className="h-8 pl-8 font-mono text-xs"
						onChange={(event) => setFilter(event.target.value)}
						placeholder="Search files"
						value={filter}
					/>
				</label>
				<Button
					aria-label="Refresh files"
					disabled={filesQuery.isFetching || detailQuery.isFetching}
					onClick={refresh}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<RefreshCw
						className={cn("size-icon-sm", (filesQuery.isFetching || detailQuery.isFetching) && "animate-spin")}
						aria-hidden="true"
					/>
				</Button>
				<Button aria-label="Close files" onClick={onClose} size="icon-sm" type="button" variant="ghost">
					<X className="size-icon-sm" aria-hidden="true" />
				</Button>
			</header>

			<div className="grid min-h-0 flex-1 grid-cols-[minmax(210px,32%)_minmax(0,1fr)]">
				<aside className="min-h-0 border-r border-border bg-background">
					<FileList
						error={filesQuery.error}
						files={visibleFiles}
						isLoading={filesQuery.isPending}
						onRetry={() => void filesQuery.refetch()}
						onSelect={setSelectedPath}
						selectedPath={selectedPath}
					/>
				</aside>
				<FileDetail
					detail={detailQuery.data}
					error={detailQuery.error}
					isLoading={detailQuery.isPending && Boolean(selectedPath)}
					mode={detailMode}
					onModeChange={setDetailMode}
					onRetry={() => void detailQuery.refetch()}
					selectedPath={selectedPath}
				/>
			</div>
		</section>
	);
}

function FileList({
	error,
	files,
	isLoading,
	onRetry,
	onSelect,
	selectedPath,
}: {
	error: Error | null;
	files: WorkspaceFileSummary[];
	isLoading: boolean;
	onRetry: () => void;
	onSelect: (path: string) => void;
	selectedPath: string | null;
}) {
	if (isLoading) {
		return <PanelMessage>Loading files...</PanelMessage>;
	}
	if (error) {
		return <PanelMessage action={<RetryButton onClick={onRetry} />}>{error.message || "Unable to load files."}</PanelMessage>;
	}
	if (files.length === 0) {
		return <PanelMessage>No files found.</PanelMessage>;
	}
	return (
		<ul className="h-full overflow-auto py-2">
			{files.map((file) => (
				<li key={file.path}>
					<button
						className={cn(
							"flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-interactive-hover",
							selectedPath === file.path && "bg-interactive-active text-foreground",
						)}
						onClick={() => onSelect(file.path)}
						type="button"
					>
						<StatusMark status={file.status} />
						<span className="min-w-0 flex-1 truncate font-mono text-foreground">{file.path}</span>
						{isChanged(file) ? (
							<span className="shrink-0 font-mono text-micro text-passive">
								+{file.additions} -{file.deletions}
							</span>
						) : null}
					</button>
				</li>
			))}
		</ul>
	);
}

function FileDetail({
	detail,
	error,
	isLoading,
	mode,
	onModeChange,
	onRetry,
	selectedPath,
}: {
	detail?: WorkspaceFileDetail;
	error: Error | null;
	isLoading: boolean;
	mode: DetailMode;
	onModeChange: (mode: DetailMode) => void;
	onRetry: () => void;
	selectedPath: string | null;
}) {
	if (!selectedPath) {
		return <PanelMessage>No file selected.</PanelMessage>;
	}
	return (
		<section className="flex min-h-0 flex-col bg-background" aria-label="File detail">
			<div className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-4">
				<div className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-foreground">{selectedPath}</div>
				<div className="inline-flex shrink-0 rounded-md bg-raised p-1" role="tablist" aria-label="File detail mode">
					<ModeButton active={mode === "diff"} onClick={() => onModeChange("diff")}>
						Diff
					</ModeButton>
					<ModeButton active={mode === "file"} onClick={() => onModeChange("file")}>
						File
					</ModeButton>
				</div>
			</div>
			<div className="min-h-0 flex-1">
				{isLoading ? <PanelMessage>Loading file...</PanelMessage> : null}
				{!isLoading && error ? (
					<PanelMessage action={<RetryButton onClick={onRetry} />}>
						{error.message || "Unable to load this file."}
					</PanelMessage>
				) : null}
				{!isLoading && !error && detail ? <DetailBody detail={detail} mode={mode} /> : null}
			</div>
		</section>
	);
}

function DetailBody({ detail, mode }: { detail: WorkspaceFileDetail; mode: DetailMode }) {
	if (detail.binary) {
		return <PanelMessage>Binary file preview is not available.</PanelMessage>;
	}
	if (mode === "file") {
		if (detail.deleted) return <PanelMessage>File deleted in this session.</PanelMessage>;
		return (
			<CodePanel
				notice={detail.contentTruncated ? "File preview truncated." : undefined}
				text={detail.content}
				variant="file"
			/>
		);
	}
	return (
		<CodePanel
			notice={detail.diffTruncated ? "Diff preview truncated." : undefined}
			text={detail.diff || "No diff against HEAD."}
			variant="diff"
		/>
	);
}

function CodePanel({
	notice,
	text,
	variant,
}: {
	notice?: string;
	text: string;
	variant: "diff" | "file";
}) {
	const lines = text === "" ? [""] : text.replace(/\r\n/g, "\n").split("\n");
	return (
		<div className="flex h-full min-h-0 flex-col">
			{notice ? (
				<div className="shrink-0 border-b border-border bg-warning/10 px-4 py-2 text-xs text-warning">{notice}</div>
			) : null}
			<pre className="min-h-0 flex-1 overflow-auto bg-terminal py-3 font-mono text-xs leading-row text-terminal">
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

function ModeButton({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
	return (
		<button
			aria-selected={active}
			className={cn(
				"rounded px-2.5 py-1 text-xs text-muted-foreground transition-colors",
				active && "bg-background text-foreground",
			)}
			onClick={onClick}
			role="tab"
			type="button"
		>
			{children}
		</button>
	);
}

function PanelMessage({ action, children }: { action?: ReactNode; children: ReactNode }) {
	return (
		<div className="grid h-full min-h-0 place-items-center p-6 text-center text-xs text-muted-foreground">
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
