import type { ComponentType } from "react";
import { Check, CircleAlert, Loader2, TriangleAlert, XCircle } from "lucide-react";
import { useAgentHealthQuery, type AgentHarnessHealth } from "../hooks/useAgentHealthQuery";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

type BadgeVariant = "neutral" | "success" | "warning" | "error";

// The four backend health values, each mapped to a badge tone + icon + label.
// Anything the daemon sends that we don't recognise falls through to "unknown"
// so a future health value degrades gracefully instead of rendering blank.
const HEALTH_META: Record<
	string,
	{ label: string; variant: BadgeVariant; icon: ComponentType<{ className?: string }>; iconClass: string }
> = {
	healthy: { label: "Healthy", variant: "success", icon: Check, iconClass: "text-success" },
	unauthorized: { label: "Not authorized", variant: "warning", icon: TriangleAlert, iconClass: "text-warning" },
	missing: { label: "Not installed", variant: "error", icon: XCircle, iconClass: "text-error" },
	unknown: { label: "Unknown", variant: "neutral", icon: CircleAlert, iconClass: "text-muted-foreground" },
};

function healthMeta(health: string) {
	return HEALTH_META[health] ?? HEALTH_META.unknown;
}

function formatTime(iso?: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

// AgentHealthSection is the Global Settings card for per-harness agent health
// (issue #91). It reads GET /api/v1/agents/health — a periodic snapshot the
// daemon keeps for each configured harness (Claude, Codex, …) — and shows,
// per harness, whether it's ready to spawn and, when not, why and how to fix it
// (almost always a re-login). A 501 means the monitor isn't wired in this build.
export function AgentHealthSection() {
	const query = useAgentHealthQuery();

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-[13px]">Agent health</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<p className="text-[12px] leading-5 text-muted-foreground">
					Whether each configured agent harness is authenticated and ready to spawn sessions. Checked periodically by
					the daemon.
				</p>
				<AgentHealthBody query={query} />
			</CardContent>
		</Card>
	);
}

function AgentHealthBody({ query }: { query: ReturnType<typeof useAgentHealthQuery> }) {
	if (query.isLoading) {
		return (
			<div className="flex items-center gap-2 text-[12px] text-passive">
				<Loader2 className="h-4 w-4 animate-spin" />
				Checking agent health…
			</div>
		);
	}

	if (query.isError) {
		return (
			<p className="text-[12px] leading-5 text-error">
				{query.error instanceof Error ? query.error.message : "Couldn't load agent health."}
			</p>
		);
	}

	const result = query.data;
	if (!result || result.kind === "unavailable") {
		return <p className="text-[12px] leading-5 text-passive">Agent health monitoring isn't available in this build.</p>;
	}

	const { harnesses, checkedAt } = result.data;

	if (harnesses.length === 0) {
		// The monitored set is never empty once the monitor has run (the daemon
		// always includes the core fleet), so an empty snapshot means monitoring
		// is off or hasn't reported yet — not that no harnesses are configured.
		return <p className="text-[12px] leading-5 text-passive">No agent health data yet.</p>;
	}

	return (
		<div className="flex flex-col gap-3">
			<ul className="flex flex-col divide-y divide-border rounded-md border border-border">
				{harnesses.map((harness) => (
					<HarnessRow key={harness.id} harness={harness} />
				))}
			</ul>
			{formatTime(checkedAt) && <p className="text-[11px] text-passive">Last checked {formatTime(checkedAt)}</p>}
		</div>
	);
}

function HarnessRow({ harness }: { harness: AgentHarnessHealth }) {
	const meta = healthMeta(harness.health);
	const Icon = meta.icon;
	const unhealthy = harness.health !== "healthy";

	return (
		<li className="flex flex-col gap-1.5 px-3 py-2.5">
			<div className="flex items-center gap-2">
				<Icon className={`h-4 w-4 shrink-0 ${meta.iconClass}`} aria-hidden />
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{harness.label}</span>
				<Badge variant={meta.variant}>{meta.label}</Badge>
			</div>
			{unhealthy && harness.reason && (
				<p className="pl-6 text-[12px] leading-5 text-muted-foreground">{harness.reason}</p>
			)}
			{unhealthy && harness.remedy && (
				<p className="pl-6 text-[12px] leading-5 text-foreground">
					<span className="text-passive">Fix: </span>
					{harness.remedy}
				</p>
			)}
		</li>
	);
}
