import * as Dialog from "@radix-ui/react-dialog";
import { GitPullRequest, Mail, MessageSquare, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
	collectReportProblemDiagnostics,
	formatReportProblemDraft,
	reportProblemDestinationUrl,
	type ReportProblemDiagnostics,
	type ReportProblemOutput,
} from "../../lib/report-problem";
import { aoBridge } from "../../lib/bridge";
import { cn } from "../../lib/utils";
import { SettingsOptionMenu } from "./SettingsOptionMenu";

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

const OUTPUT_LABELS: Record<ReportProblemOutput, string> = {
	github: "GitHub",
	discord: "Discord",
	email: "Email",
};

const OUTPUT_ACTION_LABELS: Record<ReportProblemOutput, string> = {
	github: "Copy and raise GitHub Issue",
	discord: "Copy and Open Discord",
	email: "Copy and Open Email",
};

const REPORT_DESTINATION_OPTIONS = [
	{
		value: "github" as const,
		label: "GitHub",
		icon: <GitPullRequest className="size-icon-lg" aria-hidden="true" />,
	},
	{
		value: "discord" as const,
		label: "Discord",
		icon: <MessageSquare className="size-icon-lg" aria-hidden="true" />,
	},
	{
		value: "email" as const,
		label: "Email",
		icon: <Mail className="size-icon-lg" aria-hidden="true" />,
	},
];

const fieldLabelClass = "text-sm leading-5 text-[var(--color-text-settings-input-label)]";
const fieldControlClass =
	"w-full rounded-(--radius-settings-input) border border-[var(--color-border-settings-input)] bg-[var(--color-bg-settings-input)] px-3 py-2 text-sm leading-5 text-[var(--color-text-settings-input)] shadow-[var(--shadow-settings-field)] outline-none transition placeholder:text-[var(--color-text-settings-placeholder)] focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-weak";

const reportActionBarClass =
	"inline-flex h-(--size-settings-action-height) items-center rounded-(--radius-settings-action) px-4 text-sm leading-5 shadow-[var(--shadow-settings-field)] outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0";

const reportDestinationTriggerClass = cn(
	reportActionBarClass,
	"w-full max-w-(--size-settings-report-select) justify-between border border-[var(--color-border-settings-input)] bg-[var(--color-bg-settings-select)] text-[var(--color-text-settings-input)] hover:text-[var(--color-text-settings-input)] data-[state=open]:outline-none data-[state=open]:ring-0",
);

const reportSubmitButtonClass = cn(
	reportActionBarClass,
	"shrink-0 justify-center border border-transparent bg-settings-accent font-normal text-white transition-opacity hover:opacity-90",
);

export function ReportProblemDialog({ open, onOpenChange }: ReportProblemDialogProps) {
	const titleId = useId();
	const briefId = useId();
	const [selectedOutput, setSelectedOutput] = useState<ReportProblemOutput>("github");
	const [summary, setSummary] = useState("");
	const [details, setDetails] = useState("");
	const [copiedOutput, setCopiedOutput] = useState<ReportProblemOutput | null>(null);
	const [copyError, setCopyError] = useState<string | null>(null);
	const [diagnostics, setDiagnostics] = useState<ReportProblemDiagnostics>(DEFAULT_DIAGNOSTICS);

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

	const clearStatus = () => {
		setCopiedOutput(null);
		setCopyError(null);
	};

	const copyDraft = async () => {
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

	const selectOutput = (output: ReportProblemOutput) => {
		setSelectedOutput(output);
		clearStatus();
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(680px,calc(100svh-32px))] w-[min(var(--size-settings-dialog),calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-(--radius-settings-dialog-lg) border border-[var(--color-border-settings-dialog)] bg-settings-dialog text-settings-label shadow-[var(--shadow-settings-dialog-ring)] data-[state=open]:animate-modal-in">
					<div className="relative flex shrink-0 items-start justify-between gap-4 border-b border-[var(--color-border-settings-dialog-header)] px-6 py-6">
						<div className="flex min-w-0 flex-col gap-1">
							<Dialog.Title className="text-xl font-bold leading-7 text-settings-title">Report a problem</Dialog.Title>
							<Dialog.Description className="text-sm leading-5 text-settings-muted">
								What problems did you encounter during the use?
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="grid size-8 shrink-0 place-items-center rounded-md text-settings-muted transition hover:bg-settings-row hover:text-settings-title"
								aria-label="Close report dialog"
							>
								<X className="size-5" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>

					<div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 pt-4 pb-6">
						<div className="flex flex-col gap-2">
							<label className={fieldLabelClass} htmlFor={titleId}>
								Title
							</label>
							<input
								id={titleId}
								className={fieldControlClass}
								value={summary}
								onChange={(event) => {
									setSummary(event.target.value);
									clearStatus();
								}}
								placeholder="Brief title"
							/>
						</div>

						<div className="flex flex-col gap-2">
							<label className={fieldLabelClass} htmlFor={briefId}>
								Brief
							</label>
							<textarea
								id={briefId}
								className={`${fieldControlClass} min-h-(--size-textarea-min) resize-y`}
								value={details}
								onChange={(event) => {
									setDetails(event.target.value);
									clearStatus();
								}}
								placeholder="Share what happened, what you expected, and how to reproduce it."
							/>
						</div>

						{copyError && (
							<p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
								{copyError}
							</p>
						)}
						{copiedOutput && !copyError && (
							<p className="text-xs text-success">{OUTPUT_LABELS[copiedOutput]} draft copied.</p>
						)}

						<div className="flex flex-col gap-2 pt-1">
							<p className={fieldLabelClass}>Report to</p>
							<div className="flex items-center gap-6">
								<SettingsOptionMenu
									aria-label="Report destination"
									value={selectedOutput}
									options={REPORT_DESTINATION_OPTIONS}
									onChange={selectOutput}
									triggerClassName={reportDestinationTriggerClass}
								/>
								<button type="button" className={reportSubmitButtonClass} onClick={() => void copyDraft()}>
									{OUTPUT_ACTION_LABELS[selectedOutput]}
								</button>
							</div>
						</div>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
