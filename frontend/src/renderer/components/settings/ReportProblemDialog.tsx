import { RadioGroup } from "radix-ui";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
	collectReportProblemDiagnostics,
	formatReportProblemDraft,
	reportProblemDestinationUrl,
	type ReportProblemDiagnostics,
	type ReportProblemOutput,
} from "../../lib/report-problem";
import { aoBridge } from "../../lib/bridge";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

type ReportProblemDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

type DestinationIconProps = {
	className?: string;
};

function GithubIcon({ className }: DestinationIconProps) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.38 7.86 10.9.58.1.79-.25.79-.56v-2.15c-3.2.7-3.88-1.37-3.88-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.56-.29-5.26-1.28-5.26-5.7 0-1.26.45-2.29 1.19-3.1-.12-.3-.52-1.47.11-3.05 0 0 .97-.31 3.18 1.18A10.96 10.96 0 0 1 12 5.99c.98 0 1.97.13 2.9.38 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.27 5.69.41.36.78 1.07.78 2.16v3.2c0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
		</svg>
	);
}

function DiscordIcon({ className }: DestinationIconProps) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M20.32 4.37A19.8 19.8 0 0 0 15.36 2.8a13.7 13.7 0 0 0-.64 1.32 18.4 18.4 0 0 0-5.44 0 13.7 13.7 0 0 0-.64-1.32 19.7 19.7 0 0 0-4.96 1.57C.54 9.04-.32 13.6.1 18.1a19.9 19.9 0 0 0 6.08 3.08c.49-.67.93-1.38 1.3-2.12-.72-.27-1.4-.6-2.05-.98.17-.12.34-.25.5-.38a14.2 14.2 0 0 0 12.14 0c.16.13.33.26.5.38-.65.39-1.34.72-2.06.99.38.74.81 1.45 1.31 2.12a19.9 19.9 0 0 0 6.08-3.08c.5-5.22-.86-9.74-3.58-13.73ZM8.02 15.33c-1.18 0-2.15-1.08-2.15-2.41 0-1.34.95-2.42 2.15-2.42 1.2 0 2.17 1.09 2.15 2.42 0 1.33-.96 2.41-2.15 2.41Zm7.96 0c-1.18 0-2.15-1.08-2.15-2.41 0-1.34.95-2.42 2.15-2.42 1.2 0 2.17 1.09 2.15 2.42 0 1.33-.95 2.41-2.15 2.41Z" />
		</svg>
	);
}

function EmailIcon({ className }: DestinationIconProps) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2Zm0 4-8 5L4 8V6l8 5 8-5v2Z" />
		</svg>
	);
}

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
	icon: (props: DestinationIconProps) => ReactNode;
}[] = [
	{ value: "github", label: "GitHub", action: "Copy & Create GitHub Issue", icon: GithubIcon },
	{ value: "discord", label: "Discord", action: "Copy & Open Discord", icon: DiscordIcon },
	{ value: "email", label: "Email", action: "Copy & Open Email", icon: EmailIcon },
];

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
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				showCloseButton={false}
				className="z-overlay flex max-h-[min(680px,calc(100svh-32px))] w-[min(var(--size-settings-dialog),calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden rounded-(--radius-settings-dialog-lg) border border-[var(--color-border-settings-dialog)] bg-settings-dialog p-0 text-settings-label shadow-[var(--shadow-settings-dialog)]"
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
				<DialogClose asChild>
					<button
						type="button"
						className="settings-dialog-close-button settings-close-button"
						aria-label="Close report dialog"
						title="Close (Esc)"
					>
						<X className="size-5" aria-hidden="true" />
					</button>
				</DialogClose>

				<div className="flex shrink-0 flex-col gap-1 border-b border-(--color-border-settings-dialog-header) px-6 pt-5 pb-4">
					<DialogTitle className="settings-dialog-title">Report a problem</DialogTitle>
					<DialogDescription className="text-control leading-4 text-settings-muted">
						Found an issue? Tell us what happened.
					</DialogDescription>
				</div>

				<div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pt-4 pb-5">
					<div className="flex flex-col gap-1.5">
						<label className="settings-field-label" htmlFor={titleId}>
							Title
						</label>
						<input
							ref={titleRef}
							id={titleId}
							className="settings-field-control h-(--size-settings-action-height)"
							value={summary}
							onChange={(event) => {
								setSummary(event.target.value);
								clearStatus();
							}}
							placeholder="Brief Title"
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<label className="settings-field-label" htmlFor={detailsId}>
							What happened?
						</label>
						<textarea
							id={detailsId}
							className="settings-field-control min-h-(--size-textarea-min) resize-y py-2.5"
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
					<DialogClose asChild>
						<button
							type="button"
							className="settings-footer-button border-[var(--color-border-settings-input)] bg-[var(--color-bg-settings-input)] text-settings-label transition-opacity hover:opacity-90"
						>
							Cancel
						</button>
					</DialogClose>
					<button
						type="button"
						className="settings-footer-button border-transparent bg-settings-accent text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
						disabled={!canCopy}
						onClick={() => void copyDraft()}
					>
						{destination.action}
					</button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
