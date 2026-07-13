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
	github: "Copy and raise GitHub issue",
	discord: "Copy and open Discord",
	email: "Copy and open email",
};

const OUTPUT_DESTINATION_LABELS: Record<ReportProblemOutput, string> = {
	github: "GitHub issue",
	discord: "Discord",
	email: "Email support",
};

export function ReportProblemDialog({ open, onOpenChange }: ReportProblemDialogProps) {
	const summaryId = useId();
	const detailsId = useId();
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

	const input = useMemo<ReportProblemInput>(
		() => ({
			summary,
			details,
		}),
		[summary, details],
	);

	const draft = useMemo(
		() => formatReportProblemDraft(input, diagnostics, selectedOutput),
		[input, diagnostics, selectedOutput],
	);

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
		setCopiedOutput(null);
		setCopyError(null);
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

						<div className="space-y-1.5">
							<p className="text-[12px] font-medium text-muted-foreground">Report to</p>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										type="button"
										variant="secondary"
										className="w-full justify-between"
										aria-label="Report destination"
									>
										<span className="inline-flex min-w-0 items-center gap-2">
											{selectedOutput === "github" && <GitPullRequest className="size-3.5" aria-hidden="true" />}
											{selectedOutput === "discord" && <MessageSquare className="size-3.5" aria-hidden="true" />}
											{selectedOutput === "email" && <Mail className="size-3.5" aria-hidden="true" />}
											<span className="truncate">{OUTPUT_DESTINATION_LABELS[selectedOutput]}</span>
										</span>
										<ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
									<DropdownMenuItem onSelect={() => selectOutput("github")}>
										<GitPullRequest aria-hidden="true" />
										GitHub issue
									</DropdownMenuItem>
									<DropdownMenuItem onSelect={() => selectOutput("discord")}>
										<MessageSquare aria-hidden="true" />
										Discord
									</DropdownMenuItem>
									<DropdownMenuItem onSelect={() => selectOutput("email")}>
										<Mail aria-hidden="true" />
										Email support
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
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

					<div className="border-t border-border px-5 py-4">
						<Button type="button" className="w-full" onClick={() => void copyDraft()}>
							<Send className="size-3.5" aria-hidden="true" />
							{OUTPUT_ACTION_LABELS[selectedOutput]}
						</Button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
