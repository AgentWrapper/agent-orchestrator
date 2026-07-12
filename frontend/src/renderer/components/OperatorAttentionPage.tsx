import { useNavigate } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { DashboardSubhead } from "./DashboardSubhead";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { useOperatorAttentionQuery, type OperatorAttentionItem } from "../hooks/useOperatorAttentionQuery";
import { cn } from "../lib/utils";

const kindTone: Record<string, string> = {
	decision: "border-warning/40 bg-warning/10 text-warning",
	pr: "border-success/40 bg-success/10 text-success",
	worker_retry_exhausted: "border-destructive/40 bg-destructive/10 text-destructive",
	main_ci_red: "border-destructive/40 bg-destructive/10 text-destructive",
	duplicate_pr: "border-warning/40 bg-warning/10 text-warning",
	orchestrator_replacement_capped: "border-destructive/40 bg-destructive/10 text-destructive",
	orchestrator_dead: "border-destructive/40 bg-destructive/10 text-destructive",
	prime_dead: "border-destructive/40 bg-destructive/10 text-destructive",
};

const kindBadgeClassName =
	"h-auto min-h-5 w-auto min-w-0 max-w-full whitespace-normal break-words px-1.5 py-0.5 text-[10px] font-medium leading-3";

export function OperatorAttentionPage() {
	const navigate = useNavigate();
	const attention = useOperatorAttentionQuery();
	const items = attention.data ?? [];
	const showLoadError = attention.isError && items.length === 0;

	const openItem = (item: OperatorAttentionItem) => {
		if (isSafeExternalURL(item.prUrl)) {
			window.open(item.prUrl, "_blank", "noopener,noreferrer");
			return;
		}
		if (item.projectId && item.sessionId) {
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId: item.projectId, sessionId: item.sessionId },
			});
			return;
		}
		if (isSafeExternalURL(item.deepLink)) {
			window.open(item.deepLink, "_blank", "noopener,noreferrer");
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<DashboardSubhead
				title="Waiting on you"
				subtitle="Verify final gates and answer structured decisions from one place."
				count={items.length}
			/>

			<div className="min-h-0 flex-1 overflow-y-auto p-[18px]">
				{showLoadError ? (
					<p className="py-10 text-center text-[12px] text-passive">Could not load waiting items.</p>
				) : items.length === 0 ? (
					<p className="py-10 text-center text-[12px] text-passive">Nothing is waiting on you.</p>
				) : (
					<>
						<div className="space-y-2 md:hidden">
							{items.map((item) => (
								<AttentionCard key={item.id} item={item} onOpen={() => openItem(item)} />
							))}
						</div>
						<Table className="hidden md:table">
							<TableHeader>
								<TableRow>
									<TableHead className="w-56">Kind</TableHead>
									<TableHead>Item</TableHead>
									<TableHead>Reason</TableHead>
									<TableHead className="w-48 text-right">Action</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{items.map((item) => (
									<AttentionRow key={item.id} item={item} onOpen={() => openItem(item)} />
								))}
							</TableBody>
						</Table>
					</>
				)}
			</div>
		</div>
	);
}

function hasOpenTarget(item: OperatorAttentionItem) {
	return Boolean(
		isSafeExternalURL(item.prUrl) || (item.projectId && item.sessionId) || isSafeExternalURL(item.deepLink),
	);
}

function isSafeExternalURL(value?: string) {
	return typeof value === "string" && value.startsWith("https://");
}

function itemTitle(item: OperatorAttentionItem) {
	return item.kind === "pr"
		? `${item.prNumber ? `#${item.prNumber} ` : ""}${item.prTitle || "Pull request"}`
		: item.sessionTitle || item.sessionId || "Session";
}

function itemMeta(item: OperatorAttentionItem) {
	return [item.projectId, item.sessionId, item.decisionKind || ""].filter(Boolean).join(" · ");
}

function AttentionCard({ item, onOpen }: { item: OperatorAttentionItem; onOpen: () => void }) {
	const canOpen = hasOpenTarget(item);
	return (
		<button
			className={cn(
				"w-full rounded-md border border-border bg-surface p-3 text-left transition-colors",
				canOpen ? "hover:border-border-strong" : "cursor-default",
			)}
			disabled={!canOpen}
			onClick={onOpen}
			type="button"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="truncate text-[13px] font-medium text-foreground">{itemTitle(item)}</div>
					<div className="mt-0.5 truncate font-mono text-[10px] text-passive">{itemMeta(item)}</div>
				</div>
				<Badge variant="outline" className={cn(kindBadgeClassName, "shrink-0", kindTone[item.kind])}>
					{item.kind}
				</Badge>
			</div>
			<p className="mt-2 text-[12px] leading-5 text-muted-foreground">{item.reason}</p>
			<div className="mt-2 flex items-center gap-1 text-[11px] font-medium text-foreground">
				{item.prUrl ? <ExternalLink className="size-3 shrink-0" aria-hidden="true" /> : null}
				<span className="min-w-0 truncate">{item.action}</span>
			</div>
		</button>
	);
}

function AttentionRow({ item, onOpen }: { item: OperatorAttentionItem; onOpen: () => void }) {
	const title = itemTitle(item);
	const meta = itemMeta(item);
	const canOpen = hasOpenTarget(item);

	return (
		<TableRow className={cn(canOpen && "cursor-pointer")} onClick={canOpen ? onOpen : undefined}>
			<TableCell>
				<Badge variant="outline" className={cn(kindBadgeClassName, kindTone[item.kind])}>
					{item.kind}
				</Badge>
			</TableCell>
			<TableCell className="max-w-0">
				<div className="truncate text-[13px] text-foreground">{title}</div>
				<div className="truncate font-mono text-[10px] text-passive">{meta}</div>
				{item.question ? <div className="mt-1 truncate text-[11px] text-muted-foreground">{item.question}</div> : null}
			</TableCell>
			<TableCell className="max-w-[360px] text-[12px] text-muted-foreground">{item.reason}</TableCell>
			<TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
				<Button
					size="sm"
					variant="ghost"
					className="h-6 max-w-[180px] justify-end px-2 text-[11px]"
					disabled={!canOpen}
					onClick={onOpen}
					title={item.action}
				>
					{item.prUrl ? <ExternalLink className="size-3" aria-hidden="true" /> : null}
					<span className="truncate">{item.action}</span>
				</Button>
			</TableCell>
		</TableRow>
	);
}
