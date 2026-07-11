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
};

export function OperatorAttentionPage() {
	const navigate = useNavigate();
	const attention = useOperatorAttentionQuery();
	const items = attention.data ?? [];
	const showLoadError = attention.isError && items.length === 0;

	const openItem = (item: OperatorAttentionItem) => {
		if (item.kind === "pr" && item.prUrl) {
			window.open(item.prUrl, "_blank", "noopener,noreferrer");
			return;
		}
		if (item.projectId && item.sessionId) {
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId: item.projectId, sessionId: item.sessionId },
			});
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
									<TableHead className="w-24">Kind</TableHead>
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

function itemTitle(item: OperatorAttentionItem) {
	return item.kind === "pr"
		? `${item.prNumber ? `#${item.prNumber} ` : ""}${item.prTitle || "Pull request"}`
		: item.sessionTitle || item.sessionId || "Session";
}

function itemMeta(item: OperatorAttentionItem) {
	return [item.projectId, item.sessionId, item.decisionKind || ""].filter(Boolean).join(" · ");
}

function AttentionCard({ item, onOpen }: { item: OperatorAttentionItem; onOpen: () => void }) {
	return (
		<button
			className="w-full rounded-md border border-border bg-surface p-3 text-left transition-colors hover:border-border-strong"
			onClick={onOpen}
			type="button"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="truncate text-[13px] font-medium text-foreground">{itemTitle(item)}</div>
					<div className="mt-0.5 truncate font-mono text-[10px] text-passive">{itemMeta(item)}</div>
				</div>
				<Badge variant="outline" className={cn("h-5 shrink-0 px-1.5 text-[10px] font-medium", kindTone[item.kind])}>
					{item.kind}
				</Badge>
			</div>
			<p className="mt-2 text-[12px] leading-5 text-muted-foreground">{item.reason}</p>
			<div className="mt-2 flex items-center gap-1 text-[11px] font-medium text-foreground">
				{item.kind === "pr" ? <ExternalLink className="size-3 shrink-0" aria-hidden="true" /> : null}
				<span className="min-w-0 truncate">{item.action}</span>
			</div>
		</button>
	);
}

function AttentionRow({ item, onOpen }: { item: OperatorAttentionItem; onOpen: () => void }) {
	const title = itemTitle(item);
	const meta = itemMeta(item);

	return (
		<TableRow className="cursor-pointer" onClick={onOpen}>
			<TableCell>
				<Badge variant="outline" className={cn("h-5 px-1.5 text-[10px] font-medium", kindTone[item.kind])}>
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
					onClick={onOpen}
					title={item.action}
				>
					{item.kind === "pr" ? <ExternalLink className="size-3" aria-hidden="true" /> : null}
					<span className="truncate">{item.action}</span>
				</Button>
			</TableCell>
		</TableRow>
	);
}
