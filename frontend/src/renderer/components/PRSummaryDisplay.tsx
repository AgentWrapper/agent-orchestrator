import { AlertTriangle, ArrowUpDown, ArrowUpRight, Check, X } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { SessionPRSummary } from "../hooks/useSessionScmSummary";
import { prBrowserUrl, prSummaryParts, type PRDisplayTone, type PRSummaryLink } from "../lib/pr-display";
import { cn } from "../lib/utils";

const statusChipStyles: Record<PRDisplayTone, { bg: string; text: string; border: string; icon: ReactNode }> = {
	success: {
		bg: "bg-success/5",
		text: "text-success",
		border: "border-success/20",
		icon: <Check className="h-3 w-3 shrink-0" aria-hidden="true" strokeWidth={3} />,
	},
	warning: {
		bg: "bg-warning/5",
		text: "text-warning",
		border: "border-warning/20",
		icon: <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" strokeWidth={2.5} />,
	},
	error: {
		bg: "bg-error/5",
		text: "text-error",
		border: "border-error/20",
		icon: <X className="h-3 w-3 shrink-0" aria-hidden="true" strokeWidth={3} />,
	},
	neutral: {
		bg: "bg-muted/5",
		text: "text-muted-foreground",
		border: "border-border",
		icon: null,
	},
	passive: {
		bg: "bg-muted/5",
		text: "text-passive",
		border: "border-border",
		icon: null,
	},
};

export function PRSummaryMeta({
	className,
	leading,
	pr,
	showBranch = true,
}: {
	className?: string;
	leading?: string;
	pr: SessionPRSummary;
	showBranch?: boolean;
}) {
	const branchRange = showBranch ? prBranchRange(pr) : undefined;
	const hasDiff = hasDiffMetadata(pr);
	const primary = [leading, pr.author].filter(Boolean);
	if (!branchRange && primary.length === 0 && !hasDiff) {
		return null;
	}
	return (
		<div className={cn("flex flex-col gap-1.5 text-[11px] font-mono", className)}>
			{branchRange ? (
				<div className="truncate text-muted-foreground font-semibold text-[11.5px]">{branchRange}</div>
			) : null}
			{primary.length > 0 || hasDiff ? (
				<div className="flex flex-wrap items-center gap-x-1.5 text-passive text-[10.5px]">
					{primary.length > 0 ? <span>{primary.join(" / ")}</span> : null}
					{primary.length > 0 && hasDiff ? <span>/</span> : null}
					{hasDiff ? <PRDiffMeta pr={pr} /> : null}
				</div>
			) : null}
		</div>
	);
}

function PRDiffMeta({ pr }: { pr: SessionPRSummary }) {
	const parts: ReactNode[] = [];
	if (pr.changedFiles > 0) {
		parts.push(
			<span className="inline-flex items-center gap-0.5 text-warning font-semibold" key="files">
				<ArrowUpDown aria-hidden="true" className="h-2.5 w-2.5 shrink-0" strokeWidth={2.2} />
				{pr.changedFiles} {pluralize("file", pr.changedFiles)}
			</span>,
		);
	}
	if (pr.additions > 0) {
		parts.push(
			<span className="text-success font-semibold" key="additions">
				+{pr.additions}
			</span>,
		);
	}
	if (pr.deletions > 0) {
		parts.push(
			<span className="text-error font-semibold" key="deletions">
				-{pr.deletions}
			</span>,
		);
	}
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
			{parts.map((part, index) => (
				<Fragment key={index}>
					{index > 0 ? <span className="text-passive">/</span> : null}
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
					? "flex flex-col gap-2.5 font-mono text-[10.5px] leading-4"
					: "flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10.5px]",
				className,
			)}
		>
			{parts.map((part) => {
				const links = part.links
					.filter((link) => {
						if (link.label === "PR" && link.href === prBrowserUrl(pr)) {
							return false;
						}
						if (part.key === "merge" && ["CI failing", "changes requested", "review required"].includes(link.label)) {
							return false;
						}
						return true;
					})
					.slice(0, maxLinks);
				const overflowLabel = overflowPartLabel(
					(part.linkTotal ?? part.links.length) - links.length,
					part.overflowNoun,
				);
				const chip = statusChipStyles[part.tone] || statusChipStyles.neutral;
				return (
					<div
						key={part.key}
						className={cn(
							"min-w-0",
							stacked ? "flex flex-col gap-1.5" : "inline-flex flex-wrap gap-x-1.5 items-center",
						)}
					>
						<div className="min-w-0 flex items-center gap-1.5 flex-wrap">
							<div
								className={cn(
									"inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] text-[10.5px] font-bold border shadow-sm",
									chip.bg,
									chip.text,
									chip.border,
								)}
							>
								{chip.icon}
								<span>
									<span className="opacity-75 font-normal">{part.label}</span> <span>{part.status}</span>
								</span>
							</div>
							{part.summary ? <span className="text-passive text-[11px] font-sans">/ {part.summary}</span> : null}
						</div>
						{links.length > 0 || overflowLabel ? (
							<div
								className={cn(
									"min-w-0",
									stacked
										? "flex flex-col gap-1 mt-1 pl-3 border-l border-border/50 ml-1.5"
										: "flex flex-wrap gap-x-1.5 gap-y-1 items-center",
								)}
							>
								{links.map((link, index) => (
									<div key={`${part.key}-${index}-${link.label}`} className="flex items-center gap-1.5">
										{!stacked && index > 0 && <span className="text-passive/40 select-none">/</span>}
										{stacked && <span className="text-passive/50 select-none text-[10px]">↳</span>}
										<SummaryLink interactive={interactiveLinks} link={link} />
									</div>
								))}
								{overflowLabel ? (
									<div className="flex items-center gap-1.5">
										{!stacked && <span className="text-passive/40 select-none">/</span>}
										{stacked && <span className="text-passive/50 select-none text-[10px]">↳</span>}
										<span className="text-passive">{overflowLabel}</span>
									</div>
								) : null}
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
