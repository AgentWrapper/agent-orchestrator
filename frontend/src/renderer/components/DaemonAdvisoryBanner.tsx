import { AlertTriangle } from "lucide-react";
import type { DaemonStatus } from "../../shared/daemon-status";
import { cn } from "../lib/utils";

// The daemon's own words, shown to the user (#293, cycle-4 1b).
//
// The supervisor already writes everything the user needs into
// `DaemonStatus.message` — including the takeover refusal advisory ("A process
// (pid N) may still be holding the AO daemon port P… Stop pid N yourself"). Until
// now nothing rendered it: the only daemon surface was the sidebar tooltip, which
// prints `daemon ${state}`. So the safety-critical refusal path — fail closed, do
// not signal a process we cannot prove is ours — failed SILENTLY: on Windows, or
// with an unreadable /proc, a genuinely wedged daemon is refused, the run-file is
// removed, the replacement dies on bind, and the user is told "daemon stopped" with
// no PID, no port, and no way forward. Failing closed is defensible; failing closed
// silently is not, and it is the entire justification for refusing to signal.
//
// Rendered in the shell chrome (alongside BuildFreshnessBanner) so it is visible on
// every route, not only where a daemon widget happens to be. `message` is set only
// on abnormal statuses, so presence is the whole display rule.
export function DaemonAdvisoryBanner({ status }: { status: DaemonStatus }) {
	const message = status.message?.trim();
	if (!message) return null;
	const isError = status.state === "error";

	return (
		<div
			role="alert"
			className={cn(
				"flex flex-wrap items-start gap-2.5 border-b px-4.5 py-2.5 text-[13px] text-foreground",
				isError ? "border-error/40 bg-error/10" : "border-warning/40 bg-warning/10",
			)}
		>
			<AlertTriangle
				aria-hidden="true"
				className={cn("mt-0.5 size-4 shrink-0", isError ? "text-error" : "text-warning")}
			/>
			<span>
				<span className="font-medium">AO daemon {status.state}.</span> {message}
			</span>
		</div>
	);
}
