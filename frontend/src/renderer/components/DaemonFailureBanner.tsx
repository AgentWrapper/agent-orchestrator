import { AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DaemonStatus } from "../../shared/daemon-status";
import { daemonFailureHint, daemonFailureMessage, daemonFailureTitle } from "../lib/daemon-failure";
import { aoBridge } from "../lib/bridge";

export function DaemonFailureBanner({ status }: { status: DaemonStatus }) {
	if (!status.code || status.state === "ready") return null;
	return <DaemonFailureContent status={status} />;
}

function DaemonFailureContent({ status }: { status: DaemonStatus }) {
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const copiedTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
	const details = status.details?.trim();
	const hint = daemonFailureHint(status);
	const title = daemonFailureTitle(status);
	useEffect(() => {
		setCopied(false);
		return () => {
			if (copiedTimeout.current !== null) clearTimeout(copiedTimeout.current);
		};
	}, [details]);
	const copyDetails = async () => {
		const lines = [
			title,
			`Code: ${status.code ?? "unknown"}`,
			`Message: ${daemonFailureMessage(status)}`,
			details ? `\nDetails:\n${details}` : "",
		];
		await aoBridge.clipboard.writeText(lines.filter(Boolean).join("\n"));
		setCopied(true);
		if (copiedTimeout.current !== null) clearTimeout(copiedTimeout.current);
		copiedTimeout.current = setTimeout(() => {
			setCopied(false);
			copiedTimeout.current = null;
		}, 2_000);
	};
	return (
		<section
			aria-live="assertive"
			className="flex shrink-0 items-start gap-3 border-b border-error/30 bg-error/10 px-4.5 py-2.5 text-xs"
			role="alert"
		>
			<AlertTriangle className="mt-0.5 size-icon-base shrink-0 text-error" aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="font-medium text-foreground">{title}</p>
				<p className="mt-0.5 break-words text-muted-foreground">{daemonFailureMessage(status)}</p>
				{hint ? <p className="mt-1 text-muted-foreground">{hint}</p> : null}
				{details ? (
					<div className="mt-2">
						<div className="flex items-center gap-3">
							<button
								type="button"
								className="text-xs text-foreground underline-offset-2 hover:underline"
								onClick={() => setDetailsOpen((open) => !open)}
							>
								{detailsOpen ? "Hide details" : "Show details"}
							</button>
							<button
								type="button"
								className="text-xs text-foreground underline-offset-2 hover:underline"
								onClick={() => void copyDetails()}
							>
								{copied ? "Copied" : "Copy details"}
							</button>
						</div>
						{detailsOpen ? (
							<pre className="mt-2 max-h-40 overflow-auto rounded border border-border bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
								{details}
							</pre>
						) : null}
					</div>
				) : null}
			</div>
			{status.code ? (
				<code className="shrink-0 rounded bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
					{status.code}
				</code>
			) : null}
		</section>
	);
}
