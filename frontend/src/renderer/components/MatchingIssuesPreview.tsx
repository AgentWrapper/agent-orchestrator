import { Loader2 } from "lucide-react";
import { useTrackerIntakePreview } from "../hooks/useTrackerIntakePreview";

export function MatchingIssuesPreview({ projectId, labels }: { projectId: string; labels: string[] }) {
	const preview = useTrackerIntakePreview(projectId, labels, true);
	const checking = preview.isDebouncing || preview.isFetching;
	return (
		<div className="flex min-h-6 items-center gap-2 border-t border-border pt-3 text-[12px] leading-none">
			<span className="text-muted-foreground">Matching open issues</span>
			<span
				aria-busy={checking || undefined}
				aria-label={checking ? "Checking matching open issues" : undefined}
				className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-accent-weak px-1 font-mono text-[11px] font-medium leading-none tabular-nums text-accent"
				role={checking ? "status" : undefined}
			>
				{checking ? (
					<Loader2 className="size-3 animate-spin" aria-hidden="true" />
				) : preview.isError ? (
					<span className="text-error">!</span>
				) : (
					(preview.data?.count ?? 0)
				)}
			</span>
			{preview.isError && !checking ? <span className="leading-none text-error">Unavailable</span> : null}
		</div>
	);
}
