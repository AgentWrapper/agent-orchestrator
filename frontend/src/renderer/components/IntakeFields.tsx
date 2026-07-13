import { Info } from "lucide-react";
import type { components } from "../../api/schema";
import { useTrackerIntakeIdentity } from "../hooks/useTrackerIntakeIdentity";
import { useTrackerIntakeTeams } from "../hooks/useTrackerIntakeTeams";
import { LabelPicker } from "./LabelPicker";
import { MatchingIssuesPreview } from "./MatchingIssuesPreview";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

type TrackerIntakeConfig = components["schemas"]["TrackerIntakeConfig"];
export type IntakeProvider = "github" | "linear";

// IntakeForm is the flat, string-backed shape both the create sheet and the
// project settings form edit. repo has no input today (it's derived from the
// git origin server-side) but is plumbed so a value set via the CLI
// (--tracker-repo) survives a UI save instead of being wiped.
export type IntakeForm = {
	enabled: boolean;
	provider: IntakeProvider;
	repo: string;
	teamId: string;
	labels: string[];
};

// buildIntake produces the payload field, scrubbing empties so a disabled or
// blank intake serializes to `undefined` (omit) rather than an empty object the
// daemon would persist.
export function buildIntake(form: IntakeForm): TrackerIntakeConfig | undefined {
	const next: TrackerIntakeConfig = {
		enabled: form.enabled || undefined,
		provider: form.enabled || form.provider !== "github" ? form.provider : undefined,
		repo: form.provider === "github" ? form.repo.trim() || undefined : undefined,
		teamId: form.provider === "linear" ? form.teamId.trim() || undefined : undefined,
		labels: form.provider === "github" && form.labels.length > 0 ? form.labels : undefined,
	};
	return Object.values(next).some((v) => v !== undefined) ? next : undefined;
}

export function intakeValidationMessage(form: IntakeForm): string | null {
	if (!form.enabled) return null;
	if (form.provider === "linear" && form.teamId.trim() === "") {
		return "Select a Linear team.";
	}
	return null;
}

// deriveGitHubRepo mirrors the daemon's parseGitHubRepoNative (scope.go):
// derive "owner/repo" from a git origin URL for display only. The daemon does
// the authoritative derivation server-side at poll time; this is purely so a
// settings card can show which repo intake will actually poll.
export function deriveGitHubRepo(remote?: string): string | undefined {
	const trimmed = remote?.trim();
	if (!trimmed) return undefined;
	let path: string | undefined;
	if (trimmed.startsWith("git@")) {
		const [hostPart, repoPath] = trimmed.slice("git@".length).split(":", 2);
		if (!isGitHubHost(hostPart)) return undefined;
		path = repoPath;
	} else {
		try {
			const url = new URL(trimmed);
			if (!isGitHubHost(url.host)) return undefined;
			path = url.pathname;
		} catch {
			path = trimmed;
		}
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
}: {
	form: IntakeForm;
	onChange: (patch: Partial<IntakeForm>) => void;
	repoPreview?: { value?: string };
	projectId?: string;
	// compact drops the descriptive/help prose and folds the explanation into an
	// info-icon tooltip — used by the create-project sheet, which stays minimal.
	compact?: boolean;
}) {
	const showDetails = form.enabled;
	const isGitHub = form.provider === "github";
	const isLinear = form.provider === "linear";
	const identityQuery = useTrackerIntakeIdentity(showDetails && isGitHub && !compact);
	const teamsQuery = useTrackerIntakeTeams(showDetails && isLinear);
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
							<TooltipContent>Auto-spawns a worker session for matching tracker issues.</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				)}
			</div>
			{showDetails && (
				<>
					<IntakeField label="Provider">
						<Select
							value={form.provider}
							onValueChange={(provider) =>
								onChange({
									provider: provider as IntakeProvider,
									repo: provider === "github" ? form.repo : "",
									teamId: provider === "linear" ? form.teamId : "",
									labels: provider === "github" ? form.labels : [],
								})
							}
						>
							<SelectTrigger className="h-8 w-full text-[13px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="github">GitHub</SelectItem>
								<SelectItem value="linear">Linear</SelectItem>
							</SelectContent>
						</Select>
					</IntakeField>
					{isGitHub ? (
						<div className={repoPreview && !compact ? "grid grid-cols-2 gap-3" : undefined}>
							{repoPreview && !compact && (
								<IntakeField label="Repository">
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
							{!compact && <IntakeField label="Assignee">{assignee}</IntakeField>}
						</div>
					) : (
						<IntakeField label="Team">
							<Select
								value={form.teamId}
								onValueChange={(teamId) => onChange({ teamId })}
								disabled={teamsQuery.isLoading || teamsQuery.isError}
							>
								<SelectTrigger className="h-8 w-full text-[13px]">
									<SelectValue placeholder={teamsQuery.isLoading ? "Loading teams..." : "Select team"} />
								</SelectTrigger>
								<SelectContent>
									{(teamsQuery.data?.teams ?? []).map((team) => (
										<SelectItem key={team.id} value={team.id}>
											{team.key ? `${team.key} · ${team.name}` : team.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{teamsQuery.isError ? (
								<p className="text-[12px] leading-5 text-error">Could not load Linear teams.</p>
							) : form.teamId.trim() === "" ? (
								<p className="text-[12px] leading-5 text-muted-foreground">Select a team to start Linear intake.</p>
							) : null}
						</IntakeField>
					)}
					{identityQuery.isError && isGitHub && !compact && (
						<p className="text-[12px] leading-5 text-error">Check GitHub authentication and try again.</p>
					)}
					{projectId && isGitHub && !compact ? (
						<>
							<IntakeField label="Labels">
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

function IntakeField({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<Label htmlFor={htmlFor} className="text-[12px] text-muted-foreground">
				{label}
			</Label>
			{children}
		</div>
	);
}
