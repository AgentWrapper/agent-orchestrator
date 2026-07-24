import { Info } from "lucide-react";
import type { components } from "../../api/schema";
import { cn } from "../lib/utils";
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
	assignee: string;
};

// Only "github" is a valid TrackerIntakeConfig["provider"] today (see the
// backend's openapi enum). Adding Linear/Jira later means: the backend enum
// grows, IntakeFields gains a provider <Select> + per-provider scope fields,
// and buildIntake switches the scope field it emits.

// intakeNeedsRule mirrors the backend guard (TrackerIntakeConfig.Validate):
// enabling intake requires an assignee so it cannot drain an entire issue
// backlog. v1 intake is assignee-only.
export function intakeNeedsRule(form: IntakeForm): boolean {
	return form.enabled && form.assignee.trim() === "";
}

// buildIntake produces the payload field, scrubbing empties so a disabled or
// blank intake serializes to `undefined` (omit) rather than an empty object the
// daemon would persist.
export function buildIntake(form: IntakeForm): TrackerIntakeConfig | undefined {
	const next: TrackerIntakeConfig = {
		enabled: form.enabled || undefined,
		provider: form.enabled ? "github" : undefined,
		repo: form.repo.trim() || undefined,
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
	controlClassName,
	labelClassName,
}: {
	form: IntakeForm;
	onChange: (patch: Partial<IntakeForm>) => void;
	repoPreview?: { value?: string };
	// compact drops the descriptive/help prose and folds the explanation into an
	// info-icon tooltip — used by the create-project sheet, which stays minimal.
	compact?: boolean;
	controlClassName?: string;
	labelClassName?: string;
}) {
	const needsRule = intakeNeedsRule(form);
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
			{form.enabled && (
				<>
					{repoPreview && (
						<IntakeField label="Repository" labelClassName={labelClassName}>
							{repoPreview.value ? (
								<a
									href={`https://github.com/${repoPreview.value}`}
									target="_blank"
									rel="noopener noreferrer"
									className="text-control text-accent hover:underline"
								>
									{repoPreview.value}
								</a>
							) : (
								<span className="text-control text-muted-foreground">
									Could not detect a GitHub repo from this project's git origin.
								</span>
							)}
						</IntakeField>
					)}
					<IntakeField label="Assignee" htmlFor="intakeAssignee" labelClassName={labelClassName}>
						<input
							id="intakeAssignee"
							className={cn(
								"h-control-form w-full rounded-md border border-input bg-transparent px-2.5 text-control text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak",
								controlClassName,
							)}
							value={form.assignee}
							onChange={(e) => onChange({ assignee: e.target.value })}
							placeholder="type username or * for any"
						/>
					</IntakeField>
					{!compact && needsRule && (
						<p className="text-xs leading-row text-error">Enabling intake requires an assignee.</p>
					)}
				</>
			)}
		</div>
	);
}

function IntakeField({
	label,
	htmlFor,
	labelClassName,
	children,
}: {
	label: string;
	htmlFor?: string;
	labelClassName?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={htmlFor} className={cn("text-xs text-muted-foreground", labelClassName)}>
				{label}
			</Label>
			{children}
		</div>
	);
}
