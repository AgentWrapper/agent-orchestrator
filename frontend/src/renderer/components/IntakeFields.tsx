import { Info } from "lucide-react";
import type { components } from "../../api/schema";
import { Label } from "./ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

type TrackerIntakeConfig = components["schemas"]["TrackerIntakeConfig"];

// IntakeForm is the flat, string-backed shape both the create sheet and the
// project settings form edit. repo/labels are plumbed but have no input today
// (labels are temporarily disabled; repo is derived from the git origin
// server-side) — keeping them in the form means a value set via the CLI
// (--tracker-label / --tracker-repo) survives a UI save instead of being wiped.
export type IntakeForm = {
	enabled: boolean;
	repo: string;
	labels: string;
	assignee: string;
};

// Only "github" is a valid TrackerIntakeConfig["provider"] today (see the
// backend's openapi enum). Adding Linear/Jira later means: the backend enum
// grows, IntakeFields gains a provider <Select> + per-provider scope fields,
// and buildIntake switches the scope field it emits.

export function parseLabels(value: string): string[] {
	return value
		.split(",")
		.map((label) => label.trim())
		.filter((label) => label.length > 0);
}

// intakeNeedsRule mirrors the backend guard (TrackerIntakeConfig.Validate):
// enabling intake requires at least one eligibility rule so it cannot drain an
// entire issue backlog. Labels count even though their input is hidden.
export function intakeNeedsRule(form: IntakeForm): boolean {
	return form.enabled && parseLabels(form.labels).length === 0 && form.assignee.trim() === "";
}

// buildIntake produces the payload field, scrubbing empties so a disabled or
// blank intake serializes to `undefined` (omit) rather than an empty object the
// daemon would persist.
export function buildIntake(form: IntakeForm): TrackerIntakeConfig | undefined {
	const labels = parseLabels(form.labels);
	const next: TrackerIntakeConfig = {
		enabled: form.enabled || undefined,
		provider: form.enabled ? "github" : undefined,
		repo: form.repo.trim() || undefined,
		labels: labels.length ? labels : undefined,
		assignee: form.assignee.trim() || undefined,
	};
	return Object.values(next).some((v) => v !== undefined) ? next : undefined;
}

// deriveGitHubRepo mirrors the daemon's parseGitHubRepoNative (observer.go):
// derive "owner/repo" from a git origin URL for display only. The daemon does
// the authoritative derivation server-side at poll time; this is purely so a
// settings card can show which repo intake will actually poll.
export function deriveGitHubRepo(remote?: string): string | undefined {
	const trimmed = remote?.trim();
	if (!trimmed) return undefined;
	let path: string | undefined;
	if (trimmed.startsWith("git@")) {
		path = trimmed.split(":")[1];
	} else {
		try {
			path = new URL(trimmed).pathname;
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
	compact = false,
}: {
	form: IntakeForm;
	onChange: (patch: Partial<IntakeForm>) => void;
	repoPreview?: { value?: string };
	// compact drops the descriptive/help prose and folds the explanation into an
	// info-icon tooltip — used by the create-project sheet, which stays minimal.
	compact?: boolean;
}) {
	const needsRule = intakeNeedsRule(form);
	return (
		<div className="flex flex-col gap-4">
			{!compact && (
				<p className="text-[12px] leading-5 text-muted-foreground">
					Auto-spawn worker sessions from matching tracker issues. Read-only toward the tracker: matching issues spawn
					sessions; the tracker is not commented on or transitioned.
				</p>
			)}
			<div className="flex items-center gap-2">
				<label className="flex items-center gap-2.5 text-[13px] text-foreground">
					<input
						type="checkbox"
						className="h-4 w-4 accent-accent"
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
									className="grid size-4 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none"
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
			{form.enabled && (
				<>
					{repoPreview && (
						<IntakeField label="Repository">
							{repoPreview.value ? (
								<a
									href={`https://github.com/${repoPreview.value}`}
									target="_blank"
									rel="noopener noreferrer"
									className="text-[13px] text-accent hover:underline"
								>
									{repoPreview.value}
								</a>
							) : (
								<span className="text-[13px] text-muted-foreground">
									Could not detect a GitHub repo from this project's git origin.
								</span>
							)}
						</IntakeField>
					)}
					<IntakeField label="Assignee" htmlFor="intakeAssignee">
						<input
							id="intakeAssignee"
							className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
							value={form.assignee}
							onChange={(e) => onChange({ assignee: e.target.value })}
							placeholder="type username or * for any"
						/>
					</IntakeField>
					{!compact && needsRule && (
						<p className="text-[12px] leading-5 text-error">Enabling intake requires at least one label or assignee.</p>
					)}
					{!compact && (
						<p className="text-[11px] leading-5 text-muted-foreground">
							Reads credentials from <span className="font-mono">AO_GITHUB_TOKEN, or `gh auth token`</span>. Restart the
							daemon after setting.
						</p>
					)}
				</>
			)}
		</div>
	);
}

function IntakeField({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={htmlFor} className="text-[12px] text-muted-foreground">
				{label}
			</Label>
			{children}
		</div>
	);
}
