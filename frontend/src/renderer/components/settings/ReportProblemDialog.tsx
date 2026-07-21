import * as Dialog from "@radix-ui/react-dialog";
import { RadioGroup } from "radix-ui";
import { CircleDot, Mail, MessageSquare, X, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
	collectReportProblemDiagnostics,
	formatReportProblemDraft,
	reportProblemDestinationUrl,
	type ReportProblemDiagnostics,
	type ReportProblemOutput,
} from "../../lib/report-problem";
import { aoBridge } from "../../lib/bridge";
import { cn } from "../../lib/utils";

type ReportProblemDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

const DEFAULT_DIAGNOSTICS: ReportProblemDiagnostics = {
	appVersion: "unknown",
	buildMode: "unknown",
	daemonState: "unknown",
	generatedAt: "unknown",
	platform: "unknown",
	routeSurface: "unknown",
};

const DESTINATIONS: {
	value: ReportProblemOutput;
	label: string;
	action: string;
	icon: LucideIcon;
}[] = [
	{ value: "github", label: "GitHub", action: "Copy & Create GitHub Issue", icon: CircleDot },
	{ value: "discord", label: "Discord", action: "Copy & Open Discord", icon: MessageSquare },
	{ value: "email", label: "Email", action: "Copy & Open Email", icon: Mail },
];

// Same field language as the Connect Mobile dialog: subtle bg, low-contrast
// border, smooth accent focus ring.
const fieldLabelClass = "text-control font-medium leading-4 text-settings-label";
const fieldControlClass =
	"w-full rounded-(--radius-settings-action) border border-[var(--color-border-settings-input)] bg-[var(--color-bg-settings-input)] px-3.5 text-sm leading-5 text-[var(--color-text-settings-input)] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-[var(--color-text-settings-placeholder)] focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-weak";

const footerButtonClass =
	"inline-flex h-(--size-settings-action-height) shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-(--radius-settings-action) border px-3 text-sm leading-5 outline-none transition duration-150 focus-visible:ring-2 focus-visible:ring-accent-weak";

export function ReportProblemDialog({ open, onOpenChange }: ReportProblemDialogProps) {
	const titleId = useId();
	const detailsId = useId();
	const titleRef = useRef<HTMLInputElement>(null);
	const [selectedOutput, setSelectedOutput] = useState<ReportProblemOutput>("github");
	const [summary, setSummary] = useState("");
	const [details, setDetails] = useState("");
	const [copiedOutput, setCopiedOutput] = useState<ReportProblemOutput | null>(null);
	const [copyError, setCopyError] = useState<string | null>(null);
	const [diagnostics, setDiagnostics] = useState<ReportProblemDiagnostics>(DEFAULT_DIAGNOSTICS);

	const copiedLabel = DESTINATIONS.find((option) => option.value === copiedOutput)?.label;

	useEffect(() => {
		if (!open) {
			setSummary("");
			setDetails("");
			setSelectedOutput("github");
			setCopiedOutput(null);
			setCopyError(null);
			return;
		}
		let active = true;
		void collectReportProblemDiagnostics().then((nextDiagnostics) => {
			if (active) setDiagnostics(nextDiagnostics);
		});
		return () => {
			active = false;
		};
	}, [open]);

	const input = { summary, details };
	const draft = formatReportProblemDraft(input, diagnostics, selectedOutput);
	const destination = DESTINATIONS.find((option) => option.value === selectedOutput) ?? DESTINATIONS[0];
	const canCopy = summary.trim().length > 0;

	const clearStatus = () => {
		setCopiedOutput(null);
		setCopyError(null);
	};

	const copyDraft = async () => {
		if (!canCopy) return;
		setCopyError(null);
		const output = selectedOutput;
		try {
			await aoBridge.clipboard.writeText(draft);
			const destinationUrl = reportProblemDestinationUrl(input, diagnostics, output);
			if (destinationUrl) {
				await aoBridge.app.openExternal(destinationUrl);
			}
			setCopiedOutput(output);
			setSummary("");
			setDetails("");
			setSelectedOutput("github");
		} catch (err) {
			setCopyError(err instanceof Error ? err.message : "Could not copy report draft");
			setCopiedOutput(null);
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in" />
				<Dialog.Content
					className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(680px,calc(100svh-32px))] w-[min(var(--size-settings-dialog),calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-(--radius-settings-dialog-lg) border border-[var(--color-border-settings-dialog)] bg-settings-dialog text-settings-label shadow-[var(--shadow-settings-dialog)] data-[state=open]:animate-modal-in"
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						titleRef.current?.focus();
					}}
					onKeyDown={(event) => {
						// Only Cmd/Ctrl+Enter submits — a plain Enter in the textarea
						// must keep inserting newlines.
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							void copyDraft();
						}
					}}
				>
					<Dialog.Close asChild>
						<button
							type="button"
							className="absolute top-3 right-3 z-10 grid size-8 place-items-center rounded-md text-settings-muted transition-colors hover:bg-settings-row hover:text-settings-title focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak"
							aria-label="Close report dialog"
							title="Close (Esc)"
						>
							<X className="size-5" aria-hidden="true" />
						</button>
					</Dialog.Close>

					<div className="flex shrink-0 flex-col gap-1 border-b border-[var(--color-border-settings-dialog-header)] px-6 pt-5 pb-4">
						<Dialog.Title className="text-heading-sm font-semibold leading-6 text-settings-title">
							Report a problem
						</Dialog.Title>
						<Dialog.Description className="text-control leading-4 text-settings-muted">
							Found an issue? Tell us what happened.
						</Dialog.Description>
					</div>

					<div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pt-4 pb-5">
						<div className="flex flex-col gap-1.5">
							<label className={fieldLabelClass} htmlFor={titleId}>
								Title
							</label>
							<input
								ref={titleRef}
								id={titleId}
								className={cn(fieldControlClass, "h-(--size-settings-action-height)")}
								value={summary}
								onChange={(event) => {
									setSummary(event.target.value);
									clearStatus();
								}}
								placeholder="Brief Title"
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<label className={fieldLabelClass} htmlFor={detailsId}>
								What happened?
							</label>
							<textarea
								id={detailsId}
								className={cn(fieldControlClass, "min-h-(--size-textarea-min) resize-y py-2.5")}
								value={details}
								onChange={(event) => {
									setDetails(event.target.value);
									clearStatus();
								}}
								placeholder="Share what happened, what you expected, and how to reproduce it."
							/>
						</div>

						<RadioGroup.Root
							value={selectedOutput}
							onValueChange={(value) => {
								setSelectedOutput(value as ReportProblemOutput);
								clearStatus();
							}}
							aria-label="Report destination"
							className="inline-flex items-center gap-0.5 self-start rounded-(--radius-settings-action) border border-[var(--color-border-settings-input)] bg-[var(--color-bg-settings-input)] p-0.5"
						>
							{DESTINATIONS.map((option) => (
								<RadioGroup.Item
									key={option.value}
									value={option.value}
									className="inline-flex h-8 cursor-default items-center gap-1.5 rounded-lg px-3 text-control leading-none text-settings-muted outline-none transition-colors duration-150 hover:text-settings-title focus-visible:ring-2 focus-visible:ring-accent-weak data-[state=checked]:bg-[var(--color-bg-settings-menu-selected)] data-[state=checked]:text-settings-title"
								>
									<option.icon className="size-icon-sm" aria-hidden="true" />
									{option.label}
								</RadioGroup.Item>
							))}
						</RadioGroup.Root>

						{copyError && (
							<p role="alert" className="text-caption leading-4 text-error">
								{copyError}
							</p>
						)}
						{copiedLabel && !copyError && (
							<p className="text-caption leading-4 text-success">{copiedLabel} draft copied.</p>
						)}
					</div>

					<div className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-[var(--color-border-settings-dialog-header)] px-6 py-3.5">
						<Dialog.Close asChild>
							<button
								type="button"
								className={cn(
									footerButtonClass,
									"border-[var(--color-border-settings-input)] bg-[var(--color-bg-settings-input)] text-settings-label transition-opacity hover:opacity-90",
								)}
							>
								Cancel
							</button>
						</Dialog.Close>
						<button
							type="button"
							className={cn(
								footerButtonClass,
								"border-transparent bg-settings-accent text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50",
							)}
							disabled={!canCopy}
							onClick={() => void copyDraft()}
						>
							{destination.action}
						</button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
