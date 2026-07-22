import { AlertTriangle } from "lucide-react";
import type { DaemonStatus } from "../../shared/daemon-status";
import { daemonFailureHint, daemonFailureMessage } from "../lib/daemon-failure";

export function DaemonFailureBanner({ status }: { status: DaemonStatus }) {
	if (status.state !== "error") return null;

	return (
		<section
			aria-live="assertive"
			className="flex shrink-0 items-start gap-3 border-b border-error/30 bg-error/10 px-4.5 py-2.5 text-xs"
			role="alert"
		>
			<AlertTriangle className="mt-0.5 size-icon-base shrink-0 text-error" aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="font-medium text-foreground">AO daemon failed to start</p>
				<p className="mt-0.5 break-words text-muted-foreground">{daemonFailureMessage(status)}</p>
				<p className="mt-1 text-muted-foreground">{daemonFailureHint(status)}</p>
			</div>
			{status.code ? (
				<code className="shrink-0 rounded bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
					{status.code}
				</code>
			) : null}
		</section>
	);
}
