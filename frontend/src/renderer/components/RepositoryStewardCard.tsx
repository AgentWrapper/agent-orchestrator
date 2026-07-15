import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, Cloud, GitBranch, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { formatTimeCompact } from "../lib/format-time";
import { cn } from "../lib/utils";

type StewardStatus = components["schemas"]["RepositoryStewardStatus"];

export const repositoryStewardQueryKey = (projectId: string) => ["repository-steward", projectId] as const;

export function RepositoryStewardCard({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient();
	const statusQuery = useQuery({
		queryKey: repositoryStewardQueryKey(projectId),
		queryFn: async () => {
			const { data, error } = await apiClient.GET("/api/v1/projects/{projectId}/repository-steward", {
				params: { path: { projectId } },
			});
			if (error) throw new Error(apiErrorMessage(error, "Could not load repository steward"));
			if (!data?.repositorySteward) throw new Error("Repository steward returned no status");
			return data.repositorySteward;
		},
		refetchInterval: 30_000,
	});

	const checkpoint = useMutation({
		mutationFn: async () => {
			const { data, error } = await apiClient.POST(
				"/api/v1/projects/{projectId}/repository-steward/checkpoint",
				{ params: { path: { projectId } } },
			);
			if (error) throw new Error(apiErrorMessage(error, "Could not create recovery checkpoint"));
			if (!data?.repositorySteward) throw new Error("Repository steward returned no status");
			return data.repositorySteward;
		},
		onSuccess: (status) => queryClient.setQueryData(repositoryStewardQueryKey(projectId), status),
	});

	if (statusQuery.isLoading) {
		return (
			<div
				aria-label="Repository steward"
				className="flex shrink-0 items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-3"
				role="region"
		>
			<div className="grid size-9 place-items-center rounded-lg bg-accent/10 text-accent">
				<Loader2 className="size-4 animate-spin" aria-label="Loading repository steward" />
			</div>
			<div>
				<p className="text-sm font-semibold text-foreground">Repository steward</p>
				<p className="text-xs text-muted-foreground">Starting recovery protection…</p>
			</div>
			</div>
		);
	}

	if (statusQuery.isError) {
		return (
			<div
				aria-label="Repository steward"
				className="flex shrink-0 items-center gap-3 rounded-lg border border-error/30 bg-error/8 px-3.5 py-3"
				role="region"
		>
			<AlertTriangle className="size-4 shrink-0 text-error" aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="text-sm font-semibold text-foreground">Repository steward needs attention</p>
				<p className="truncate text-xs text-error">{statusQuery.error.message}</p>
			</div>
			<button
				className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-semibold text-foreground hover:bg-interactive-hover"
				onClick={() => void statusQuery.refetch()}
				type="button"
			>
				<RefreshCw className="size-3.5" /> Retry
			</button>
			</div>
		);
	}

	const status = statusQuery.data as StewardStatus;
	const githubCount = status.repositories.filter((repo) => repo.remoteState === "synced").length;
	const dirtyCount = status.repositories.filter((repo) => repo.dirty).length;
	const attentionCount = status.repositories.filter((repo) => Boolean(repo.error)).length;
	const protectedState = status.state === "protected";
	const localOnly = status.state === "local_only";
	const subtitle = status.state === "checking"
		? "Checking local and GitHub recovery…"
		: protectedState
		? `Local + GitHub recovery · ${githubCount} ${githubCount === 1 ? "checkout" : "checkouts"}`
		: localOnly
			? "Local recovery active · connect a GitHub origin for off-device backup"
			: `${attentionCount || 1} recovery ${attentionCount === 1 ? "item" : "items"} need attention`;

	return (
		<div
			aria-label="Repository steward"
			className={cn(
				"flex shrink-0 flex-wrap items-center gap-3 rounded-lg border bg-surface px-3.5 py-3",
				status.state === "attention" ? "border-warning/40" : "border-border",
			)}
			role="region"
		>
			<div
				className={cn(
					"relative grid size-9 shrink-0 place-items-center rounded-lg",
					status.state === "attention"
						? "bg-warning/12 text-warning"
						: status.state === "checking"
							? "bg-accent/10 text-accent"
							: "bg-success/10 text-success",
				)}
			>
				<ShieldCheck className="size-5" aria-hidden="true" />
				<span
					aria-hidden="true"
					className={cn(
						"absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-surface",
						status.state === "attention" ? "bg-warning" : status.state === "checking" ? "bg-accent" : "bg-success",
					)}
				/>
			</div>
			<div className="min-w-44 flex-1">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<p className="text-sm font-semibold text-foreground">{status.agent}</p>
					<span className="rounded-full bg-interactive-hover px-2 py-0.5 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
						Always on
					</span>
				</div>
				<p className={cn("mt-0.5 text-xs", status.state === "attention" ? "text-warning" : "text-muted-foreground")}>
					{subtitle}
				</p>
			</div>
			<div className="flex items-center gap-4 text-xs text-muted-foreground">
				<span className="inline-flex items-center gap-1.5" title="Known checkouts and agent worktrees">
					<GitBranch className="size-3.5" aria-hidden="true" />
					{status.repositories.length} tracked
				</span>
				{protectedState ? (
					<span className="inline-flex items-center gap-1.5 text-success">
						<Cloud className="size-3.5" aria-hidden="true" /> GitHub synced
					</span>
				) : null}
				{dirtyCount > 0 ? (
					<span className="inline-flex items-center gap-1.5 text-foreground">
						<Check className="size-3.5 text-success" aria-hidden="true" /> {dirtyCount} dirty protected
					</span>
				) : null}
			</div>
			<div className="ml-auto flex items-center gap-2">
				<span className="hidden text-caption text-passive xl:inline">
					Checked {formatTimeCompact(status.lastRunAt)}
				</span>
				<button
					aria-label="Create recovery checkpoint now"
					className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-interactive-hover disabled:opacity-50"
					disabled={checkpoint.isPending}
					onClick={() => checkpoint.mutate()}
					type="button"
				>
					{checkpoint.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
					{checkpoint.isPending ? "Checkpointing…" : "Checkpoint now"}
				</button>
			</div>
			{checkpoint.isError ? <p className="w-full text-xs text-error">{checkpoint.error.message}</p> : null}
			{status.state === "attention" && status.repositories.some((repo) => repo.error) ? (
				<p className="w-full truncate border-t border-border pt-2 text-xs text-warning" title={status.repositories.find((repo) => repo.error)?.error}>
					{status.repositories.find((repo) => repo.error)?.name}: {status.repositories.find((repo) => repo.error)?.error}
				</p>
			) : null}
			{status.repositories.length > 0 ? (
				<details className="group w-full border-t border-border pt-2">
					<summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground">
						<ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
						Recovery details
						<span className="font-normal text-passive">Exact refs and checkpoint IDs</span>
					</summary>
					<div className="mt-2 grid max-h-44 gap-1.5 overflow-y-auto pr-1">
						{status.repositories.map((repo) => (
							<div className="grid gap-1 rounded-md bg-background px-2.5 py-2 text-caption md:grid-cols-[minmax(140px,0.8fr)_minmax(220px,1.6fr)_auto] md:items-center" key={repo.localRef || repo.name}>
								<span className="min-w-0 truncate font-semibold text-foreground" title={repo.name}>
									{repo.name}
									{repo.dirty ? <span className="ml-1.5 text-warning">dirty</span> : null}
								</span>
								<code className="min-w-0 truncate text-passive" title={repo.localRef}>
									{repo.localRef}
								</code>
								<span className={cn("font-mono", repo.remoteState === "synced" ? "text-success" : "text-muted-foreground")}>
									{repo.localSha ? repo.localSha.slice(0, 10) : "pending"} · {repo.remoteState === "synced" ? "GitHub" : "local"}
								</span>
							</div>
						))}
					</div>
					<p className="mt-2 text-caption text-passive">
						Restore any snapshot with <code className="text-muted-foreground">git switch --detach &lt;local-ref&gt;</code> or from its matching <code className="text-muted-foreground">ao-recovery/…</code> GitHub branch.
					</p>
				</details>
			) : null}
		</div>
	);
}
