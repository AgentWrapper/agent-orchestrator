import type { ReactNode } from "react";
import { Activity, AlertTriangle, Check, CircleAlert, Gauge, Loader2, ServerCrash } from "lucide-react";
import { DashboardSubhead } from "./DashboardSubhead";
import { Badge } from "./ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import {
	useWorkerCapacityQuery,
	type WorkerCapacity,
	type WorkerCapacityBucket,
	type WorkerCapacityHarness,
} from "../hooks/useWorkerCapacityQuery";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { cn } from "../lib/utils";

type BadgeVariant = "neutral" | "success" | "warning" | "error";

const HEALTH_META: Record<string, { label: string; variant: BadgeVariant; iconClass: string }> = {
	healthy: { label: "Healthy", variant: "success", iconClass: "text-success" },
	unauthorized: { label: "Not authorized", variant: "warning", iconClass: "text-warning" },
	missing: { label: "Not installed", variant: "error", iconClass: "text-error" },
	unknown: { label: "Unknown", variant: "neutral", iconClass: "text-muted-foreground" },
};

function healthMeta(health: string) {
	return HEALTH_META[health] ?? HEALTH_META.unknown;
}

function stateMeta(state: WorkerCapacity["state"]) {
	switch (state) {
		case "healthy":
			return { label: "All healthy", variant: "success" as const, icon: Check, iconClass: "text-success" };
		case "degraded":
			return { label: "Degraded", variant: "warning" as const, icon: AlertTriangle, iconClass: "text-warning" };
		case "uncapped":
			return { label: "Uncapped", variant: "neutral" as const, icon: Gauge, iconClass: "text-muted-foreground" };
		default:
			return {
				label: "Unconfigured",
				variant: "neutral" as const,
				icon: CircleAlert,
				iconClass: "text-muted-foreground",
			};
	}
}

function formatNumber(value?: number | null): string {
	if (value === null || value === undefined) return "—";
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatCapacity(value?: number | null): string {
	if (value === null || value === undefined) return "Uncapped";
	return formatNumber(value);
}

function bucketName(bucket: WorkerCapacityBucket): string {
	return bucket.model ? `${bucket.agent} · ${bucket.model}` : bucket.agent;
}

function formatTime(iso?: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function WorkerCapacityPage({ projectId }: { projectId: string }) {
	const query = useWorkerCapacityQuery(projectId);
	const workspaceQuery = useWorkspaceQuery();
	const workspace = workspaceQuery.data?.find((item) => item.id === projectId);
	const subtitle = workspace?.path ?? projectId;

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<DashboardSubhead title="Capacity" subtitle={subtitle} />
			<div className="min-h-0 flex-1 overflow-y-auto p-[18px]">
				{query.isLoading ? (
					<CenteredStatus icon={<Loader2 className="size-4 animate-spin" aria-hidden="true" />}>
						Loading capacity…
					</CenteredStatus>
				) : query.isError ? (
					<CenteredStatus icon={<ServerCrash className="size-4 text-error" aria-hidden="true" />}>
						{query.error instanceof Error ? query.error.message : "Could not load capacity."}
					</CenteredStatus>
				) : !query.data || query.data.kind === "unavailable" ? (
					<CenteredStatus icon={<CircleAlert className="size-4 text-muted-foreground" aria-hidden="true" />}>
						Capacity is unavailable.
					</CenteredStatus>
				) : (
					<CapacityBody capacity={query.data.data} />
				)}
			</div>
		</div>
	);
}

function CapacityBody({ capacity }: { capacity: WorkerCapacity }) {
	const meta = stateMeta(capacity.state);
	const Icon = meta.icon;
	return (
		<div className="mx-auto flex max-w-6xl flex-col gap-4">
			<div className="grid gap-2 md:grid-cols-4">
				<SummaryTile label="Cap" value={formatCapacity(capacity.cap)} icon={<Gauge className="size-4" aria-hidden />} />
				<SummaryTile
					label="Active"
					value={formatNumber(capacity.activeWorkers)}
					icon={<Activity className="size-4" aria-hidden />}
				/>
				<SummaryTile label="Available" value={formatCapacity(capacity.availableCapacity)} tone={capacity.state} />
				<SummaryTile label="Free" value={formatCapacity(capacity.freeAvailableCapacity)} tone={capacity.state} />
			</div>

			<section className="rounded-md border border-border bg-surface">
				<div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
					<Icon className={cn("size-4", meta.iconClass)} aria-hidden />
					<h2 className="text-[13px] font-semibold text-foreground">Allocation</h2>
					<Badge className="ml-auto" variant={meta.variant}>
						{meta.label}
					</Badge>
				</div>
				<BucketTable buckets={capacity.buckets} />
			</section>

			<section className="rounded-md border border-border bg-surface">
				<div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
					<CircleAlert className="size-4 text-muted-foreground" aria-hidden />
					<h2 className="text-[13px] font-semibold text-foreground">Agent Health</h2>
					{formatTime(capacity.checkedAt) ? (
						<span className="ml-auto text-[11px] text-passive">Checked {formatTime(capacity.checkedAt)}</span>
					) : null}
				</div>
				<HarnessList harnesses={capacity.harnesses} />
			</section>
		</div>
	);
}

function SummaryTile({
	label,
	value,
	icon,
	tone,
}: {
	label: string;
	value: string;
	icon?: ReactNode;
	tone?: WorkerCapacity["state"];
}) {
	return (
		<div className="flex min-h-[74px] items-center gap-3 rounded-md border border-border bg-surface px-3">
			<div
				className={cn(
					"grid size-9 shrink-0 place-items-center rounded-md border border-border text-muted-foreground",
					tone === "healthy" && "border-success/30 text-success",
					tone === "degraded" && "border-warning/30 text-warning",
				)}
			>
				{icon ?? <Gauge className="size-4" aria-hidden />}
			</div>
			<div className="min-w-0">
				<div className="text-[11px] font-medium uppercase text-passive">{label}</div>
				<div className="truncate text-[24px] font-semibold leading-7 text-foreground">{value}</div>
			</div>
		</div>
	);
}

function BucketTable({ buckets }: { buckets: WorkerCapacityBucket[] }) {
	if (buckets.length === 0) {
		return <p className="px-3 py-8 text-center text-[12px] text-passive">No worker mix configured.</p>;
	}
	return (
		<Table className="text-[12px]">
			<TableHeader>
				<TableRow className="hover:bg-transparent">
					<TableHead className="w-[30%] px-3">Bucket</TableHead>
					<TableHead>Target</TableHead>
					<TableHead>Realized</TableHead>
					<TableHead>Workers</TableHead>
					<TableHead>Health</TableHead>
					<TableHead className="text-right">Down share</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{buckets.map((bucket) => {
					const meta = healthMeta(bucket.health);
					return (
						<TableRow key={`${bucket.agent}:${bucket.model ?? ""}`}>
							<TableCell className="max-w-0 px-3">
								<div className="truncate font-medium text-foreground">{bucketName(bucket)}</div>
							</TableCell>
							<TableCell>{bucket.targetPercent}%</TableCell>
							<TableCell>{bucket.realizedPercent.toFixed(1)}%</TableCell>
							<TableCell>{bucket.activeWorkers}</TableCell>
							<TableCell>
								<Badge variant={meta.variant}>{meta.label}</Badge>
							</TableCell>
							<TableCell className="text-right font-mono text-[11px] text-muted-foreground">
								{formatNumber(bucket.downCapacityShare)}
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}

function HarnessList({ harnesses }: { harnesses: WorkerCapacityHarness[] }) {
	if (harnesses.length === 0) {
		return <p className="px-3 py-8 text-center text-[12px] text-passive">No health data yet.</p>;
	}
	return (
		<ul className="divide-y divide-border">
			{harnesses.map((harness) => {
				const meta = healthMeta(harness.health);
				return (
					<li key={harness.id} className="grid gap-1 px-3 py-2.5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
						<div className="min-w-0">
							<div className="flex min-w-0 items-center gap-2">
								<span className="truncate text-[13px] font-medium text-foreground">{harness.label || harness.id}</span>
								<span className="truncate font-mono text-[11px] text-passive">{harness.id}</span>
							</div>
							{harness.reason ? (
								<p className="mt-1 text-[12px] leading-5 text-muted-foreground">{harness.reason}</p>
							) : null}
							{harness.remedy ? <p className="text-[12px] leading-5 text-foreground">{harness.remedy}</p> : null}
						</div>
						<Badge variant={meta.variant}>{meta.label}</Badge>
					</li>
				);
			})}
		</ul>
	);
}

function CenteredStatus({ icon, children }: { icon: ReactNode; children: ReactNode }) {
	return (
		<div className="grid h-full min-h-[260px] place-items-center">
			<div className="flex items-center gap-2 text-[12px] text-passive">
				{icon}
				{children}
			</div>
		</div>
	);
}
