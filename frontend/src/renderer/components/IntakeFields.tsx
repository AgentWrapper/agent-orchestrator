import { Info } from "lucide-react";
import type { components } from "../../api/schema";
import { useTrackerIntakeIdentity } from "../hooks/useTrackerIntakeIdentity";
import { cn } from "../lib/utils";
import { LabelPicker } from "./LabelPicker";
import { MatchingIssuesPreview } from "./MatchingIssuesPreview";
import { Label } from "./ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

type TrackerIntakeConfig = components["schemas"]["TrackerIntakeConfig"];

// IntakeForm is the flat, string-backed shape both the create sheet and the
// project settings form edit. repo has no input today (it's derived from the
// git origin server-side) but is plumbed so a value set via the CLI
// (--tracker-repo) survives a UI save instead of being wiped.
export type IntakeForm = {
	enabled: boolean;
	repo: string;
	labels: string[];
};

// Only "github" is a valid TrackerIntakeConfig["provider"] today (see the
// backend's openapi enum). Adding Linear/Jira later means: the backend enum
// grows, IntakeFields gains a provider <Select> + per-provider scope fields,
// and buildIntake switches the scope field it emits.

// buildIntake produces the payload field, scrubbing empties so a disabled or
// blank intake serializes to `undefined` (omit) rather than an empty object the
// daemon would persist.
export function buildIntake(form: IntakeForm): TrackerIntakeConfig | undefined {
	if (!form.enabled) return undefined;
	const next: TrackerIntakeConfig = {
		enabled: true,
		provider: "github",
		repo: form.repo.trim() || undefined,
		labels: form.labels.length > 0 ? form.labels : undefined,
	};
	return Object.values(next).some((v) => v !== undefined) ? next : undefined;
}

// deriveGitHubRepo mirrors the daemon's parseGitHubRepoNative (scope.go):
// derive "owner/repo" from a git origin URL for display only. The daemon does
// the authoritative derivation server-side at poll time; this is purely so a
// settings card can show which repo intake will actually poll.
export function deriveGitHubRepo(remote?: string): string | undefined {
	const trimmed = remote?.trim();
	if (!trimmed) return undefined;
	let path: string | undefined;
	try {
		const url = new URL(trimmed);
		if (url.host) {
			if (!isGitHubHost(url.host)) return undefined;
			path = url.pathname;
		}
	} catch {
		// Fall through to scp-like parsing below.
	}
	if (!path) {
		const scp = parseSCPRemote(trimmed);
		if (!scp) return undefined;
		if (!isGitHubHost(scp.host)) return undefined;
		path = scp.path;
	}
	if (!path) return undefined;
	const parts = path
		.replace(/\.git$/, "")
		.replace(/^\/+|\/+$/g, "")
		.split("/");
	if (parts.length < 2) return undefined;
	const owner = parts[parts.length - 2].trim();
	const repo = parts[parts.length - 1].trim();
	return owner && repo ? `${owner}/${repo}` : undefined;
}

function isGitHubHost(host: string): boolean {
	const normalized = host
		.trim()
		.toLowerCase()
		.replace(/^www\./, "");
	return normalized === "github.com" || normalized.endsWith(".github.com") || normalized.endsWith(".ghe.io");
}

function parseSCPRemote(remote: string): { host: string; path: string } | undefined {
	const colon = remote.indexOf(":");
	if (colon <= 0 || colon === remote.length - 1) return undefined;
	const prefix = remote.slice(0, colon);
	const path = remote.slice(colon + 1);
	if (prefix.includes("/") || path.startsWith("//")) return undefined;
	const at = prefix.lastIndexOf("@");
	const host = (at >= 0 ? prefix.slice(at + 1) : prefix).trim();
	return host ? { host, path } : undefined;
}

// IntakeFields renders the shared "Tracker intake" controls: an enable checkbox
// that reveals the eligibility inputs. It is deliberately card-agnostic (no
// <Card> wrapper) so the create sheet and the settings form can frame it
// however they like.
//
// repoPreview is only meaningful once a project exists and its git origin is
// known: pass `{ show: true, value }` from settings to render the repo link
// row, and omit it from the create sheet (the origin URL isn't available there,
// and the daemon derives the repo regardless).
export function IntakeFields({
	form,
	onChange,
	repoPreview,
	projectId,
	compact = false,
	labelClassName,
}: {
	form: IntakeForm;
	onChange: (patch: Partial<IntakeForm>) => void;
	repoPreview?: { value?: string };
	projectId?: string;
	// compact drops the descriptive/help prose and folds the explanation into an
	// info-icon tooltip — used by the create-project sheet, which stays minimal.
	compact?: boolean;
	labelClassName?: string;
}) {
	const showDetails = form.enabled && !compact;
	const identityQuery = useTrackerIntakeIdentity(showDetails);
	const assignee = identityQuery.data ? (
		<a
			href={`https://github.com/${identityQuery.data.login}`}
			target="_blank"
			rel="noopener noreferrer"
			className="truncate text-[13px] text-accent hover:underline"
		>
			{identityQuery.data.login}
		</a>
	) : (
		<span className="truncate text-[13px] text-muted-foreground">
			{identityQuery.isError ? "Could not resolve authenticated GitHub user" : "Resolving authenticated GitHub user…"}
		</span>
	);
	return (
		<div className="flex flex-col gap-4">
			{!compact && (
				<p className="text-xs leading-row text-muted-foreground">
					Auto-spawn worker sessions from matching tracker issues.
				</p>
			)}
			<div className="flex items-center gap-2">
				<label className="flex items-center gap-2.5 text-control text-foreground">
					<input
						type="checkbox"
						className="size-icon-base accent-accent"
						checked={form.enabled}
						onChange={(e) => onChange({ enabled: e.target.checked })}
					/>
					Enable issue intake
				</label>
				{compact && (
					<TooltipProvider delayDuration={0}>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									className="grid size-icon-base place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none"
									aria-label="What does enabling issue intake do?"
								>
									<Info className="size-3.5" aria-hidden="true" />
								</button>
							</TooltipTrigger>
							<TooltipContent>Auto-spawns a worker session for each matching GitHub issue.</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				)}
			</div>
			{showDetails && (
				<>
					<div className={repoPreview ? "grid grid-cols-2 gap-3" : undefined}>
						{repoPreview && (
							<IntakeField label="Repository" labelClassName={labelClassName}>
								{repoPreview.value ? (
									<a
										href={`https://github.com/${repoPreview.value}`}
										target="_blank"
										rel="noopener noreferrer"
										className="truncate text-[13px] text-accent hover:underline"
									>
										{repoPreview.value}
									</a>
								) : (
									<span className="truncate text-[13px] text-muted-foreground">
										Could not detect a GitHub repo from this project's git origin.
									</span>
								)}
							</IntakeField>
						)}
						<IntakeField label="Assignee" labelClassName={labelClassName}>
							{assignee}
						</IntakeField>
					</div>
					{identityQuery.isError && !compact && (
						<p className="text-[12px] leading-5 text-error">Check GitHub authentication and try again.</p>
					)}
					{projectId ? (
						<>
							<IntakeField
								label="Labels"
								labelClassName={labelClassName}
								hint="Matches any selected label. No labels includes all."
							>
								<LabelPicker projectId={projectId} value={form.labels} onChange={(labels) => onChange({ labels })} />
							</IntakeField>
							<MatchingIssuesPreview projectId={projectId} labels={form.labels} />
						</>
					) : null}
				</>
			)}
		</div>
	);
}

function IntakeField({
	label,
	htmlFor,
	labelClassName,
	hint,
	children,
}: {
	label: string;
	htmlFor?: string;
	labelClassName?: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<div className="flex items-center gap-1.5">
				<Label htmlFor={htmlFor} className={cn("text-xs text-muted-foreground", labelClassName)}>
					{label}
				</Label>
				{hint ? (
					<TooltipProvider delayDuration={0}>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									className="grid size-4 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none"
									aria-label={`${label} help`}
								>
									<Info className="size-3.5" aria-hidden="true" />
								</button>
							</TooltipTrigger>
							<TooltipContent>{hint}</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				) : null}
			</div>
			{children}
		</div>
	);
}
