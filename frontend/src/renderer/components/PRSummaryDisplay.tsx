import { ArrowUpDown, ArrowUpRight } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { SessionPRSummary } from "../hooks/useSessionScmSummary";
import { prSummaryParts, type PRDisplayTone, type PRSummaryLink } from "../lib/pr-display";
import { cn } from "../lib/utils";

const toneClass: Record<PRDisplayTone, string> = {
	neutral: "text-muted-foreground",
	passive: "text-passive",
	success: "text-success",
	warning: "text-warning",
	error: "text-error",
};

export function PRSummaryMeta({
	className,
	leading,
	pr,
}: {
	className?: string;
	leading?: string;
	pr: SessionPRSummary;
}) {
	const branchRange = prBranchRange(pr);
	const hasDiff = hasDiffMetadata(pr);
	const primary = [leading, branchRange, pr.author].filter(Boolean);
	if (primary.length === 0 && !hasDiff) {
		return null;
	}
	return (
		<div className={cn("min-w-0 font-mono text-2xs leading-4", className)}>
			{primary.length > 0 ? <div className="truncate text-passive">{primary.join(" · ")}</div> : null}
			{hasDiff ? <PRDiffMeta pr={pr} /> : null}
		</div>
	);
}

function PRDiffMeta({ pr }: { pr: SessionPRSummary }) {
	const parts: ReactNode[] = [];
	if (pr.changedFiles > 0) {
		parts.push(
			<span className="inline-flex items-center gap-0.5 text-warning" key="files">
				<ArrowUpDown aria-hidden="true" className="h-2.5 w-2.5 shrink-0" strokeWidth={2.2} />
				{pr.changedFiles} {pluralize("file", pr.changedFiles)}
			</span>,
		);
	}
	if (pr.additions > 0) {
		parts.push(
			<span className="text-success" key="additions">
				+{pr.additions}
			</span>,
		);
	}
	if (pr.deletions > 0) {
		parts.push(
			<span className="text-error" key="deletions">
				-{pr.deletions}
			</span>,
		);
	}
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground">
			{parts.map((part, index) => (
				<Fragment key={index}>
					{index > 0 ? <span className="text-passive">·</span> : null}
					{part}
				</Fragment>
			))}
		</div>
	);
}

export function PRSummaryParts({
	className,
	interactiveLinks = true,
	maxLinks = 3,
	pr,
	variant = "compact",
}: {
	className?: string;
	interactiveLinks?: boolean;
	maxLinks?: number;
	pr: SessionPRSummary;
	variant?: "compact" | "stacked";
}) {
	const parts = prSummaryParts(pr);
	const stacked = variant === "stacked";
	return (
		<div
			className={cn(
				stacked
					? "flex flex-col gap-1.5 font-mono text-2xs leading-4"
					: "flex flex-wrap gap-x-3 gap-y-1 font-mono text-2xs",
				className,
			)}
		>
			{parts.map((part) => {
				const links = part.links.slice(0, maxLinks);
				const overflowLabel = overflowPartLabel(
					(part.linkTotal ?? part.links.length) - links.length,
					part.overflowNoun,
				);
				return (
					<div key={part.key} className={cn("min-w-0", stacked ? "flex flex-col" : "inline-flex flex-wrap gap-x-1")}>
						<div className="min-w-0 truncate">
							<span className="text-passive">{part.label}</span>{" "}
							<span className={cn("font-medium", toneClass[part.tone])}>{part.status}</span>
							{part.summary ? <span className="text-passive"> · {part.summary}</span> : null}
						</div>
						{links.length > 0 || overflowLabel ? (
							<div className={cn("flex min-w-0 flex-wrap gap-x-1.5 gap-y-1", stacked ? "mt-0.5" : "")}>
								{links.map((link, index) => (
									<SummaryLink interactive={interactiveLinks} key={`${part.key}-${index}-${link.label}`} link={link} />
								))}
								{overflowLabel ? <span className="text-passive">{overflowLabel}</span> : null}
							</div>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

function overflowPartLabel(extra: number, noun?: string): string | undefined {
	if (extra <= 0) {
		return undefined;
	}
	return noun ? `+${extra} ${pluralize(noun, extra)}` : `+${extra}`;
}

function SummaryLink({ interactive, link }: { interactive: boolean; link: PRSummaryLink }) {
	if (interactive && link.href) {
		return (
			<a
				className="inline-flex max-w-full min-w-0 items-center gap-0.5 text-accent hover:underline"
				href={link.href}
				onClick={(event) => event.stopPropagation()}
				rel="noopener noreferrer"
				target="_blank"
				title={link.title}
			>
				<span className="truncate">{link.label}</span>
				<ArrowUpRight aria-hidden="true" className="h-2.5 w-2.5 shrink-0" strokeWidth={2} />
			</a>
		);
	}
	return (
		<span className="max-w-full truncate text-muted-foreground" title={link.title}>
			{link.label}
		</span>
	);
}

function prBranchRange(pr: SessionPRSummary): string | undefined {
	if (pr.sourceBranch && pr.targetBranch) {
		return `${pr.sourceBranch} -> ${pr.targetBranch}`;
	}
	if (pr.sourceBranch) {
		return pr.sourceBranch;
	}
	if (pr.targetBranch) {
		return `-> ${pr.targetBranch}`;
	}
	return undefined;
}

function hasDiffMetadata(pr: SessionPRSummary): boolean {
	return pr.changedFiles > 0 || pr.additions > 0 || pr.deletions > 0;
}

function pluralize(noun: string, count: number): string {
	return count === 1 ? noun : `${noun}s`;
}
