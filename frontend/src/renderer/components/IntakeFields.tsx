import { Info } from "lucide-react";
import type { components } from "../../api/schema";
import { Label } from "./ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

type TrackerIntakeConfig = components["schemas"]["TrackerIntakeConfig"];

export type IntakeForm = {
	enabled: boolean;
	repo: string;
	assignee: string;
	maxConcurrent: string;
};

export function intakeIsValid(form: IntakeForm): boolean {
	if (!form.enabled) return true;
	const assignee = form.assignee.trim();
	const maxConcurrent = Number(form.maxConcurrent.trim());
	return assignee !== "" && assignee.toLowerCase() !== "none" && Number.isInteger(maxConcurrent) && maxConcurrent > 0;
}

export function buildIntake(
	form: IntakeForm,
	base?: TrackerIntakeConfig,
	options: { explicitDisable?: boolean } = {},
): TrackerIntakeConfig | undefined {
	if (!form.enabled) {
		const hasDisabledBase = base !== undefined && base.enabled !== true && Object.keys(base).length > 0;
		if (!options.explicitDisable && !hasDisabledBase) return undefined;
		const disabled: TrackerIntakeConfig = { ...base, enabled: false };
		delete disabled.labels;
		delete disabled.excludeLabels;
		return disabled;
	}
	if (!intakeIsValid(form)) {
		throw new Error("Enabled tracker intake requires an assignee and a positive finite concurrency cap.");
	}
	const next: TrackerIntakeConfig = {
		...base,
		enabled: true,
		provider: "github",
		assignee: form.assignee.trim(),
		maxConcurrent: Number(form.maxConcurrent.trim()),
	};
	const repo = form.repo.trim();
	if (repo) next.repo = repo;
	else delete next.repo;
	// Legacy fields remain readable in the API schema for persisted-config
	// compatibility, but the browser never emits label-based admission rules.
	delete next.labels;
	delete next.excludeLabels;
	return next;
}

export function deriveGitHubRepo(remote?: string): string | undefined {
	const trimmed = remote?.trim();
	if (!trimmed) return undefined;
	let path: string | undefined;
	if (trimmed.startsWith("git@")) path = trimmed.split(":")[1];
	else {
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

export function IntakeFields({
	form,
	onChange,
	repoPreview,
	compact = false,
}: {
	form: IntakeForm;
	onChange: (patch: Partial<IntakeForm>) => void;
	repoPreview?: { value?: string };
	compact?: boolean;
}) {
	return (
		<div className="flex flex-col gap-4">
			{!compact && (
				<p className="text-xs leading-row text-muted-foreground">
					Assignment authorizes execution. Unassigned issues are inert; labels never grant or veto intake.
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
							<TooltipContent>
								Auto-spawns workers only for assigned GitHub issues, up to the configured cap.
							</TooltipContent>
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
					<IntakeField label="Authorized assignee" htmlFor="intakeAssignee">
						<input
							id="intakeAssignee"
							required
							className="h-control-form w-full rounded-md border border-input bg-transparent px-2.5 text-control text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
							value={form.assignee}
							onChange={(e) => onChange({ assignee: e.target.value })}
							placeholder="* = any assigned issue"
						/>
					</IntakeField>
					<IntakeField label="Maximum concurrent workers" htmlFor="intakeMaxConcurrent">
						<input
							id="intakeMaxConcurrent"
							type="number"
							required
							min={1}
							step={1}
							className="h-control-form w-full rounded-md border border-input bg-transparent px-2.5 text-control text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
							value={form.maxConcurrent}
							onChange={(e) => onChange({ maxConcurrent: e.target.value })}
							placeholder="2"
						/>
					</IntakeField>
				</>
			)}
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
