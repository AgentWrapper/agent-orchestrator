"use client";

import { LayoutGroup, motion } from "motion/react";
import { GitBranch, Github } from "lucide-react";
import { useEffect, useState } from "react";
import {
	featurePreviewTokens,
	previewStatus,
} from "../FeaturePreviewShell";

const columns = [
	{ id: "working", label: "Working", color: "#60a5fa" },
	{ id: "action", label: "Needs you", color: "#fb923c" },
	{ id: "review", label: "In review", color: "#facc15" },
	{ id: "merge", label: "Ready to merge", color: "#4ade80" },
] as const;

const cards = [
	{
		id: "icons",
		title: "Remove stale generated icon imports",
		branch: "cleanup/stale-icon-imports",
		icon: "/app-icons/opencode.svg",
		column: 0,
	},
	{
		id: "mobile",
		title: "Repair mobile overflow on landing preview",
		branch: "landing/mobile-preview-overflow",
		icon: "/app-icons/coverage-codex.svg",
		column: 2,
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
			className="mx-auto h-[318px] w-full min-w-0 max-w-[570px] overflow-hidden rounded-xl border border-[var(--preview-border)] bg-[var(--preview-background)] font-sans text-[var(--preview-foreground)] shadow-[0_24px_64px_-20px_rgba(0,0,0,0.8)]"
			style={featurePreviewTokens}
		>
			<LayoutGroup>
				<div className="grid h-full min-h-0 auto-cols-[85%] grid-flow-col snap-x snap-mandatory overflow-x-auto overscroll-x-contain scrollbar-hide sm:auto-cols-[48%] md:grid-flow-row md:grid-cols-4 md:auto-cols-auto md:snap-none md:overflow-hidden">
					{columns.map((column, columnIndex) => {
						const columnCards = cards.filter(
							(card) => card.column === columnIndex,
						);
						const count =
							columnCards.length + (movingColumn === columnIndex ? 1 : 0);

						return (
							<section
								key={column.id}
								className="flex min-h-0 min-w-0 snap-start flex-col border-r border-[var(--preview-border)] last:border-r-0"
							>
								<button
									type="button"
									onClick={() => setMovingColumn(columnIndex)}
									className="flex items-center gap-1.5 border-b border-[var(--preview-border)] px-2.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--preview-ring)]"
								>
									<span
										className="size-2 shrink-0 rounded-[2px]"
										style={{ backgroundColor: column.color }}
									/>
									<span className="min-w-0 flex-1 truncate text-[10px] font-semibold tracking-[-0.5px] text-[var(--preview-muted-foreground)]">
										{column.label}
									</span>
									<span className="text-[10px] tabular-nums text-[var(--preview-muted-foreground)]">
										{count}
									</span>
								</button>

								<div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2 scrollbar-hide">
									{movingColumn === columnIndex ? (
										<BoardCard
											id="moving"
											title="Tune titlebar action spacing"
											branch="landing/titlebar-actions"
											icon="/app-icons/coverage-claude-code.svg"
											column={columnIndex}
										/>
									) : null}
									{columnCards.map((card) => (
										<BoardCard
											key={card.id}
											{...card}
											column={columnIndex}
										/>
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
	title,
}: {
	branch: string;
	column: number;
	icon: string;
	id: string;
	title: string;
}) {
	const state =
		column === 0
			? { label: "Editing files", color: "#9ca3af" }
			: column === 1
				? { label: "Paused for decision", color: previewStatus.warning }
				: column === 2
					? { label: "Reviewer assigned", color: "#93c5fd" }
					: { label: "Approved", color: previewStatus.success };

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
			className="w-full cursor-pointer rounded-[8px] border border-[var(--preview-border)] bg-[var(--preview-card)] p-2.5 text-left shadow-[0_1px_1px_rgba(0,0,0,0.05)] outline-none transition-colors hover:bg-[var(--preview-muted)] focus-visible:ring-2 focus-visible:ring-[var(--preview-ring)]"
		>
			<div className="flex items-start gap-2">
				<img
					src={icon}
					alt=""
					className="mt-0.5 size-3.5 shrink-0"
					draggable="false"
				/>
				<div className="min-w-0 text-[10px] font-medium leading-[14px] text-[var(--preview-card-foreground)]">
					{title}
				</div>
			</div>
			<div className="mt-2 flex items-center gap-1.5 border-t border-[var(--preview-border)] pt-2 font-mono text-[9px] text-[var(--preview-muted-foreground)]">
				<GitBranch className="size-2.5 shrink-0" />
				<span className="truncate">{branch}</span>
			</div>
			<div
				className="mt-2 flex items-center gap-1.5 truncate text-[9px]"
				style={{ color: state.color }}
			>
				{column === 0 ? (
					<span className="size-2.5 animate-spin rounded-full border border-[#4b5563] border-t-[#d1d5db]" />
				) : column === 2 ? (
					<Github className="size-2.5" />
				) : (
					<span
						className="size-2 rounded-full"
						style={{ backgroundColor: state.color }}
					/>
				)}
				{state.label}
			</div>
		</motion.button>
	);
}
