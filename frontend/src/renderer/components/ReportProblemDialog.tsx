import * as Dialog from "@radix-ui/react-dialog";
import { Clipboard, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import {
	collectReportProblemDiagnostics,
	formatReportProblemDraft,
	reportProblemDestinationUrl,
	type ReportProblemDiagnostics,
	type ReportProblemInput,
	type ReportProblemOutput,
	type ReportProblemType,
} from "../lib/report-problem";
import { aoBridge } from "../lib/bridge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { cn } from "../lib/utils";

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

export function ReportProblemDialog({ open, onOpenChange }: ReportProblemDialogProps) {
	const typeId = useId();
	const summaryId = useId();
	const detailsId = useId();
	const expectedId = useId();
	const diagnosticsId = useId();
	const [type, setType] = useState<ReportProblemType>("bug");
	const [summary, setSummary] = useState("");
	const [details, setDetails] = useState("");
	const [expected, setExpected] = useState("");
	const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
	const [previewOutput, setPreviewOutput] = useState<ReportProblemOutput>("github");
	const [copiedOutput, setCopiedOutput] = useState<ReportProblemOutput | null>(null);
	const [copyError, setCopyError] = useState<string | null>(null);
	const [diagnostics, setDiagnostics] = useState<ReportProblemDiagnostics>(DEFAULT_DIAGNOSTICS);

	useEffect(() => {
		if (!open) {
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
			type,
			summary,
			details,
			expected,
			includeDiagnostics,
		}),
		[type, summary, details, expected, includeDiagnostics],
	);

	const preview = useMemo(
		() => formatReportProblemDraft(input, diagnostics, previewOutput),
		[input, diagnostics, previewOutput],
	);

	const copyDraft = async (output: ReportProblemOutput) => {
		setCopyError(null);
		setPreviewOutput(output);
		try {
			await aoBridge.clipboard.writeText(formatReportProblemDraft(input, diagnostics, output));
			window.open(reportProblemDestinationUrl(input, diagnostics, output), "_blank", "noopener,noreferrer");
			setCopiedOutput(output);
		} catch (err) {
			setCopyError(err instanceof Error ? err.message : "Could not copy report draft");
			setCopiedOutput(null);
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(820px,calc(100svh-32px))] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
					<div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
						<div className="min-w-0">
							<Dialog.Title className="text-[15px] font-semibold text-foreground">Report a problem</Dialog.Title>
							<Dialog.Description className="mt-1 text-[12px] text-muted-foreground">
								Review a local draft before copying it anywhere.
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

					<div className="grid min-h-0 gap-4 overflow-y-auto px-5 py-4 md:grid-cols-[minmax(0,1fr)_minmax(260px,0.9fr)]">
						<div className="space-y-4">
							<div className="space-y-1.5">
								<label className="text-[12px] font-medium text-muted-foreground" htmlFor={typeId}>
									Report type
								</label>
								<Select value={type} onValueChange={(value) => setType(value as ReportProblemType)}>
									<SelectTrigger id={typeId} className="w-full" aria-label="Report type">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="bug">Bug report</SelectItem>
										<SelectItem value="feature">Feature request</SelectItem>
										<SelectItem value="feedback">General feedback</SelectItem>
										<SelectItem value="question">Setup question</SelectItem>
									</SelectContent>
								</Select>
							</div>

							<div className="space-y-1.5">
								<label className="text-[12px] font-medium text-muted-foreground" htmlFor={summaryId}>
									Summary
								</label>
								<Input
									id={summaryId}
									value={summary}
									onChange={(event) => setSummary(event.target.value)}
									placeholder="One sentence summary"
								/>
							</div>

							<div className="space-y-1.5">
								<label className="text-[12px] font-medium text-muted-foreground" htmlFor={detailsId}>
									Details / repro
								</label>
								<textarea
									id={detailsId}
									className="min-h-[112px] w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none transition placeholder:text-passive focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-weak"
									value={details}
									onChange={(event) => setDetails(event.target.value)}
									placeholder="Steps, context, or the rough idea"
								/>
							</div>

							<div className="space-y-1.5">
								<label className="text-[12px] font-medium text-muted-foreground" htmlFor={expectedId}>
									Expected / request
								</label>
								<textarea
									id={expectedId}
									className="min-h-[84px] w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none transition placeholder:text-passive focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-weak"
									value={expected}
									onChange={(event) => setExpected(event.target.value)}
									placeholder="What should happen or what you want"
								/>
							</div>

							<label
								className="flex items-start gap-2 rounded-md border border-border bg-background/40 px-3 py-2 text-[12px] text-muted-foreground"
								htmlFor={diagnosticsId}
							>
								<input
									id={diagnosticsId}
									type="checkbox"
									checked={includeDiagnostics}
									onChange={(event) => setIncludeDiagnostics(event.target.checked)}
									className="mt-0.5 size-3.5 accent-primary"
								/>
								<span>
									<span className="block font-medium text-foreground">Include safe diagnostics</span>
									<span>Version, daemon status, route surface, build mode, and platform only.</span>
								</span>
							</label>
						</div>

						<div className="flex min-h-0 flex-col gap-3">
							<div className="flex flex-wrap items-center gap-1" aria-label="Preview format">
								{(["github", "discord", "email"] as ReportProblemOutput[]).map((output) => (
									<button
										key={output}
										type="button"
										onClick={() => setPreviewOutput(output)}
										className={cn(
											"rounded-md px-2.5 py-1.5 text-[12px] transition-colors",
											previewOutput === output
												? "bg-primary text-primary-foreground"
												: "bg-raised text-muted-foreground hover:text-foreground",
										)}
									>
										{OUTPUT_LABELS[output]}
									</button>
								))}
							</div>
							<pre
								aria-label="Report preview"
								className="min-h-[260px] flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background/70 p-3 text-[12px] leading-relaxed text-muted-foreground"
							>
								{preview}
							</pre>
							{copyError && (
								<p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
									{copyError}
								</p>
							)}
							{copiedOutput && !copyError && (
								<p className="text-[12px] text-success">{OUTPUT_LABELS[copiedOutput]} draft copied.</p>
							)}
						</div>
					</div>

					<div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
						<Button type="button" variant="secondary" onClick={() => void copyDraft("github")}>
							<Clipboard className="size-3.5" aria-hidden="true" />
							Copy and open GitHub
						</Button>
						<Button type="button" variant="secondary" onClick={() => void copyDraft("discord")}>
							<Clipboard className="size-3.5" aria-hidden="true" />
							Copy and open Discord
						</Button>
						<Button type="button" onClick={() => void copyDraft("email")}>
							<Clipboard className="size-3.5" aria-hidden="true" />
							Copy and open email
						</Button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
