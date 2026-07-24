import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Check,
	ChevronDown,
	ChevronRight,
	ChevronsDownUp,
	ChevronsUpDown,
	Columns2,
	Copy,
	Maximize2,
	Minimize2,
	RefreshCw,
	Search,
	X,
} from "lucide-react";
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
	const [searchOpen, setSearchOpen] = useState(false);
	const [split, setSplit] = useState(false);
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
	const initializedExpansionFor = useRef<string | null>(null);
	const rootRef = useRef<HTMLElement>(null);

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

	// j / k move focus between file rows (Vim-style), unless the user is typing
	// in the search box. The rows themselves handle Enter/Space to expand.
	const onFilesKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key !== "j" && event.key !== "k") return;
		const active = document.activeElement;
		if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
		const toggles = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-file-toggle]") ?? []);
		if (toggles.length === 0) return;
		event.preventDefault();
		const current = toggles.findIndex((button) => button === active);
		if (current === -1) {
			toggles[0].focus();
			return;
		}
		const next = event.key === "j" ? Math.min(toggles.length - 1, current + 1) : Math.max(0, current - 1);
		toggles[next].focus();
	};

	return (
		<section
			ref={rootRef}
			onKeyDown={onFilesKeyDown}
			className="flex h-full min-h-0 flex-col bg-background text-foreground"
			aria-label="Session files"
		>
			<header className="flex h-13 shrink-0 items-center gap-0.5 border-b border-border bg-surface px-2">
				{searchOpen ? (
					<label className="relative mr-auto min-w-0 flex-1 max-w-[280px]">
						<Search className="pointer-events-none absolute left-2.5 top-1/2 size-icon-sm -translate-y-1/2 text-passive" />
						<Input
							autoFocus
							className="h-8 pl-8 font-mono text-xs"
							onChange={(event) => setFilter(event.target.value)}
							placeholder="Search changed files"
							value={filter}
						/>
					</label>
				) : (
					<span className="mr-auto min-w-0 truncate pl-1.5 font-mono text-caption text-passive">
						{changedCount === 1 ? "1 file" : `${changedCount} files`}
					</span>
				)}
				<Button
					aria-label={searchOpen ? "Close search" : "Search files"}
					aria-pressed={searchOpen}
					className={cn("shrink-0", searchOpen && "text-accent")}
					onClick={() => {
						setSearchOpen((open) => {
							if (open) setFilter("");
							return !open;
						});
					}}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<Search className="size-icon-sm" aria-hidden="true" />
				</Button>
				<Button
					aria-label={expandedVisibleCount > 0 ? "Collapse all files" : "Expand all files"}
					className="shrink-0"
					disabled={visibleFiles.length === 0}
					onClick={toggleVisibleFiles}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					{expandedVisibleCount > 0 ? (
						<ChevronsDownUp className="size-icon-sm" aria-hidden="true" />
					) : (
						<ChevronsUpDown className="size-icon-sm" aria-hidden="true" />
					)}
				</Button>
				<Button
					aria-label={split ? "Unified diff view" : "Split diff view"}
					aria-pressed={split}
					className={cn("shrink-0", split && "text-accent")}
					onClick={() => setSplit((current) => !current)}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<Columns2 className="size-icon-sm" aria-hidden="true" />
				</Button>
				<Button
					aria-label="Refresh files"
					className="shrink-0"
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
						className="shrink-0"
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
				<Button
					aria-label="Close files"
					className="shrink-0"
					onClick={onClose}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<X className="size-icon-sm" aria-hidden="true" />
				</Button>
			</header>

			<div className="min-h-0 flex-1 overflow-auto bg-background">
				<div className="mx-auto flex w-full max-w-[1200px] flex-col px-0 py-2">
					<ReviewFileList
						error={filesQuery.error}
						expandedPaths={expandedPaths}
						files={visibleFiles}
						isLoading={filesQuery.isPending}
						onRetry={() => void filesQuery.refetch()}
						onToggle={toggleFile}
						sessionId={sessionId}
						split={split}
						wrap={true}
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
	split,
	wrap,
}: {
	error: Error | null;
	expandedPaths: Set<string>;
	files: WorkspaceFileSummary[];
	isLoading: boolean;
	onRetry: () => void;
	onToggle: (path: string) => void;
	sessionId: string;
	split: boolean;
	wrap: boolean;
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
						split={split}
						wrap={wrap}
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
	split,
	wrap,
}: {
	expanded: boolean;
	file: WorkspaceFileSummary;
	onToggle: () => void;
	sessionId: string;
	split: boolean;
	wrap: boolean;
}) {
	const detailQuery = useQuery({
		queryKey: ["session-workspace-file", sessionId, file.path],
		enabled: expanded,
		refetchInterval: expanded ? 3500 : false,
		queryFn: () => loadWorkspaceFile(sessionId, file.path),
	});

	return (
		<article className="session-files-review-row overflow-hidden bg-transparent">
			<div
				className={cn(
					"group/row flex min-h-11 items-center transition-colors",
					expanded ? "bg-interactive-active/45" : "hover:bg-interactive-hover/50",
				)}
			>
				<button
					aria-controls={`workspace-diff-${file.path}`}
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Expand"} ${file.path}`}
					className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left"
					data-file-toggle=""
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
				<CopyPathButton path={file.path} />
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
						<ReviewDiffBody detail={detailQuery.data} split={split} wrap={wrap} />
					) : null}
				</div>
			) : null}
		</article>
	);
}

function CopyPathButton({ path }: { path: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			aria-label={copied ? "Path copied" : `Copy path for ${path}`}
			className="mr-2 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100"
			onClick={() => {
				void navigator.clipboard?.writeText(path);
				setCopied(true);
				setTimeout(() => setCopied(false), 1200);
			}}
			size="icon-sm"
			type="button"
			variant="ghost"
		>
			{copied ? (
				<Check className="size-icon-sm text-success" aria-hidden="true" />
			) : (
				<Copy className="size-icon-sm" aria-hidden="true" />
			)}
		</Button>
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

function ReviewDiffBody({ detail, split, wrap }: { detail: WorkspaceFileDetail; split: boolean; wrap: boolean }) {
	if (detail.binary) {
		return <PanelMessage>Binary file preview is not available.</PanelMessage>;
	}
	const rows = parseUnifiedDiff(detail.diff);
	if (rows.length === 0) {
		return <PanelMessage>No changes against HEAD.</PanelMessage>;
	}
	return <DiffView rows={rows} split={split} truncated={detail.diffTruncated} wrap={wrap} />;
}

type DiffRowKind = "context" | "add" | "del" | "hunk";

type DiffSegment = { text: string; changed: boolean };

type DiffRow = {
	kind: DiffRowKind;
	oldNo: number | null;
	newNo: number | null;
	text: string;
	// hunk rows only: the enclosing function/section context after the @@ range.
	section?: string;
	// add/del rows only: intra-line word-level highlight of what changed.
	segments?: DiffSegment[];
};

// Git file-header lines carry no reviewable content, so they are hidden — the
// panel reads like a diff instead of a raw `git diff` dump. Matched by prefix
// after line endings are normalized, so it behaves the same on every OS.
const gitHeaderPrefixes = [
	"diff --git ",
	"index ",
	"old mode ",
	"new mode ",
	"new file mode ",
	"deleted file mode ",
	"similarity index ",
	"dissimilarity index ",
	"rename from ",
	"rename to ",
	"copy from ",
	"copy to ",
	"--- ",
	"+++ ",
];

const hunkHeaderPattern = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// parseUnifiedDiff turns a raw `git diff` string into typed rows with real
// per-side line numbers. Line endings are normalized first (Windows \r\n and
// classic-Mac \r as well as Unix \n) so numbering and marker detection are
// identical across operating systems.
function parseUnifiedDiff(raw: string): DiffRow[] {
	if (!raw) return [];
	const lines = raw.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const rows: DiffRow[] = [];
	let oldNo = 0;
	let newNo = 0;
	let inHunk = false;
	for (const line of lines) {
		if (gitHeaderPrefixes.some((prefix) => line.startsWith(prefix))) continue;
		if (line.startsWith("@@")) {
			const hunk = hunkHeaderPattern.exec(line);
			oldNo = hunk ? Number(hunk[1]) : 1;
			newNo = hunk ? Number(hunk[2]) : 1;
			inHunk = true;
			const sectionStart = line.indexOf("@@", 2);
			const range = sectionStart >= 0 ? line.slice(0, sectionStart + 2) : line;
			const section = sectionStart >= 0 ? line.slice(sectionStart + 2).trim() : "";
			rows.push({ kind: "hunk", oldNo: null, newNo: null, text: range, section: section || undefined });
			continue;
		}
		if (!inHunk) continue;
		if (line.startsWith("\\")) continue; // "\ No newline at end of file"
		const marker = line[0];
		const text = line.slice(1);
		if (marker === "+") {
			rows.push({ kind: "add", oldNo: null, newNo, text });
			newNo += 1;
		} else if (marker === "-") {
			rows.push({ kind: "del", oldNo, newNo: null, text });
			oldNo += 1;
		} else {
			rows.push({ kind: "context", oldNo, newNo, text });
			oldNo += 1;
			newNo += 1;
		}
	}
	annotateIntraLine(rows);
	return rows;
}

// Longest line length still worth an intra-line (word-level) diff. The LCS is
// O(tokens^2), so very long lines are left as whole-line highlights.
const maxIntraLineChars = 400;

// annotateIntraLine pairs each run of deleted lines with the equal-length run of
// added lines that immediately follows it (a line-for-line replacement) and
// marks the exact tokens that changed within each pair, so the UI can highlight
// what actually changed instead of tinting the whole line.
function annotateIntraLine(rows: DiffRow[]): void {
	let i = 0;
	while (i < rows.length) {
		if (rows[i].kind !== "del") {
			i += 1;
			continue;
		}
		let delEnd = i;
		while (delEnd < rows.length && rows[delEnd].kind === "del") delEnd += 1;
		let addEnd = delEnd;
		while (addEnd < rows.length && rows[addEnd].kind === "add") addEnd += 1;
		const dels = delEnd - i;
		const adds = addEnd - delEnd;
		if (dels > 0 && dels === adds) {
			for (let k = 0; k < dels; k += 1) {
				const del = rows[i + k];
				const add = rows[delEnd + k];
				if (del.text.length > maxIntraLineChars || add.text.length > maxIntraLineChars) continue;
				const { oldSegments, newSegments } = intraLineSegments(del.text, add.text);
				del.segments = oldSegments;
				add.segments = newSegments;
			}
		}
		i = addEnd > i ? addEnd : i + 1;
	}
}

function tokenizeLine(value: string): string[] {
	return value.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? [];
}

function pushSegment(segments: DiffSegment[], text: string, changed: boolean): void {
	const last = segments[segments.length - 1];
	if (last && last.changed === changed) last.text += text;
	else segments.push({ text, changed });
}

// intraLineSegments token-diffs two lines via LCS and returns the tokens that
// only exist on one side marked as changed.
function intraLineSegments(
	oldText: string,
	newText: string,
): { oldSegments: DiffSegment[]; newSegments: DiffSegment[] } {
	const a = tokenizeLine(oldText);
	const b = tokenizeLine(newText);
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
	for (let x = a.length - 1; x >= 0; x -= 1) {
		for (let y = b.length - 1; y >= 0; y -= 1) {
			lcs[x][y] = a[x] === b[y] ? lcs[x + 1][y + 1] + 1 : Math.max(lcs[x + 1][y], lcs[x][y + 1]);
		}
	}
	const oldSegments: DiffSegment[] = [];
	const newSegments: DiffSegment[] = [];
	let x = 0;
	let y = 0;
	while (x < a.length && y < b.length) {
		if (a[x] === b[y]) {
			pushSegment(oldSegments, a[x], false);
			pushSegment(newSegments, b[y], false);
			x += 1;
			y += 1;
		} else if (lcs[x + 1][y] >= lcs[x][y + 1]) {
			pushSegment(oldSegments, a[x], true);
			x += 1;
		} else {
			pushSegment(newSegments, b[y], true);
			y += 1;
		}
	}
	while (x < a.length) pushSegment(oldSegments, a[x++], true);
	while (y < b.length) pushSegment(newSegments, b[y++], true);
	return { oldSegments, newSegments };
}

const diffRowTone: Record<Exclude<DiffRowKind, "hunk">, string> = {
	add: "bg-success/10",
	del: "bg-error/10",
	context: "",
};

const diffMarkerGlyph: Record<Exclude<DiffRowKind, "hunk">, string> = {
	add: "+",
	del: "-",
	context: " ",
};

function DiffView({
	rows,
	split,
	truncated,
	wrap,
}: {
	rows: DiffRow[];
	split: boolean;
	truncated?: boolean;
	wrap: boolean;
}) {
	return (
		<div className="flex min-h-[220px] max-h-[min(620px,calc(100vh-18rem))] flex-col">
			{truncated ? (
				<div className="shrink-0 border-b border-border bg-warning/10 px-4 py-2 text-xs text-warning">
					Diff preview truncated.
				</div>
			) : null}
			<div className="session-files-diff-scrollbar min-h-0 flex-1 overflow-auto bg-terminal font-mono text-xs leading-row text-terminal-foreground">
				{split ? (
					<SplitDiff rows={rows} />
				) : (
					<div className={cn(!wrap && "min-w-max")}>
						{rows.map((row, index) =>
							row.kind === "hunk" ? (
								<HunkBand key={`h${index}`} row={row} />
							) : (
								<div className={cn("flex", diffRowTone[row.kind])} key={`r${index}`}>
									<span className="w-9 shrink-0 select-none border-r border-border/50 bg-terminal px-1.5 text-right text-passive/70 tabular-nums">
										{row.newNo ?? row.oldNo ?? ""}
									</span>
									<span
										className={cn(
											"w-4 shrink-0 select-none text-center",
											row.kind === "add" && "text-success",
											row.kind === "del" && "text-error",
										)}
									>
										{diffMarkerGlyph[row.kind]}
									</span>
									<span className={cn("pr-4", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>
										{row.segments ? (
											<DiffLineSegments add={row.kind === "add"} segments={row.segments} />
										) : (
											row.text || " "
										)}
									</span>
								</div>
							),
						)}
					</div>
				)}
			</div>
		</div>
	);
}

function HunkBand({ row }: { row: DiffRow }) {
	return (
		<div className="flex select-none items-baseline gap-3 bg-surface-faint px-3 py-1 text-passive">
			<span className="shrink-0 text-passive/70">{row.text}</span>
			{row.section ? <span className="min-w-0 truncate text-passive/90">{row.section}</span> : null}
		</div>
	);
}

type SplitRow = { kind: "hunk"; row: DiffRow } | { kind: "pair"; left: DiffRow | null; right: DiffRow | null };

// toSplitRows aligns the unified rows into left (old) / right (new) pairs: each
// run of deletions lines up index-for-index with the additions that follow it,
// context appears on both sides, and hunk headers span the full width.
function toSplitRows(rows: DiffRow[]): SplitRow[] {
	const out: SplitRow[] = [];
	let dels: DiffRow[] = [];
	let adds: DiffRow[] = [];
	const flush = () => {
		const count = Math.max(dels.length, adds.length);
		for (let i = 0; i < count; i += 1) out.push({ kind: "pair", left: dels[i] ?? null, right: adds[i] ?? null });
		dels = [];
		adds = [];
	};
	for (const row of rows) {
		if (row.kind === "del") {
			dels.push(row);
			continue;
		}
		if (row.kind === "add") {
			adds.push(row);
			continue;
		}
		flush();
		if (row.kind === "hunk") out.push({ kind: "hunk", row });
		else out.push({ kind: "pair", left: row, right: row });
	}
	flush();
	return out;
}

function SplitDiff({ rows }: { rows: DiffRow[] }) {
	return (
		<div>
			{toSplitRows(rows).map((splitRow, index) =>
				splitRow.kind === "hunk" ? (
					<HunkBand key={`sh${index}`} row={splitRow.row} />
				) : (
					<div className="grid grid-cols-2 divide-x divide-border/40" key={`sp${index}`}>
						<SplitSide row={splitRow.left} side="old" />
						<SplitSide row={splitRow.right} side="new" />
					</div>
				),
			)}
		</div>
	);
}

function SplitSide({ row, side }: { row: DiffRow | null; side: "old" | "new" }) {
	if (!row) return <div className="bg-surface-faint/20" aria-hidden="true" />;
	const lineNo = side === "old" ? row.oldNo : row.newNo;
	const tone = row.kind === "hunk" ? "" : diffRowTone[row.kind];
	return (
		<div className={cn("flex min-w-0", tone)}>
			<span className="w-9 shrink-0 select-none border-r border-border/50 bg-terminal px-1.5 text-right text-passive/70 tabular-nums">
				{lineNo ?? ""}
			</span>
			<span className="min-w-0 whitespace-pre-wrap break-all px-2">
				{row.segments ? <DiffLineSegments add={row.kind === "add"} segments={row.segments} /> : row.text || " "}
			</span>
		</div>
	);
}

function DiffLineSegments({ add, segments }: { add: boolean; segments: DiffSegment[] }) {
	return (
		<>
			{segments.map((segment, index) =>
				segment.changed ? (
					<span className={cn("rounded-sm", add ? "bg-success/35" : "bg-error/35")} key={index}>
						{segment.text}
					</span>
				) : (
					<span key={index}>{segment.text}</span>
				),
			)}
		</>
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
