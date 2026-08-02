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

import { Brain, ChevronUp, Cpu, Shield } from "lucide-react";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "../../lib/utils";
import type { ApprovalMode, ChatModel, TurnSettings } from "../../types/conversation";

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
	onChange,
	disabled,
}: {
	models: ChatModel[];
	settings: TurnSettings;
	onChange: (next: TurnSettings) => void;
	disabled?: boolean;
}) {
	const selected = models.find((model) => model.id === settings.model);
	const fallback = models.find((model) => model.default);
	// The label says what will actually be used: the provider's default is a real
	// answer, not an absence, so it is named rather than shown as "none".
	const modelLabel = selected?.displayName ?? fallback?.displayName ?? "Provider default";
	const efforts = (selected ?? fallback)?.efforts ?? [];
	const effortLabel =
		settings.reasoningEffort ?? (selected ?? fallback)?.defaultEffort ?? undefined;
	const approvalLabel = APPROVAL_COPY[settings.approvalMode ?? "default"].label;

	return (
		<div className="flex flex-wrap items-center gap-1">
			{models.length > 0 ? (
				<Picker
					icon={Cpu}
					label={modelLabel}
					title="Model for the next turn"
					disabled={disabled}
					width="w-80"
				>
					<DropdownMenuLabel className="flex items-baseline justify-between gap-2">
						<span>Model</span>
						<span className="text-[11px] font-normal text-muted-foreground">
							Applies to the next turn
						</span>
					</DropdownMenuLabel>
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

			{efforts.length > 0 ? (
				<Picker
					icon={Brain}
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
									effort === settings.reasoningEffort ? "text-foreground" : "text-muted-foreground",
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

			<Picker
				icon={Shield}
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
		</div>
	);
}

function Picker({
	icon: Icon,
	label,
	title,
	disabled,
	width,
	children,
}: {
	icon: typeof Cpu;
	label: string;
	title: string;
	disabled?: boolean;
	width: string;
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
					className="h-6 gap-1.5 px-1.5"
				>
					<Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
					<span className="max-w-[13ch] truncate text-[11px]">{label}</span>
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
