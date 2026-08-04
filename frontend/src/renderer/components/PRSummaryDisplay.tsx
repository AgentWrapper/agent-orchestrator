import { ArrowUpRight } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { SessionPRSummary } from "../hooks/useSessionScmSummary";
import {
	prCardPresentation,
	prNounKeys,
	prSummaryParts,
	type PRDisplayTone,
	type PRNoun,
	type PRSummaryLink,
} from "../lib/pr-display";
import { cn } from "../lib/utils";

const toneClass: Record<PRDisplayTone, string> = {
	neutral: "text-muted-foreground",
	passive: "text-passive",
	success: "text-success",
	review: "text-status-in-review",
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
	const primary = [leading, branchRange, pr.author ? `@${pr.author.replace(/^@/, "")}` : undefined].filter(Boolean);
	if (primary.length === 0 && !hasDiff) {
		return null;
	}
	return (
		<div className={cn("min-w-0 font-mono text-2xs leading-4", className)}>
			{primary.length > 0 ? <div className="truncate text-muted-foreground">{primary.join(" · ")}</div> : null}
			{hasDiff ? <PRDiffMeta pr={pr} /> : null}
		</div>
	);
}

function PRDiffMeta({ pr }: { pr: SessionPRSummary }) {
	const { t } = useTranslation();
	const parts: ReactNode[] = [];
	if (pr.changedFiles > 0) {
		parts.push(
			<span className="text-muted-foreground" key="files">
				{pr.changedFiles} {t("pr.noun.file", { count: pr.changedFiles })}
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

export function PRCardStatusSummary({ className, pr }: { className?: string; pr: SessionPRSummary }) {
	const presentation = prCardPresentation(pr);
	return (
		<div className={cn("border-t border-border pt-2", className)}>
			<div className="flex min-w-0 items-start gap-2">
				<span
					aria-hidden="true"
					className={cn("mt-1.5 size-dot-sm shrink-0 rounded-full bg-current", toneClass[presentation.primary.tone])}
				/>
				<div className="min-w-0 flex-1">
					<div className={cn("text-xs font-semibold leading-4", toneClass[presentation.primary.tone])}>
						{presentation.primary.label}
					</div>
					{presentation.primary.detail ? (
						<div className="mt-0.5 text-2xs leading-4 text-muted-foreground">{presentation.primary.detail}</div>
					) : null}
					{presentation.primary.links.length > 0 ? (
						<div className="mt-1 flex min-w-0 flex-wrap gap-x-1.5 gap-y-1 font-mono text-2xs">
							{presentation.primary.links.slice(0, 3).map((link, index) => (
								<SummaryLink interactive key={`${presentation.primary.key}-${index}-${link.label}`} link={link} />
							))}
						</div>
					) : null}
				</div>
			</div>
			{presentation.supporting.length > 0 ? (
				<div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 pl-4 font-mono text-2xs">
					{presentation.supporting.map((status) => (
						<span className={cn("inline-flex items-center gap-1", toneClass[status.tone])} key={status.key}>
							<span aria-hidden="true" className="size-1 rounded-full bg-current" />
							{status.label}
						</span>
					))}
				</div>
			) : null}
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
	const { t } = useTranslation();
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
					t,
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

function overflowPartLabel(extra: number, noun: PRNoun | undefined, t: TFunction): string | undefined {
	if (extra <= 0) {
		return undefined;
	}
	return noun ? `+${extra} ${t(prNounKeys[noun], { count: extra })}` : `+${extra}`;
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
		return `${pr.sourceBranch} → ${pr.targetBranch}`;
	}
	if (pr.sourceBranch) {
		return pr.sourceBranch;
	}
	if (pr.targetBranch) {
		return `→ ${pr.targetBranch}`;
	}
	return undefined;
}

function hasDiffMetadata(pr: SessionPRSummary): boolean {
	return pr.changedFiles > 0 || pr.additions > 0 || pr.deletions > 0;
}
