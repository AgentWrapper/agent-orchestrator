import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, GitPullRequest, Mail, MessageSquare, Send, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import {
	collectReportProblemDiagnostics,
	formatReportProblemDraft,
	reportProblemDestinationUrl,
	type ReportProblemDiagnostics,
	type ReportProblemInput,
	type ReportProblemOutput,
} from "../lib/report-problem";
import { aoBridge } from "../lib/bridge";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Input } from "./ui/input";

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
	github: "Raise GitHub issue",
	discord: "Report on Discord",
	email: "Email support",
};

export function ReportProblemDialog({ open, onOpenChange }: ReportProblemDialogProps) {
	const summaryId = useId();
	const detailsId = useId();
	const [previewOutput, setPreviewOutput] = useState<ReportProblemOutput>("github");
	const [summary, setSummary] = useState("");
	const [details, setDetails] = useState("");
	const [copiedOutput, setCopiedOutput] = useState<ReportProblemOutput | null>(null);
	const [copyError, setCopyError] = useState<string | null>(null);
	const [diagnostics, setDiagnostics] = useState<ReportProblemDiagnostics>(DEFAULT_DIAGNOSTICS);

	useEffect(() => {
		if (!open) {
			setSummary("");
			setDetails("");
			setPreviewOutput("github");
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

	const input = useMemo<ReportProblemInput>(
		() => ({
			summary,
			details,
		}),
		[summary, details],
	);

	const preview = useMemo(
		() => formatReportProblemDraft(input, diagnostics, previewOutput),
		[input, diagnostics, previewOutput],
	);

	const copyDraft = async () => {
		setCopyError(null);
		const output = previewOutput;
		try {
			await aoBridge.clipboard.writeText(preview);
			const destinationUrl = reportProblemDestinationUrl(input, diagnostics, output);
			if (destinationUrl) {
				await aoBridge.app.openExternal(destinationUrl);
			}
			setCopiedOutput(output);
			setSummary("");
			setDetails("");
			setPreviewOutput("github");
		} catch (err) {
			setCopyError(err instanceof Error ? err.message : "Could not copy report draft");
			setCopiedOutput(null);
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(680px,calc(100svh-32px))] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
					<div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
						<div className="min-w-0">
							<Dialog.Title className="text-[15px] font-semibold text-foreground">Report a problem</Dialog.Title>
							<Dialog.Description className="mt-1 text-[12px] text-muted-foreground">
								Write a short note, then copy it to GitHub, Discord, or email.
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground"
								aria-label="Close report dialog"
							>
								<X className="size-4" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>

					<div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
						<div className="space-y-1.5">
							<label className="text-[12px] font-medium text-muted-foreground" htmlFor={summaryId}>
								Summary
							</label>
							<Input
								id={summaryId}
								value={summary}
								onChange={(event) => setSummary(event.target.value)}
								placeholder="Brief title"
							/>
						</div>

						<div className="space-y-1.5">
							<label className="text-[12px] font-medium text-muted-foreground" htmlFor={detailsId}>
								Details
							</label>
							<textarea
								id={detailsId}
								className="min-h-[156px] w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none transition placeholder:text-passive focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-weak"
								value={details}
								onChange={(event) => setDetails(event.target.value)}
								placeholder="Share what happened, what you want, or what you need help with."
							/>
						</div>

						<div className="space-y-2">
							<div className="flex items-center justify-between gap-3">
								<label className="text-[12px] font-medium text-muted-foreground" htmlFor="report-preview">
									Preview
								</label>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button type="button" variant="secondary" aria-label="Report destination">
											{OUTPUT_ACTION_LABELS[previewOutput]}
											<ChevronDown className="size-3.5" aria-hidden="true" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-52">
										<DropdownMenuItem onSelect={() => setPreviewOutput("github")}>
											<GitPullRequest aria-hidden="true" />
											Raise GitHub issue
										</DropdownMenuItem>
										<DropdownMenuItem onSelect={() => setPreviewOutput("discord")}>
											<MessageSquare aria-hidden="true" />
											Report on Discord
										</DropdownMenuItem>
										<DropdownMenuItem onSelect={() => setPreviewOutput("email")}>
											<Mail aria-hidden="true" />
											Email support
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
							<pre
								id="report-preview"
								aria-label="Report preview"
								className="max-h-[220px] min-h-[156px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background/70 p-3 text-[12px] leading-relaxed text-muted-foreground"
							>
								{preview}
							</pre>
						</div>

						{copyError && (
							<p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
								{copyError}
							</p>
						)}
						{copiedOutput && !copyError && (
							<p className="text-[12px] text-success">{OUTPUT_LABELS[copiedOutput]} draft copied.</p>
						)}
					</div>

					<div className="flex items-center justify-end border-t border-border px-5 py-4">
						<Button type="button" onClick={() => void copyDraft()}>
							<Send className="size-3.5" aria-hidden="true" />
							{OUTPUT_ACTION_LABELS[previewOutput]}
						</Button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
