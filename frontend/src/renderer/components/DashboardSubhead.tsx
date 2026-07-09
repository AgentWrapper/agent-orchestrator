import type { ReactNode } from "react";

// The board subhead (mc-board .dashboard-main__subhead): a 21px bold title with
// a muted one-line subtitle, optionally a trailing count.
export function DashboardSubhead({
	title,
	subtitle,
	count,
	actions,
}: {
	title: string;
	subtitle: string;
	count?: number;
	actions?: ReactNode;
}) {
	return (
		// Wraps on narrow viewports so the action cluster drops below the title
		// instead of overflowing; the one-line subtitle is desktop-only (md+).
		<div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 pt-4 md:px-[18px] md:pt-[22px]">
			<div className="flex min-w-0 items-baseline gap-3">
				<h1 className="text-[21px] font-bold tracking-[-0.025em] text-foreground">{title}</h1>
				{typeof count === "number" && <span className="font-mono text-[13px] text-passive">{count}</span>}
				<span className="hidden text-[12.5px] text-passive md:inline">{subtitle}</span>
			</div>
			{actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
		</div>
	);
}
