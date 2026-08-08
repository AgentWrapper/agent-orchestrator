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
	type PRSummaryPartKey,
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
	const authorHandle = pr.author?.replace(/^@/, "") ?? "";
	const primary: ReactNode[] = [leading, branchRange].filter(Boolean);
	if (authorHandle) {
		primary.push(
			pr.provider === "github" ? (
				<a
					className="text-settings-label underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
					href={`https://github.com/${encodeURIComponent(authorHandle)}`}
					key="author"
					rel="noopener noreferrer"
					target="_blank"
				>
					@{authorHandle}
				</a>
			) : (
				<span key="author">@{authorHandle}</span>
			),
		);
	}
	if (primary.length === 0 && !hasDiff) {
		return null;
	}
	return (
		<div className={cn("min-w-0 font-mono text-2xs leading-4", className)}>
			{primary.length > 0 ? (
				<div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-muted-foreground">
					{primary.map((part, index) => (
						<Fragment key={index}>
							{index > 0 ? <span className="shrink-0 text-passive">·</span> : null}
							<span className="min-w-0 truncate">{part}</span>
						</Fragment>
					))}
				</div>
			) : null}
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

export function PRCardStatusSummary({
	action,
	className,
	omit,
	pr,
}: {
	action?: ReactNode;
	className?: string;
	omit?: PRSummaryPartKey[];
	pr: SessionPRSummary;
}) {
	const presentation = prCardPresentation(pr);
	const omitted = omit ? new Set(omit) : undefined;
	const supporting = presentation.supporting.filter((status) => !omitted?.has(status.key as PRSummaryPartKey));
	return (
		<div className={cn("border-t border-border pt-2", className)}>
			<div className="flex min-w-0 items-center gap-3">
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<div className="flex min-w-0 items-start gap-2">
						<span
							aria-hidden="true"
							className={cn(
								"mt-1 size-dot-sm shrink-0 rounded-full bg-current",
								toneClass[presentation.primary.tone],
								presentation.primary.breathe && "animate-status-pulse",
							)}
						/>
						<div className="min-w-0 flex-1">
							<div className={cn("text-xs font-semibold leading-4", toneClass[presentation.primary.tone])}>
								<PRCardStatusLink status={presentation.primary} />
							</div>
							{presentation.primary.detail ? (
								<div className="mt-0.5 text-2xs leading-4 text-muted-foreground">
									{presentation.primary.detail}
								</div>
							) : null}
							{presentation.primary.links.length > 0 ? (
								<div className="mt-1 flex min-w-0 flex-wrap gap-x-1.5 gap-y-1 font-mono text-2xs">
									{presentation.primary.links.slice(0, 3).map((link, index) => (
										<SummaryLink
											className={toneClass[presentation.primary.tone]}
											interactive
											key={`${presentation.primary.key}-${index}-${link.label}`}
											link={link}
										/>
									))}
								</div>
							) : null}
						</div>
					</div>
					{supporting.length > 0 ? (
						<div className="min-w-0 pl-4">
							<div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 font-mono text-2xs">
								{supporting.map((status) => (
									<span
										className={cn("inline-flex items-center gap-1", toneClass[status.tone])}
										key={status.key}
									>
										<span
											aria-hidden="true"
											className={cn("size-1 rounded-full bg-current", status.breathe && "animate-status-pulse")}
										/>
										<PRCardStatusLink status={status} />
									</span>
								))}
							</div>
						</div>
					) : null}
				</div>
				{action ? <div className="shrink-0 self-center">{action}</div> : null}
			</div>
		</div>
	);
}

function PRCardStatusLink({ status }: { status: ReturnType<typeof prCardPresentation>["primary"] }) {
	if (!status.href) return status.label;
	return (
		<a
			className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
			href={status.href}
			rel="noopener noreferrer"
			target="_blank"
		>
			{status.label}
			<ArrowUpRight aria-hidden="true" className="size-icon-2xs shrink-0" strokeWidth={2} />
		</a>
	);
}

export function PRSummaryParts({
	className,
	omit,
	interactiveLinks = true,
	maxLinks = 3,
	pr,
	variant = "compact",
}: {
	className?: string;
	omit?: PRSummaryPartKey[];
	interactiveLinks?: boolean;
	maxLinks?: number;
	pr: SessionPRSummary;
	variant?: "compact" | "stacked";
}) {
	const { t } = useTranslation();
	const omitted = omit ? new Set(omit) : undefined;
	const parts = prSummaryParts(pr).filter((part) => !omitted?.has(part.key));
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

function SummaryLink({
	className,
	interactive,
	link,
}: {
	className?: string;
	interactive: boolean;
	link: PRSummaryLink;
}) {
	if (interactive && link.href) {
		return (
			<a
				className={cn(
					"inline-flex max-w-full min-w-0 items-center gap-0.5 text-settings-label underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
					className,
				)}
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
