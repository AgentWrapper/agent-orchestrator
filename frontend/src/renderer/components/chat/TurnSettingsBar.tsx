/**
 * What the next turn will be sent with: model, reasoning effort, approval mode.
 *
 * All three are per-turn on the provider's side, so choosing one changes the next
 * message and never restarts the agent — the running turn keeps what it was
 * dispatched with. That is why this sits in the composer rather than in settings.
 *
 * The catalog comes from the provider, not from a list in AO. Models are added,
 * renamed, hidden per account and gated by entitlement AO cannot see, so a
 * hardcoded list would be wrong within a week. An agent whose provider cannot
 * enumerate models reports none and the model control hides itself.
 */

import { Fragment } from "react";
import {
	ChevronUp,
	Shuffle,
} from "lucide-react";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "../../lib/utils";
import type {
	ApprovalMode,
	ChatConfigOption,
	ChatConfigOptionValue,
	ChatModel,
	ModelReroute,
	TurnSettings,
} from "../../types/conversation";

/**
 * AO's four approval modes, in increasing order of what the agent may do without
 * asking. The hints say what each actually permits rather than naming a policy.
 */
const APPROVAL_COPY: Record<ApprovalMode, { label: string; hint: string }> = {
	default: { label: "Default", hint: "Never asks — the worktree is the boundary" },
	"accept-edits": { label: "Ask outside worktree", hint: "Edits here are free; anything else asks" },
	auto: { label: "Ask when unsure", hint: "The agent decides when to check with you" },
	"bypass-permissions": { label: "Never ask", hint: "No approvals, no sandbox" },
};

const APPROVAL_ORDER: ApprovalMode[] = [
	"default",
	"accept-edits",
	"auto",
	"bypass-permissions",
];

export function TurnSettingsBar({
	models,
	settings,
	reroute,
	onChange,
	configOptions,
	onChangeConfigOption,
	configPending,
	error,
	disabled,
}: {
	models: ChatModel[];
	settings: TurnSettings;
	/**
	 * The provider answered with a different model than the one chosen. Separate from
	 * `settings` all the way down: settings are what the user asked for, this is what
	 * replied, and folding them together is how the control ends up advertising a
	 * model that is not the one producing the answers.
	 */
	reroute?: ModelReroute;
	onChange?: (next: TurnSettings) => void;
	/** Controls advertised by an ACP agent for this exact live session. */
	configOptions?: ChatConfigOption[];
	onChangeConfigOption?: (
		optionId: string,
		value: ChatConfigOptionValue,
	) => Promise<unknown> | void;
	configPending?: boolean;
	error?: string;
	disabled?: boolean;
}) {
	const selected = models.find((model) => model.id === settings.model);
	const fallback = models.find((model) => model.default);
	// The label says what will actually be used: the provider's default is a real
	// answer, not an absence, so it is named rather than shown as "none".
	const chosenLabel = selected?.displayName ?? fallback?.displayName ?? "Provider default";
	const rerouted = reroute
		? models.find((model) => model.id === reroute.toModel)?.displayName ?? reroute.toModel
		: undefined;
	const efforts = (selected ?? fallback)?.efforts ?? [];
	const effortLabel =
		settings.reasoningEffort ?? (selected ?? fallback)?.defaultEffort ?? undefined;
	const approvalLabel = APPROVAL_COPY[settings.approvalMode ?? "default"].label;

	return (
		<div role="group" aria-label="Turn settings" className="flex min-w-0 flex-col gap-0.5">
			<div className="flex flex-wrap items-center gap-0.5">
				{onChange && models.length > 0 ? (
				<Picker
					// What is answering, not what was asked for. The substitution stays
					// visible beside it rather than replacing the choice, because the choice
					// is still the user's and still applies to the next turn.
					label={rerouted ?? chosenLabel}
					title={
						reroute
							? `The provider answered with ${rerouted} instead of ${reroute.fromModel ?? chosenLabel}${
									reroute.reason ? `: ${reroute.reason}` : ""
								}`
							: "Model for the next turn"
					}
					disabled={disabled}
					width="w-80"
					badge={
						reroute ? (
							// A mark, not a second name. Two truncated model names side by side is
							// less legible than one readable name plus a flag that says it is not
							// the one that was asked for; the tooltip and the menu spell out which.
							<Shuffle
								className="size-3 shrink-0 text-warning"
								aria-label={`Substituted for ${reroute.fromModel ?? chosenLabel}`}
							/>
						) : null
					}
				>
					<DropdownMenuLabel className="flex items-baseline justify-between gap-2">
						<span>Model</span>
						<span className="text-[11px] font-normal text-muted-foreground">
							Applies to the next turn
						</span>
					</DropdownMenuLabel>
					{/* Said inside the menu as well as on the trigger: this is where a user
					    goes to change the model, and it is where the fact that their last
					    choice was overridden matters most. */}
					{reroute ? (
						<p className="px-2 pb-1.5 text-[11px] leading-snug text-warning">
							The provider answered with {rerouted} instead of{" "}
							{reroute.fromModel ?? chosenLabel}
							{reroute.reason ? ` — ${reroute.reason}` : "."}
						</p>
					) : null}
					{models.map((model) => (
						<DropdownMenuItem
							key={model.id}
							onSelect={() =>
								// Effort is cleared with the model: a level one model supports is
								// not necessarily one the next model does.
								onChange({ ...settings, model: model.id, reasoningEffort: undefined })
							}
							className="flex flex-col items-start gap-0.5"
						>
							<span className="flex w-full items-baseline gap-2">
								<span
									className={cn(
										"text-xs",
										model.id === settings.model ? "text-foreground" : "text-muted-foreground",
									)}
								>
									{model.displayName}
								</span>
								{model.default ? (
									<span className="text-[10px] uppercase tracking-wide text-muted-foreground">
										default
									</span>
								) : null}
								{model.id === settings.model ? (
									<span className="ml-auto text-[10px] text-accent">selected</span>
								) : null}
							</span>
							{model.description ? (
								<span className="text-[11px] leading-snug text-muted-foreground">
									{model.description}
								</span>
							) : null}
						</DropdownMenuItem>
					))}
					</Picker>
				) : null}

				{onChange && efforts.length > 0 ? (
					<Picker
						label={effortLabel ? capitalize(effortLabel) : "Effort"}
						title="Reasoning effort for the next turn"
						disabled={disabled}
						width="w-56"
					>
						<DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
						{efforts.map((effort) => (
							<DropdownMenuItem
								key={effort}
								onSelect={() => onChange({ ...settings, reasoningEffort: effort })}
								className="text-xs"
							>
								<span
									className={cn(
										effort === settings.reasoningEffort
											? "text-foreground"
											: "text-muted-foreground",
									)}
								>
									{capitalize(effort)}
								</span>
								{effort === settings.reasoningEffort ? (
									<span className="ml-auto text-[10px] text-accent">selected</span>
								) : null}
							</DropdownMenuItem>
						))}
					</Picker>
				) : null}

				{onChange ? (
					<Picker
						label={approvalLabel}
						title="What the agent may do without asking"
						disabled={disabled}
						width="w-72"
					>
						<DropdownMenuLabel className="flex items-baseline justify-between gap-2">
							<span>Approvals</span>
							<span className="text-[11px] font-normal text-muted-foreground">
								Applies to the next turn
							</span>
						</DropdownMenuLabel>
						{APPROVAL_ORDER.map((mode) => (
							<DropdownMenuItem
								key={mode}
								onSelect={() => onChange({ ...settings, approvalMode: mode })}
								className="flex flex-col items-start gap-0.5"
							>
								<span
									className={cn(
										"text-xs",
										mode === (settings.approvalMode ?? "default")
											? "text-foreground"
											: "text-muted-foreground",
									)}
								>
									{APPROVAL_COPY[mode].label}
								</span>
								<span className="text-[11px] leading-snug text-muted-foreground">
									{APPROVAL_COPY[mode].hint}
								</span>
							</DropdownMenuItem>
						))}
					</Picker>
				) : null}

				{onChangeConfigOption
					? (configOptions ?? []).map((option) => (
						<ConfigOptionPicker
							key={option.id}
							option={option}
							disabled={disabled || configPending}
							onChange={(value) => {
								// The hook owns and renders any rejection. Swallowing here avoids an
								// unhandled promise without pretending the selection succeeded.
								void Promise.resolve(onChangeConfigOption(option.id, value)).catch(
									() => {},
								);
							}}
						/>
						))
					: null}
			</div>
			{error ? (
				<p role="alert" className="px-1 text-[11px] leading-snug text-destructive">
					{error}
				</p>
			) : null}
		</div>
	);
}

function ConfigOptionPicker({
	option,
	onChange,
	disabled,
}: {
	option: ChatConfigOption;
	onChange: (value: ChatConfigOptionValue) => void;
	disabled?: boolean;
}) {
	const currentChoice = option.choices.find((choice) => choice.value === option.currentValue);
	const label =
		option.type === "boolean"
			? option.currentBoolean
				? "On"
				: "Off"
			: currentChoice?.name ?? option.currentValue ?? option.name;

	return (
		<Picker
			label={label}
			title={option.description || option.name}
			disabled={disabled}
			width="w-72"
		>
			<DropdownMenuLabel className="flex flex-col gap-0.5">
				<span>{option.name}</span>
				{option.description ? (
					<span className="text-[11px] font-normal leading-snug text-muted-foreground">
						{option.description}
					</span>
				) : null}
			</DropdownMenuLabel>
			{option.type === "boolean" ? (
				[true, false].map((enabled) => (
					<DropdownMenuItem
						key={String(enabled)}
						onSelect={() => onChange({ enabled })}
						className="text-xs"
					>
						<span
							className={cn(
								enabled === option.currentBoolean
									? "text-foreground"
									: "text-muted-foreground",
							)}
						>
							{enabled ? "On" : "Off"}
						</span>
						{enabled === option.currentBoolean ? (
							<span className="ml-auto text-[10px] text-accent">selected</span>
						) : null}
					</DropdownMenuItem>
				))
			) : (
				option.choices.map((choice, index) => {
					const previousGroup = index > 0 ? option.choices[index - 1]?.group : undefined;
					return (
						<Fragment key={choice.value}>
							{choice.group && choice.group !== previousGroup ? (
								<DropdownMenuLabel className="pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
									{choice.groupName || choice.group}
								</DropdownMenuLabel>
							) : null}
							<DropdownMenuItem
								onSelect={() => onChange({ value: choice.value })}
								className="flex flex-col items-start gap-0.5"
							>
								<span className="flex w-full items-baseline gap-2">
									<span
										className={cn(
											"text-xs",
											choice.value === option.currentValue
												? "text-foreground"
												: "text-muted-foreground",
										)}
									>
										{choice.name}
									</span>
									{choice.value === option.currentValue ? (
										<span className="ml-auto text-[10px] text-accent">selected</span>
									) : null}
								</span>
								{choice.description ? (
									<span className="text-[11px] leading-snug text-muted-foreground">
										{choice.description}
									</span>
								) : null}
							</DropdownMenuItem>
						</Fragment>
					);
				})
			)}
		</Picker>
	);
}

function Picker({
	label,
	title,
	disabled,
	width,
	badge,
	children,
}: {
	label: string;
	title: string;
	disabled?: boolean;
	width: string;
	/** A note that belongs on the trigger, e.g. the model that was overridden. */
	badge?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={disabled}
					aria-label={title}
					title={title}
					className="h-8 gap-1.5 px-2"
				>
					<span className="max-w-[13ch] truncate text-[11px]">{label}</span>
					{badge}
					<ChevronUp aria-hidden="true" className="size-3 text-muted-foreground" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" side="top" className={cn("max-h-80 overflow-y-auto", width)}>
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}
