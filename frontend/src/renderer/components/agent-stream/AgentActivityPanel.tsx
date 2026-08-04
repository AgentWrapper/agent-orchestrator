/**
 * Live plan + permission surface for an active agent stream.
 * AO design tokens (hairline borders, muted text, accent for allow actions).
 */

import { useEffect, useRef, useState } from "react";
import { Check, Circle, LoaderCircle, ShieldAlert, XCircle } from "lucide-react";
import { isAgentStreamActive } from "../../lib/agent-stream";
import type { AgentPermissionOption, AgentSessionStreamState } from "../../types/agentStreamTypes";
import { cn } from "../../lib/utils";

interface Props {
	stream?: AgentSessionStreamState;
	onPermissionResponse: (requestId: string, optionId: string) => Promise<void>;
}

function PlanStatusIcon({ status }: { status: string }) {
	if (status === "completed") {
		return <Check className="size-3.5 text-status-ready" aria-hidden="true" />;
	}
	if (status === "in_progress") {
		return <LoaderCircle className="size-3.5 animate-spin text-status-working" aria-hidden="true" />;
	}
	if (status === "blocked") {
		return <XCircle className="size-3.5 text-destructive" aria-hidden="true" />;
	}
	return <Circle className="size-3 text-muted-foreground" aria-hidden="true" />;
}

function optionClass(option: AgentPermissionOption): string {
	if (option.kind.startsWith("reject")) {
		return "border-border bg-transparent text-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive";
	}
	return "border-accent/30 bg-accent/10 text-foreground hover:border-accent/50 hover:bg-accent/15";
}

export function AgentActivityPanel({ stream, onPermissionResponse }: Props) {
	const [submittingOptionId, setSubmittingOptionId] = useState<string | null>(null);
	const [responseError, setResponseError] = useState("");
	const firstOptionRef = useRef<HTMLButtonElement | null>(null);
	const permission = stream?.permission;

	useEffect(() => {
		setSubmittingOptionId(null);
		setResponseError("");
		if (!permission) return;
		requestAnimationFrame(() => firstOptionRef.current?.focus({ preventScroll: true }));
	}, [permission?.requestId]);

	const respond = async (option: AgentPermissionOption) => {
		if (!permission || submittingOptionId) return;
		setSubmittingOptionId(option.optionId);
		setResponseError("");
		try {
			await onPermissionResponse(permission.requestId, option.optionId);
		} catch (err) {
			setResponseError(err instanceof Error ? err.message : String(err));
			setSubmittingOptionId(null);
		}
	};

	const planEntries = stream?.plan?.entries ?? [];
	const planAllDone = planEntries.length > 0 && planEntries.every((entry) => entry.status === "completed");
	const showStatus = Boolean(stream?.statusMessage) && isAgentStreamActive(stream);
	const showPlan = planEntries.length > 0 && isAgentStreamActive(stream) && !planAllDone;
	if (!permission && !showStatus && !showPlan) return null;

	return (
		<div className="space-y-2" data-testid="agent-activity-panel">
			{(showStatus || showPlan) && (
				<section
					className="rounded-lg border border-border bg-muted/30 px-3 py-2.5"
					aria-label="Agent progress"
				>
					{showStatus ? (
						<div className="flex items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
							{stream?.phase === "running" ? (
								<LoaderCircle className="size-3.5 animate-spin text-status-working" aria-hidden="true" />
							) : null}
							<span>{stream?.statusMessage}</span>
						</div>
					) : null}
					{showPlan ? (
						<div className={showStatus ? "mt-2 border-t border-border pt-2" : undefined}>
							{stream?.plan?.title ? (
								<p className="mb-1.5 text-xs font-medium text-foreground">{stream.plan.title}</p>
							) : null}
							<ol className="space-y-1">
								{stream?.plan?.entries.map((entry) => (
									<li key={entry.id} className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
										<span className="flex size-4 shrink-0 items-center justify-center">
											<PlanStatusIcon status={entry.status} />
										</span>
										<span className={entry.status === "completed" ? "text-passive line-through" : undefined}>
											{entry.title}
										</span>
									</li>
								))}
							</ol>
						</div>
					) : null}
				</section>
			)}

			{permission ? (
				<section
					className="rounded-lg border border-status-needs-you/30 bg-status-needs-you/5 px-4 py-3"
					role="alertdialog"
					aria-labelledby={`permission-title-${permission.requestId}`}
					aria-describedby={
						permission.description ? `permission-description-${permission.requestId}` : undefined
					}
				>
					<div className="flex items-start gap-3">
						<ShieldAlert className="mt-0.5 size-4 shrink-0 text-status-needs-you" aria-hidden="true" />
						<div className="min-w-0 flex-1">
							<h3
								id={`permission-title-${permission.requestId}`}
								className="text-sm font-medium text-foreground"
							>
								{permission.title}
							</h3>
							{permission.description ? (
								<p
									id={`permission-description-${permission.requestId}`}
									className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground"
								>
									{permission.description}
								</p>
							) : null}
							<div className="mt-3 flex flex-wrap gap-2">
								{permission.options.map((option, index) => (
									<button
										key={option.optionId}
										ref={index === 0 ? firstOptionRef : undefined}
										type="button"
										disabled={submittingOptionId !== null}
										onClick={() => void respond(option)}
										className={cn(
											"min-h-9 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-wait disabled:opacity-50",
											optionClass(option),
										)}
									>
										{submittingOptionId === option.optionId ? (
											<LoaderCircle className="mr-1.5 inline size-3 animate-spin" aria-hidden="true" />
										) : null}
										{option.label}
									</button>
								))}
							</div>
							{responseError ? (
								<p className="mt-2 text-xs text-destructive" role="alert">
									{responseError}
								</p>
							) : null}
						</div>
					</div>
				</section>
			) : null}
		</div>
	);
}
