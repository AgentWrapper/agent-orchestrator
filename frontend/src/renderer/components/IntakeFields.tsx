import { Info, X } from "lucide-react";
import { useState } from "react";
import type { components } from "../../api/schema";
import { Label } from "./ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

type TrackerIntakeConfig = components["schemas"]["TrackerIntakeConfig"];

// DEFAULT_OPT_OUT_LABELS mirrors the backend domain.DefaultOptOutLabels
// taxonomy (issue #80). The daemon materializes these into ExcludeLabels when a
// project enables intake without configuring the list, so the settings form
// shows them pre-filled for an unconfigured project. "charter" prefix-matches
// the whole charter:* family server-side (see observer.go). Keep this in sync
// with the Go constant; ProjectSettingsForm.test.tsx guards the pairing.
export const DEFAULT_OPT_OUT_LABELS = ["no-ao", "deferred", "charter", "charter-audit", "human-review"] as const;

// IntakeForm is the flat, string-backed shape both the create sheet and the
// project settings form edit. repo has no input today (it's derived from the
// git origin server-side) but is plumbed so a value set via the CLI
// (--tracker-repo) survives a UI save instead of being wiped. optOutLabels is
// the editable opt-out work gate: intake works every open issue that carries
// none of these labels.
export type IntakeForm = {
	enabled: boolean;
	repo: string;
	assignee: string;
	optOutLabels: string[];
};

// Only "github" is a valid TrackerIntakeConfig["provider"] today (see the
// backend's openapi enum). Adding Linear/Jira later means: the backend enum
// grows, IntakeFields gains a provider <Select> + per-provider scope fields,
// and buildIntake switches the scope field it emits.

// buildIntake produces the payload field. Disabled intake usually serializes to
// `undefined` (omit), but full-replace settings saves need an explicit
// `{ enabled: false }` sentinel so the daemon can distinguish an intentional
// disable from a stale writer that dropped trackerIntake. When enabled it
// spreads `base` (the config that loaded) first so fields the form does NOT own
// — labels, maxConcurrent — survive the save instead of being silently dropped;
// the form-owned fields then override. An empty optOutLabels list is omitted so
// the daemon falls back to the default taxonomy.
export function buildIntake(
	form: IntakeForm,
	base?: TrackerIntakeConfig,
	options: { explicitDisable?: boolean } = {},
): TrackerIntakeConfig | undefined {
	if (!form.enabled) {
		const hasDisabledBase = base !== undefined && base.enabled !== true && Object.keys(base).length > 0;
		return options.explicitDisable || hasDisabledBase ? { ...base, enabled: false } : undefined;
	}
	const excludeLabels = form.optOutLabels.map((l) => l.trim()).filter((l) => l !== "");
	const next: TrackerIntakeConfig = {
		...base,
		enabled: true,
		provider: "github",
		repo: form.repo.trim() || undefined,
		assignee: form.assignee.trim() || undefined,
		excludeLabels: excludeLabels.length > 0 ? excludeLabels : undefined,
	};
	return next;
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
// known: pass `{ value }` from settings to render the repo link row, and omit
// it from the create sheet (the origin URL isn't available there, and the
// daemon derives the repo regardless).
export function IntakeFields({
	form,
	onChange,
	repoPreview,
	compact = false,
}: {
	form: IntakeForm;
	onChange: (patch: Partial<IntakeForm>) => void;
	repoPreview?: { value?: string };
	// compact drops the descriptive/help prose and the opt-out label editor,
	// folding the explanation into an info-icon tooltip — used by the
	// create-project sheet, which stays minimal. The daemon still applies the
	// default opt-out taxonomy to a project created without an explicit list.
	compact?: boolean;
}) {
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
						<IntakeField label="Repository">
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
					<IntakeField label="Assignee" htmlFor="intakeAssignee">
						<input
							id="intakeAssignee"
							className="h-control-form w-full rounded-md border border-input bg-transparent px-2.5 text-control text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
							value={form.assignee}
							onChange={(e) => onChange({ assignee: e.target.value })}
							placeholder="optional — blank works any assignee, * requires one"
						/>
					</IntakeField>
					{!compact && (
						<IntakeField label="Opt-out labels">
							<OptOutLabelsEditor labels={form.optOutLabels} onChange={(optOutLabels) => onChange({ optOutLabels })} />
						</IntakeField>
					)}
				</>
			)}
		</div>
	);
}

// OptOutLabelsEditor is the add/remove tag list for the opt-out work gate.
// Intake works every open issue that carries NONE of these labels. "charter"
// also opts out the charter:* family (server-side prefix match).
function OptOutLabelsEditor({ labels, onChange }: { labels: string[]; onChange: (next: string[]) => void }) {
	const [draft, setDraft] = useState("");

	const add = () => {
		const value = draft.trim();
		if (value === "") return;
		if (labels.some((l) => l.toLowerCase() === value.toLowerCase())) {
			setDraft("");
			return;
		}
		onChange([...labels, value]);
		setDraft("");
	};

	const remove = (label: string) => onChange(labels.filter((l) => l !== label));

	return (
		<div className="flex flex-col gap-2">
			<p className="text-[12px] leading-5 text-muted-foreground">
				Intake works every open issue that carries none of these labels.{" "}
				<code className="text-foreground">charter</code> also opts out the{" "}
				<code className="text-foreground">charter:*</code> family.
			</p>
			{labels.length > 0 ? (
				<ul className="flex flex-wrap gap-1.5" aria-label="Opt-out labels">
					{labels.map((label) => (
						<li
							key={label}
							className="flex items-center gap-1 rounded-md border border-input bg-transparent py-0.5 pl-2 pr-1 text-[12px] text-foreground"
						>
							<span className="font-mono">{label}</span>
							<button
								type="button"
								className="grid size-4 place-items-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none"
								aria-label={`Remove ${label}`}
								onClick={() => remove(label)}
							>
								<X className="size-3" aria-hidden="true" />
							</button>
						</li>
					))}
				</ul>
			) : (
				// Empty ≠ "work everything": the daemon re-materializes the default
				// taxonomy when the list is unset, so say so rather than let the prose
				// above imply an empty list disables opt-out protection.
				<p className="text-[12px] leading-5 text-muted-foreground">
					None set — the default opt-out labels ({DEFAULT_OPT_OUT_LABELS.join(", ")}) apply.
				</p>
			)}
			<input
				aria-label="Add opt-out label"
				className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						add();
					}
				}}
				placeholder="add a label, press Enter"
			/>
		</div>
	);
}

function IntakeField({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
				{label}
			</Label>
			{children}
		</div>
	);
}
