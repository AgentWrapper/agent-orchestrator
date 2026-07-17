import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, GitPullRequest, Mail, MessageSquare, Send, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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

const OUTPUT_KEYS = {
	github: {
		labelKey: "reportProblem.outputs.github.label",
		actionKey: "reportProblem.outputs.github.action",
		destinationKey: "reportProblem.outputs.github.destination",
	},
	discord: {
		labelKey: "reportProblem.outputs.discord.label",
		actionKey: "reportProblem.outputs.discord.action",
		destinationKey: "reportProblem.outputs.discord.destination",
	},
	email: {
		labelKey: "reportProblem.outputs.email.label",
		actionKey: "reportProblem.outputs.email.action",
		destinationKey: "reportProblem.outputs.email.destination",
	},
} as const satisfies Record<ReportProblemOutput, Record<"labelKey" | "actionKey" | "destinationKey", string>>;

export function ReportProblemDialog({ open, onOpenChange }: ReportProblemDialogProps) {
	const { t } = useTranslation();
	const summaryId = useId();
	const detailsId = useId();
	const [selectedOutput, setSelectedOutput] = useState<ReportProblemOutput>("github");
	const [summary, setSummary] = useState("");
	const [details, setDetails] = useState("");
	const [copiedOutput, setCopiedOutput] = useState<ReportProblemOutput | null>(null);
	const [copyError, setCopyError] = useState<{ kind: "copy" | "open"; detail?: string } | null>(null);
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
		} catch (err) {
			setCopyError({ kind: "copy", detail: err instanceof Error ? err.message || undefined : undefined });
			setCopiedOutput(null);
			return;
		}
		const destinationUrl = reportProblemDestinationUrl(input, diagnostics, output);
		try {
			if (destinationUrl) await aoBridge.app.openExternal(destinationUrl);
		} catch (err) {
			setCopyError({ kind: "open", detail: err instanceof Error ? err.message || undefined : undefined });
			setCopiedOutput(null);
			return;
		}
		setCopiedOutput(output);
		setSummary("");
		setDetails("");
		setSelectedOutput("github");
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
							<Dialog.Title className="text-[15px] font-semibold text-foreground">
								{t("reportProblem.title")}
							</Dialog.Title>
							<Dialog.Description className="mt-1 text-[12px] text-muted-foreground">
								{t("reportProblem.description")}
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground"
								aria-label={t("reportProblem.close")}
							>
								<X className="size-4" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>

					<div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
						<div className="space-y-1.5">
							<label className="text-[12px] font-medium text-muted-foreground" htmlFor={summaryId}>
								{t("reportProblem.summary.label")}
							</label>
							<Input
								id={summaryId}
								value={summary}
								onChange={(event) => setSummary(event.target.value)}
								placeholder={t("reportProblem.summary.placeholder")}
							/>
						</div>

						<div className="space-y-1.5">
							<label className="text-[12px] font-medium text-muted-foreground" htmlFor={detailsId}>
								{t("reportProblem.details.label")}
							</label>
							<textarea
								id={detailsId}
								className="min-h-[156px] w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none transition placeholder:text-passive focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-weak"
								value={details}
								onChange={(event) => setDetails(event.target.value)}
								placeholder={t("reportProblem.details.placeholder")}
							/>
						</div>

						<div className="space-y-1.5">
							<p className="text-[12px] font-medium text-muted-foreground">{t("reportProblem.reportTo")}</p>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										type="button"
										variant="secondary"
										className="w-full justify-between"
										aria-label={t("reportProblem.destinationAria")}
									>
										<span className="inline-flex min-w-0 items-center gap-2">
											{selectedOutput === "github" && <GitPullRequest className="size-3.5" aria-hidden="true" />}
											{selectedOutput === "discord" && <MessageSquare className="size-3.5" aria-hidden="true" />}
											{selectedOutput === "email" && <Mail className="size-3.5" aria-hidden="true" />}
											<span className="truncate">{t(OUTPUT_KEYS[selectedOutput].destinationKey)}</span>
										</span>
										<ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
									<DropdownMenuItem onSelect={() => selectOutput("github")}>
										<GitPullRequest aria-hidden="true" />
										{t(OUTPUT_KEYS.github.destinationKey)}
									</DropdownMenuItem>
									<DropdownMenuItem onSelect={() => selectOutput("discord")}>
										<MessageSquare aria-hidden="true" />
										{t(OUTPUT_KEYS.discord.destinationKey)}
									</DropdownMenuItem>
									<DropdownMenuItem onSelect={() => selectOutput("email")}>
										<Mail aria-hidden="true" />
										{t(OUTPUT_KEYS.email.destinationKey)}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>

						{copyError && (
							<p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
								{copyError.detail ??
									t(copyError.kind === "copy" ? "reportProblem.copyFailed" : "reportProblem.openFailed")}
							</p>
						)}
						{copiedOutput && !copyError && (
							<p className="text-[12px] text-success">
								{t("reportProblem.copied", { destination: t(OUTPUT_KEYS[copiedOutput].labelKey) })}
							</p>
						)}
					</div>

					<div className="border-t border-border px-5 py-4">
						<Button type="button" className="w-full" onClick={() => void copyDraft()}>
							<Send className="size-3.5" aria-hidden="true" />
							{t(OUTPUT_KEYS[selectedOutput].actionKey)}
						</Button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
