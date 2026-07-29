import { FolderGit2, Inbox, Info, TriangleAlert, UserRound } from "lucide-react";
import type { components } from "../../api/schema";
import { cn } from "../lib/utils";
import { Label } from "./ui/label";
import { SettingsRow } from "./settings/SettingsRow";
import { Switch } from "./ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

type TrackerIntakeConfig = components["schemas"]["TrackerIntakeConfig"];

// IntakeForm is the flat, string-backed shape both the create sheet and the
// project settings form edit. GitHub repo is derived from the git origin
// server-side but remains plumbed so a CLI value survives a UI save.
export type IntakeForm = {
	enabled: boolean;
	provider: NonNullable<TrackerIntakeConfig["provider"]>;
	repo: string;
	scope: string;
	assignee: string;
};

// intakeNeedsRule mirrors the backend guard (TrackerIntakeConfig.Validate):
// enabling intake requires an assignee, and Linear additionally requires an
// explicit team/project scope.
export function intakeNeedsRule(form: IntakeForm): boolean {
	return intakeNeedsScope(form) || intakeNeedsAssignee(form);
}

export function intakeNeedsScope(form: IntakeForm): boolean {
	return form.enabled && form.provider === "linear" && linearScope(form.scope).id === "";
}

export function intakeNeedsAssignee(form: IntakeForm): boolean {
	return form.enabled && form.assignee.trim() === "";
}

// buildIntake produces the payload field, scrubbing empties so a disabled or
// blank intake serializes to `undefined` (omit) rather than an empty object the
// daemon would persist.
export function buildIntake(form: IntakeForm): TrackerIntakeConfig | undefined {
	const repo = form.repo.trim();
	const scope = form.scope.trim();
	const assignee = form.assignee.trim();
	const next: TrackerIntakeConfig = {
		enabled: form.enabled || undefined,
		provider:
			form.enabled || (form.provider === "linear" && (scope !== "" || assignee !== "")) ? form.provider : undefined,
		repo: form.provider === "github" ? repo || undefined : undefined,
		scope: form.provider === "linear" ? scope || undefined : undefined,
		assignee: assignee || undefined,
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
// known: pass `{ value }` from settings to render the repo link
// row, and omit it from the create sheet (the origin URL isn't available there,
// and the daemon derives the repo regardless).
export function IntakeFields({
	form,
	onChange,
	repoPreview,
	compact = false,
	controlClassName,
	labelClassName,
	variant = "default",
}: {
	form: IntakeForm;
	onChange: (patch: Partial<IntakeForm>) => void;
	repoPreview?: { value?: string };
	// compact drops the descriptive/help prose and folds the explanation into an
	// info-icon tooltip — used by the create-project sheet, which stays minimal.
	compact?: boolean;
	controlClassName?: string;
	labelClassName?: string;
	variant?: "default" | "settings";
}) {
	const needsScope = intakeNeedsScope(form);
	const needsAssignee = intakeNeedsAssignee(form);
	const scope = linearScope(form.scope);
	const updateScope = (patch: Partial<{ kind: "team" | "project"; id: string }>) => {
		const kind = patch.kind ?? scope.kind;
		const id = patch.id ?? scope.id;
		onChange({ scope: `${kind}:${id}` });
	};
	if (variant === "settings") {
		return (
			<div className="flex flex-col gap-1.5">
				<SettingsRow icon={Inbox} label="Enable issue intake">
					<Switch
						aria-label="Enable issue intake"
						checked={form.enabled}
						onCheckedChange={(enabled) => onChange({ enabled })}
					/>
				</SettingsRow>
				{form.enabled && (
					<>
						<SettingsRow icon={Inbox} label="Provider">
							<ProviderSelect form={form} onChange={onChange} className="settings-inline-input" />
						</SettingsRow>
						{form.provider === "github" && repoPreview && (
							<SettingsRow icon={FolderGit2} label="Repository">
								{repoPreview.value ? (
									<a
										href={`https://github.com/${repoPreview.value}`}
										target="_blank"
										rel="noopener noreferrer"
										className="settings-row-value text-settings-accent hover:underline"
									>
										{repoPreview.value}
									</a>
								) : (
									<span className="settings-row-value">
										Could not detect a GitHub repo from this project's git origin.
									</span>
								)}
							</SettingsRow>
						)}
						{form.provider === "linear" && (
							<>
								<SettingsRow icon={FolderGit2} label="Scope type">
									<ScopeTypeSelect
										value={scope.kind}
										onChange={(kind) => updateScope({ kind })}
										className="settings-inline-input"
									/>
								</SettingsRow>
								<SettingsRow icon={FolderGit2} label="Scope ID">
									<input
										aria-label="Linear scope ID"
										className="settings-inline-input"
										value={scope.id}
										onChange={(event) => updateScope({ id: event.target.value })}
										placeholder="Linear team or project ID"
									/>
								</SettingsRow>
							</>
						)}
						<SettingsRow icon={UserRound} label="Assignee">
							<input
								id="intakeAssignee"
								aria-label="Assignee"
								className="settings-inline-input"
								value={form.assignee}
								onChange={(e) => onChange({ assignee: e.target.value })}
								placeholder={
									form.provider === "linear" ? "type assignee name or * for any" : "type username or * for any"
								}
							/>
						</SettingsRow>
						{needsScope && <IntakeScopeError />}
						{needsAssignee && <IntakeAssigneeError />}
					</>
				)}
			</div>
		);
	}
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
							<TooltipContent>Auto-spawns a worker session for each matching tracker issue.</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				)}
			</div>
			{form.enabled && (
				<>
					<IntakeField label="Provider" htmlFor="intakeProvider" labelClassName={labelClassName}>
						<ProviderSelect
							form={form}
							onChange={onChange}
							className={cn(
								"h-control-form w-full rounded-md border border-input bg-transparent px-2.5 text-control text-foreground focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak",
								controlClassName,
							)}
						/>
					</IntakeField>
					{form.provider === "github" && repoPreview && (
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
					{form.provider === "linear" && (
						<>
							<IntakeField label="Scope type" htmlFor="linearScopeType" labelClassName={labelClassName}>
								<ScopeTypeSelect
									value={scope.kind}
									onChange={(kind) => updateScope({ kind })}
									className={cn(
										"h-control-form w-full rounded-md border border-input bg-transparent px-2.5 text-control text-foreground focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak",
										controlClassName,
									)}
								/>
							</IntakeField>
							<IntakeField label="Scope ID" htmlFor="linearScopeId" labelClassName={labelClassName}>
								<input
									id="linearScopeId"
									aria-label="Linear scope ID"
									className={cn(
										"h-control-form w-full rounded-md border border-input bg-transparent px-2.5 text-control text-foreground placeholder:text-passive focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak",
										controlClassName,
									)}
									value={scope.id}
									onChange={(event) => updateScope({ id: event.target.value })}
									placeholder="Linear team or project ID"
								/>
							</IntakeField>
						</>
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
							placeholder={
								form.provider === "linear" ? "type assignee name or * for any" : "type username or * for any"
							}
						/>
					</IntakeField>
					{!compact && needsScope && <IntakeScopeError />}
					{!compact && needsAssignee && <IntakeAssigneeError />}
				</>
			)}
		</div>
	);
}

function ProviderSelect({
	form,
	onChange,
	className,
}: {
	form: IntakeForm;
	onChange: (patch: Partial<IntakeForm>) => void;
	className: string;
}) {
	return (
		<select
			id="intakeProvider"
			aria-label="Tracker provider"
			className={className}
			value={form.provider}
			onChange={(event) => onChange({ provider: event.target.value as IntakeForm["provider"] })}
		>
			<option value="github">GitHub</option>
			<option value="linear">Linear</option>
		</select>
	);
}

function ScopeTypeSelect({
	value,
	onChange,
	className,
}: {
	value: "team" | "project";
	onChange: (value: "team" | "project") => void;
	className: string;
}) {
	return (
		<select
			id="linearScopeType"
			aria-label="Linear scope type"
			className={className}
			value={value}
			onChange={(event) => onChange(event.target.value as "team" | "project")}
		>
			<option value="team">Team</option>
			<option value="project">Project</option>
		</select>
	);
}

function linearScope(value: string): { kind: "team" | "project"; id: string } {
	const [kind, ...idParts] = value.split(":");
	return {
		kind: kind === "project" ? "project" : "team",
		id: (kind === "team" || kind === "project" ? idParts.join(":") : "").trim(),
	};
}

function IntakeScopeError() {
	return (
		<p className="flex items-center gap-1.5 px-1 text-xs leading-row text-error">
			<TriangleAlert className="size-3 shrink-0 text-error" aria-hidden="true" />
			Enabling Linear intake requires a team or project ID.
		</p>
	);
}

function IntakeAssigneeError() {
	return (
		<p className="flex items-center gap-1.5 px-1 text-xs leading-row text-error">
			<TriangleAlert className="size-3 shrink-0 text-error" aria-hidden="true" />
			Enabling intake requires an assignee.
		</p>
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
