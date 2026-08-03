"use client";

import { LayoutGroup, motion } from "motion/react";
import { GitBranch } from "lucide-react";
import Image from "next/image";
import { useEffect, useState } from "react";
import { featurePreviewTokens } from "../FeaturePreviewShell";

const STATUS = {
	idle: "oklch(0.705 0.015 286.067)", // --muted-foreground
	working: "#60a5fa", // --color-status-working
	needsYou: "#fb923c", // --color-status-needs-you
	inReview: "#facc15", // --color-status-in-review
	ready: "#4ade80", // --color-status-ready
	merged: "oklch(0.92 0.004 286.32)", // --primary
	unknown: "oklch(0.37 0.013 285.805)", // --chart-4
} as const;

const columns = [
	{ id: "working", label: "Idle / Working", color: STATUS.working, split: true },
	{ id: "action", label: "Needs you", color: STATUS.needsYou, split: false },
	{ id: "review", label: "In review", color: STATUS.inReview, split: false },
	{ id: "merge", label: "Ready to merge / Merged", color: STATUS.ready, split: true },
] as const;

const cards = [
	{
		id: "icons",
		title: "Remove stale generated icon imports",
		branch: "ao/dev/agent-orchestrator-14/root",
		icon: "/app-icons/opencode.svg",
		column: 0,
		status: "Idle",
		statusColor: STATUS.idle,
	},
	{
		id: "mobile",
		title: "Repair mobile overflow on landing preview",
		branch: "ao/dev/agent-orchestrator-18/root",
		icon: "/app-icons/coverage-codex.svg",
		column: 2,
		status: "Review pending",
		statusColor: STATUS.inReview,
	},
] as const;

export function FleetBoardDemo() {
	const [movingColumn, setMovingColumn] = useState(0);

	useEffect(() => {
		const interval = window.setInterval(
			() => setMovingColumn((current) => (current + 1) % columns.length),
			2400,
		);
		return () => window.clearInterval(interval);
	}, []);

	return (
		<div
			className="mx-auto h-[318px] w-full min-w-0 max-w-[570px] overflow-hidden rounded-[20px] border border-[var(--preview-border)] bg-[var(--preview-background)] font-sans text-[var(--preview-foreground)] shadow-[0_24px_64px_-20px_rgba(0,0,0,0.8)]"
			style={featurePreviewTokens}
		>
			<LayoutGroup>
				<div className="grid h-full min-h-0 auto-cols-[85%] grid-flow-col snap-x snap-mandatory divide-x divide-[var(--preview-border-strong)] overflow-x-auto overscroll-x-contain scrollbar-hide sm:auto-cols-[48%] md:grid-flow-row md:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.35fr)] md:auto-cols-auto md:snap-none md:overflow-hidden">
					{columns.map((column, columnIndex) => {
						const columnCards = cards.filter((card) => card.column === columnIndex);
						const count = columnCards.length + (movingColumn === columnIndex ? 1 : 0);

						return (
							<section key={column.id} className="flex min-h-0 min-w-0 snap-start flex-col">
								<button
									type="button"
									onClick={() => setMovingColumn(columnIndex)}
									className="flex h-8 items-center gap-1 border-b border-[var(--preview-border)] px-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--preview-ring)]"
								>
									{column.split ? (
										<div className="min-w-0 flex-1 overflow-hidden text-[7px] font-semibold uppercase leading-none tracking-normal">
											<span className="whitespace-nowrap">
												{column.id === "working" ? (
													<>
														<span style={{ color: STATUS.idle }}>Idle</span>
														<span className="text-[var(--preview-muted-foreground)]"> / </span>
														<span style={{ color: STATUS.working }}>Working</span>
													</>
												) : (
													<>
														<span style={{ color: STATUS.ready }}>Ready to merge</span>
														<span className="text-[var(--preview-muted-foreground)]"> / </span>
														<span style={{ color: STATUS.merged }}>Merged</span>
													</>
												)}
											</span>
										</div>
									) : (
										<span
											className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[7px] font-semibold uppercase leading-none tracking-normal"
											style={{ color: column.color }}
										>
											{column.label}
										</span>
									)}
									<span className="shrink-0 font-mono text-[7px] tabular-nums leading-none text-[var(--preview-muted-foreground)]">
										{column.split && column.id === "working"
											? `${movingColumn === columnIndex ? 0 : columnCards.filter((c) => c.status === "Idle").length} / ${movingColumn === columnIndex ? 1 : columnCards.filter((c) => c.status !== "Idle").length}`
											: column.split
												? `${count} / 0`
												: count}
									</span>
								</button>

								<div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-2 scrollbar-hide">
									{movingColumn === columnIndex ? (
										<BoardCard
											id="moving"
											title="Tune titlebar action spacing"
											branch="ao/dev/agent-orchestrator-12/root"
											icon="/app-icons/coverage-claude-code.svg"
											column={columnIndex}
										/>
									) : null}
									{columnCards.map((card) => (
										<BoardCard key={card.id} {...card} column={columnIndex} />
									))}
								</div>
							</section>
						);
					})}
				</div>
			</LayoutGroup>
		</div>
	);
}

function BoardCard({
	branch,
	column,
	icon,
	id,
	status,
	statusColor,
	title,
}: {
	branch: string;
	column: number;
	icon: string;
	id: string;
	status?: string;
	statusColor?: string;
	title: string;
}) {
	const state =
		column === 0
			? { label: status ?? "Working", color: statusColor ?? STATUS.working }
			: column === 1
				? { label: "Input needed", color: STATUS.needsYou }
				: column === 2
					? { label: status ?? "Review pending", color: statusColor ?? STATUS.inReview }
					: { label: "Ready", color: STATUS.ready };

	return (
		<motion.button
			layout
			layoutId={id === "moving" ? "feature-board-moving-card" : undefined}
			type="button"
			initial={{ opacity: 0, y: -5 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{
				duration: 0.35,
				ease: [0.22, 1, 0.36, 1],
				layout: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
			}}
			className="w-full cursor-pointer rounded-lg border border-[var(--preview-border)] bg-[var(--preview-card)] text-left outline-none transition-[border-color] hover:border-[var(--preview-border-strong)] focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)]"
		>
			<div className="flex items-start gap-2 px-2.5 pb-2 pt-2.5">
				<Image
					src={icon}
					alt=""
					width={14}
					height={14}
					className="mt-0.5 size-3.5 shrink-0 rounded-[3px]"
					draggable={false}
				/>
				<div className="min-w-0 flex-1">
					<div className="line-clamp-2 text-[10px] font-semibold leading-[14px] text-[var(--preview-card-foreground)]">
						{title}
					</div>
					<div className="mt-1.5 flex items-center gap-1 font-mono text-[9px] text-[var(--preview-muted-foreground)]">
						<GitBranch className="size-2.5 shrink-0" />
						<span className="truncate">{branch}</span>
					</div>
				</div>
			</div>
			<div aria-hidden="true" className="mx-2.5 h-px bg-[var(--preview-border)]" />
			<div className="flex items-center gap-1.5 truncate px-2.5 py-1.5 text-[9px] font-medium" style={{ color: state.color }}>
				<span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: state.color }} />
				{state.label}
			</div>
		</motion.button>
	);
}
