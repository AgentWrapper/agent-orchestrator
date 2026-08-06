"use client";

import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { ChevronDown, X } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { featurePreviewTokens } from "../FeaturePreviewShell";
import { usePreviewScale } from "../usePreviewScale";
import { cursorPositionForRects, PROJECT_AGENT_SCENES, TASK_TEXT_FULL, TYPING_INTERVAL_MS, sceneClockKey, type ProjectAgentsScene } from "./ProjectAgentsDemo.scenes";
import { PROJECT_AGENT_MENU_OPTIONS, type ProjectAgentMenuOption } from "./ProjectAgentsDemo.visual";

const T = {
	bg: "var(--preview-background)",
	card: "var(--preview-card)",
	fg: "var(--preview-foreground)",
	mut: "var(--preview-muted-foreground)",
	faint: "var(--preview-passive)",
	line: "var(--preview-border)",
	input: "var(--preview-input)",
	hover: "var(--preview-sidebar-hover)",
	selected: "var(--preview-sidebar-accent)",
	warning: "#fb923c",
} as const;

const AGENTS = PROJECT_AGENT_MENU_OPTIONS;
const PREVIEW_WIDTH = 570;
const PREVIEW_HEIGHT = 380;

function agentById(id: string): ProjectAgentMenuOption {
	return AGENTS.find((a) => a.id === id) ?? AGENTS[0]!;
}

function AgentIcon({ src, size = 14 }: { src: string; size?: number }) {
	return (
		<Image
			src={src}
			alt=""
			width={size}
			height={size}
			className="shrink-0 object-contain"
			style={{ width: size, height: size }}
			draggable={false}
		/>
	);
}

const PHASE_TRANSITION = {
	initial: { opacity: 0, scale: 0.96 },
	animate: { opacity: 1, scale: 1 },
	exit: { opacity: 0, scale: 0.96 },
	transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] },
} as const;

/* ------------------------------------------------------------------ */
/* Cursor                                                              */
/* ------------------------------------------------------------------ */
function DemoCursor({ x, y, pressed, clickId }: { x: number; y: number; pressed: boolean; clickId: number }) {
	return (
		<motion.div
			className="pointer-events-none absolute z-40"
			initial={false}
			animate={{ left: `${x}%`, top: `${y}%` }}
			transition={{ type: "spring", stiffness: 240, damping: 30, mass: 0.8 }}
			style={{ width: 0, height: 0 }}
		>
			<motion.div animate={{ scale: pressed ? 0.86 : 1 }} transition={{ duration: 0.16 }}>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					className="-translate-x-[4px] -translate-y-[2px] drop-shadow-[0_1px_2px_rgba(0,0,0,0.7)]"
					aria-hidden="true"
				>
					<path
						d="M5 3 L5 21 L10.2 16.8 L13.4 23 L15.9 22 L12.7 15.8 L19.5 15.8 Z"
						fill="#ffffff"
						stroke="#000000"
						strokeWidth="1.4"
						strokeLinejoin="round"
					/>
				</svg>
			</motion.div>
			<AnimatePresence>
				{clickId > 0 ? (
					<motion.span
						key={clickId}
						initial={{ opacity: 0.9, scale: 0.25 }}
						animate={{ opacity: 0, scale: 1.55 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.7, ease: "easeOut" }}
						className="absolute -left-[13px] -top-[13px] size-6 rounded-full"
						style={{ border: `1px solid ${T.fg}` }}
					/>
				) : null}
			</AnimatePresence>
		</motion.div>
	);
}

/* ------------------------------------------------------------------ */
/* Agent dropdown menu — scrollable, fits inside modal                 */
/* ------------------------------------------------------------------ */
function AgentMenu({ currentValue, hoverId }: { currentValue: string; hoverId: string | null | undefined }) {
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!hoverId || !scrollRef.current) return;
		const el = scrollRef.current.querySelector<HTMLElement>(`[data-agent-id="${hoverId}"]`);
		if (!el) return;
		const container = scrollRef.current;
		const elBottom = el.offsetTop + el.offsetHeight + 4;
		const elTop = el.offsetTop - 4;
		if (elBottom > container.scrollTop + container.clientHeight) {
			container.scrollTo({ top: elBottom - container.clientHeight, behavior: "smooth" });
		} else if (elTop < container.scrollTop) {
			container.scrollTo({ top: elTop, behavior: "smooth" });
		}
	}, [hoverId]);

	return (
		<motion.div
			data-cursor-target="agent-menu"
			initial={{ opacity: 0, y: -4, scale: 0.98 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			exit={{ opacity: 0, y: -3, scale: 0.98 }}
			transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
			className="absolute left-0 z-30 flex flex-col overflow-hidden rounded-lg border"
			style={{
				bottom: "calc(100% + 4px)",
				minWidth: 220,
				width: "max-content",
				maxWidth: 280,
				maxHeight: 120,
				background: T.card,
				borderColor: T.line,
				boxShadow: "0 12px 30px rgba(0,0,0,0.42)",
			}}
		>
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-1 scrollbar-hide">
				{AGENTS.map((agent) => {
					const selected = agent.id === currentValue;
					const hovered = agent.id === hoverId;
					const statusColor = agent.statusTone === "warning" ? T.warning : T.faint;
					return (
						<div
							key={agent.id}
							data-agent-id={agent.id}
							data-cursor-target={agent.id === hoverId ? "agent-selected" : undefined}
							className="flex w-full items-center rounded-md text-[10.5px] leading-4 outline-none"
							style={{
								background: hovered ? T.hover : selected ? T.selected : "transparent",
								opacity: agent.disabled ? 0.42 : 1,
								padding: "5px 8px",
							}}
						>
							<span className="flex min-w-0 w-full items-center gap-2.5">
								<AgentIcon src={agent.icon} />
								<span className="min-w-0 flex-1 truncate" style={{ color: selected || hovered ? T.fg : T.mut }}>{agent.label}</span>
								<span className="flex shrink-0 justify-end pl-2" style={{ width: 52 }}>
									{agent.status ? <span className="text-[9px]" style={{ color: statusColor }}>{agent.status}</span> : null}
								</span>
							</span>
						</div>
					);
				})}
			</div>
		</motion.div>
	);
}

/* ------------------------------------------------------------------ */
/* New Task Modal — faithful to NewTaskDialog + TaskComposer           */
/* ------------------------------------------------------------------ */
function NewTaskModal({ scene }: { scene: ProjectAgentsScene }) {
	const [charCount, setCharCount] = useState(scene.typing ? 0 : (scene.typedChars ?? 0));
	const targetChars = scene.typedChars ?? 0;

	useEffect(() => {
		if (!scene.typing) {
			setCharCount(targetChars);
			return;
		}
		setCharCount(0);
		let i = 0;
		const id = window.setInterval(() => {
			i++;
			if (i >= TASK_TEXT_FULL.length) {
				setCharCount(TASK_TEXT_FULL.length);
				window.clearInterval(id);
				return;
			}
			setCharCount(i);
		}, TYPING_INTERVAL_MS);
		return () => window.clearInterval(id);
	}, [scene.id, scene.typing, targetChars]);

	const taskText = TASK_TEXT_FULL.slice(0, charCount);
	const selectedAgent = scene.selectedAgent ?? "claude-code";
	const agent = agentById(selectedAgent);
	const showCaret = charCount < TASK_TEXT_FULL.length && scene.phase === "modal";

	return (
		<motion.div
			className="absolute inset-0 z-20 flex items-center justify-center"
			{...PHASE_TRANSITION}
		>
			<motion.div
				data-cursor-target="modal"
				className="relative w-[min(420px,calc(100%-32px))] rounded-[12px]"
				style={{
					background: T.card,
					border: `1px solid ${T.line}`,
					boxShadow: "0 0 0 1px rgba(255,255,255,0.04), 0 18px 52px rgba(0,0,0,0.48)",
				}}
			>
				{/* Header */}
				<div className="flex items-start justify-between gap-4 border-b px-5 py-4" style={{ borderColor: T.line }}>
					<div className="min-w-0">
						<div className="text-[13px] font-semibold" style={{ color: T.fg }}>New task</div>
						<div className="mt-0.5 text-[10px]" style={{ color: T.mut }}>Delegate a task to an agent in this project.</div>
					</div>
					<span className="grid size-6 shrink-0 place-items-center rounded-md" style={{ color: T.mut }}>
						<X className="size-3.5" aria-hidden="true" />
					</span>
				</div>

				{/* Form body */}
				<div className="flex flex-col gap-3.5 px-5 py-4">
					{/* Task textarea */}
					<div className="flex flex-col gap-1.5">
						<span className="text-[10px] font-medium" style={{ color: T.mut }}>Task</span>
						<div
							data-cursor-target="task-textarea"
							className="min-h-[60px] rounded-md border px-2.5 py-2 text-[11px] leading-relaxed transition-shadow"
							style={{
								background: "transparent",
								borderColor: scene.target === "task-textarea" ? "var(--preview-ring)" : T.line,
								boxShadow: scene.target === "task-textarea" ? "0 0 0 3px color-mix(in oklch, var(--preview-ring) 30%, transparent)" : "none",
								color: T.fg,
							}}
						>
							{taskText}
							{showCaret ? <span className="inline-block h-3 w-px animate-pulse" style={{ background: T.fg, marginLeft: 1 }} /> : null}
						</div>
						<span className="text-[9px]" style={{ color: T.mut }}>Press Enter to submit, Shift + Enter for newline</span>
					</div>

					{/* Agent + Model row */}
					<div className="grid grid-cols-2 gap-3">
						{/* Agent field */}
						<div className="relative flex flex-col gap-1.5">
							<span className="text-[10px] font-medium" style={{ color: T.mut }}>Agent</span>
							<div
								data-cursor-target="agent-trigger"
								className="flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-[11px]"
								style={{
									height: 32,
									background: T.input,
									borderColor: scene.agentMenuOpen ? "var(--preview-ring)" : T.line,
									boxShadow: scene.agentMenuOpen ? "0 0 0 2px color-mix(in oklch, var(--preview-ring) 30%, transparent)" : "none",
								}}
							>
								<AgentIcon src={agent.icon} />
								<span className="min-w-0 flex-1 truncate text-left font-medium" style={{ color: T.fg }}>{agent.label}</span>
								<ChevronDown className="size-[11px] shrink-0 opacity-50" style={{ color: T.mut }} aria-hidden="true" />
							</div>
							<AnimatePresence>
								{scene.agentMenuOpen ? (
									<AgentMenu key="agent-menu" currentValue={selectedAgent} hoverId={scene.agentMenuHover} />
								) : null}
							</AnimatePresence>
						</div>
						{/* Model field */}
						<div className="flex flex-col gap-1.5">
							<span className="text-[10px] font-medium" style={{ color: T.mut }}>Model</span>
							<div
								data-cursor-target="model-trigger"
								className="flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-[11px]"
								style={{ height: 32, background: T.input, borderColor: T.line }}
							>
								<span className="min-w-0 flex-1 truncate text-left" style={{ color: T.mut }}>Project default</span>
								<ChevronDown className="size-[11px] shrink-0 opacity-50" style={{ color: T.mut }} aria-hidden="true" />
							</div>
						</div>
					</div>

					{/* Footer */}
					<div className="mt-2 flex items-center justify-end gap-2">
						<span
							className="inline-flex h-[28px] items-center rounded-md px-3 text-[11px]"
							style={{ background: "transparent", color: T.fg, opacity: scene.busy ? 0.5 : 1 }}
						>
							Cancel
						</span>
						<motion.span
							data-cursor-target="start-button"
							layout
							className="inline-flex h-[28px] items-center justify-center gap-1.5 overflow-hidden rounded-md text-[11px] font-medium"
							animate={{ paddingLeft: scene.busy ? 14 : 12, paddingRight: scene.busy ? 14 : 12, opacity: scene.busy ? 0.65 : 1 }}
							transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
							style={{ background: T.fg, color: T.bg }}
						>
							<AnimatePresence mode="wait" initial={false}>
								{scene.busy ? (
									<motion.span
										key="starting"
										initial={{ opacity: 0, filter: "blur(4px)" }}
										animate={{ opacity: 1, filter: "blur(0px)" }}
										exit={{ opacity: 0, filter: "blur(4px)" }}
										transition={{ duration: 0.15 }}
										className="inline-flex items-center gap-1.5 whitespace-nowrap"
									>
										<span className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
										Starting…
									</motion.span>
								) : (
									<motion.span
										key="start"
										initial={{ opacity: 0, filter: "blur(4px)" }}
										animate={{ opacity: 1, filter: "blur(0px)" }}
										exit={{ opacity: 0, filter: "blur(4px)" }}
										transition={{ duration: 0.15 }}
									>
										Start
									</motion.span>
								)}
							</AnimatePresence>
						</motion.span>
					</div>
				</div>
			</motion.div>
		</motion.div>
	);
}

/* ------------------------------------------------------------------ */
/* Board view — empty except for the created task                      */
/* ------------------------------------------------------------------ */

function BranchIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="4.5" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.3" />
			<circle cx="4.5" cy="12.5" r="1.5" stroke="currentColor" strokeWidth="1.3" />
			<circle cx="11.5" cy="5.5" r="1.5" stroke="currentColor" strokeWidth="1.3" />
			<path d="M4.5 5v6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" />
			<path d="M4.5 3.5C4.5 7 11.5 7 11.5 7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" />
		</svg>
	);
}

type BoardCardData = {
	id: string;
	title: string;
	branch: string;
	icon: string;
	activity: string;
	time: string;
};

const COLUMN_CONFIG: { id: string; title: string; color: string }[] = [
	{ id: "working", title: "Pending Work", color: "#60a5fa" },
	{ id: "staging", title: "Iterating", color: "#a78bfa" },
	{ id: "in_review", title: "In Review", color: "#facc15" },
	{ id: "merge", title: "Ready to merge", color: "#4ade80" },
];

function BoardCard({ card }: { card: BoardCardData }) {
	return (
		<motion.div
			data-cursor-target="board-card"
			initial={{ opacity: 0, scale: 0.96, y: -8 }}
			animate={{ opacity: 1, scale: 1, y: 0 }}
			transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
			className="rounded-[6px] border bg-[var(--preview-card)] shadow-[0_1px_1px_rgba(0,0,0,0.05)]"
			style={{ borderColor: "rgba(96, 165, 250, 0.4)", boxShadow: "0 0 0 1px rgba(96,165,250,0.15), 0 1px 1px rgba(0,0,0,0.05)" }}
		>
			<div className="flex items-start gap-2 px-2.5 pb-2 pt-2.5">
				<div className="relative mt-0.5 h-3 w-3 shrink-0">
					<Image src={card.icon} alt="" width={12} height={12} className="h-3 w-3" draggable={false} />
				</div>
				<div className="line-clamp-2 min-w-0 text-[8px] font-semibold leading-tight tracking-tight text-[var(--preview-card-foreground)]">
					{card.title}
				</div>
			</div>
			<div className="px-2.5 text-[8px] leading-[14px] text-[var(--preview-muted-foreground)]">
				<div className="flex items-center gap-1 py-0.5">
					<BranchIcon className="h-2.5 w-2.5 shrink-0" />
					<span className="truncate font-mono">{card.branch}</span>
				</div>
			</div>
			<div className="flex items-center gap-1.5 border-t border-[var(--preview-border)] px-2.5 py-2 text-[8px] text-[var(--preview-muted-foreground)]">
				<span className="size-2.5 shrink-0 animate-spin rounded-full border border-[#4b5563] border-t-[#d1d5db]" />
				<span className="truncate">{card.activity}</span>
			</div>
		</motion.div>
	);
}

function BoardView({ card }: { card: BoardCardData }) {
	return (
		<div className="h-full overflow-hidden rounded-[12px] border border-[var(--preview-border)] bg-[var(--preview-background)]">
			<div className="grid h-full grid-cols-4 divide-x divide-[var(--preview-border)]">
				{COLUMN_CONFIG.map((col, i) => (
					<section key={col.id} className="flex min-h-0 min-w-0 flex-col">
						<div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--preview-border)] px-3">
							<span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: col.color }} />
							<div className="truncate text-[8px] font-medium tracking-wide text-[var(--preview-muted-foreground)]">{col.title}</div>
							<div className="ml-auto font-mono text-[8px] leading-none text-[var(--preview-muted-foreground)] opacity-60">{i === 0 ? 1 : 0}</div>
						</div>
						<div className="min-h-0 flex-1 space-y-1.5 overflow-hidden px-2 pb-2 pt-2">
							{i === 0 ? <BoardCard card={card} /> : null}
						</div>
					</section>
				))}
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/* Main demo                                                           */
/* ------------------------------------------------------------------ */
export function ProjectAgentsDemo() {
	const rootRef = useRef<HTMLDivElement>(null);
	const inViewRef = useRef(true);
	const { viewportRef, viewportStyle, canvasStyle } = usePreviewScale(PREVIEW_WIDTH, PREVIEW_HEIGHT);
	const [sceneIndex, setSceneIndex] = useState(0);
	const [cursor, setCursor] = useState({ x: 50, y: 50 });
	const [reducedMotion] = useState(
		() =>
			typeof window !== "undefined" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	const scene = PROJECT_AGENT_SCENES[sceneIndex] ?? PROJECT_AGENT_SCENES[0]!;
	const clockKey = sceneClockKey(scene);

	useEffect(() => {
		const node = rootRef.current;
		if (!node || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			([entry]) => { inViewRef.current = entry?.isIntersecting ?? true; },
			{ threshold: 0.2 },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (reducedMotion) return;
		let cancelled = false;
		let timer = 0;
		const tick = () => {
			if (cancelled) return;
			if (!inViewRef.current) {
				timer = window.setTimeout(tick, 300);
				return;
			}
			setSceneIndex((i) => (i + 1) % PROJECT_AGENT_SCENES.length);
		};
		timer = window.setTimeout(tick, scene.duration);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [clockKey, scene.duration, reducedMotion]);

	useEffect(() => {
		if (reducedMotion) return;
		const root = rootRef.current;
		if (!root) return;
		let frame = 0;
		let settleTimer = 0;
		const measure = () => {
			const target = root.querySelector<HTMLElement>(`[data-cursor-target="${scene.target}"]`);
			if (!target) return;
			const rootRect = root.getBoundingClientRect();
			const targetRect = target.getBoundingClientRect();
			if (!rootRect.width || !rootRect.height || !targetRect.width || !targetRect.height) return;
			setCursor(cursorPositionForRects(rootRect, targetRect));
		};
		frame = window.requestAnimationFrame(measure);
		settleTimer = window.setTimeout(measure, 140);
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		observer?.observe(root);
		return () => {
			window.cancelAnimationFrame(frame);
			window.clearTimeout(settleTimer);
			observer?.disconnect();
		};
	}, [reducedMotion, scene.id, scene.target]);

	const createdCard: BoardCardData = {
		id: "new-task",
		title: TASK_TEXT_FULL,
		branch: "fix/webhook-retry-flaky",
		icon: agentById(scene.selectedAgent ?? "codex").icon,
		activity: "Writing implementation",
		time: "just now",
	};

	if (reducedMotion) {
		return (
			<div
				ref={viewportRef}
				className="relative w-full min-w-0 max-w-[570px]"
				style={viewportStyle}
				role="img"
				aria-label="New task dialog with task description and agent selection."
			>
				<div
					className="absolute left-0 top-0 overflow-visible rounded-[18px]"
					style={{ ...featurePreviewTokens, ...canvasStyle, fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif" }}
				>
					<NewTaskModal scene={{ ...PROJECT_AGENT_SCENES[1]!, typedChars: TASK_TEXT_FULL.length, typing: false }} />
				</div>
			</div>
		);
	}

	return (
		<div
			ref={viewportRef}
			className="relative w-full min-w-0 max-w-[570px]"
			style={viewportStyle}
			role="img"
			aria-label="Demo: creating a new task and seeing it appear on the board."
		>
			<div
				ref={rootRef}
				className="absolute left-0 top-0 select-none overflow-visible rounded-[18px]"
				style={{ ...featurePreviewTokens, ...canvasStyle, fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif" }}
			>
				<div className="pointer-events-none absolute inset-0">
					<AnimatePresence mode="wait">
						{scene.phase === "board" && scene.id !== "reset" ? (
							<motion.div
								key="board"
								{...PHASE_TRANSITION}
								className="absolute inset-0 p-3"
							>
								<BoardView card={createdCard} />
							</motion.div>
						) : null}
						{scene.phase === "modal" && scene.id !== "reset" ? (
							<NewTaskModal key="modal" scene={scene} />
						) : null}
					</AnimatePresence>
				</div>
				<DemoCursor
					x={cursor.x}
					y={cursor.y}
					pressed={scene.click === true}
					clickId={scene.click ? sceneIndex : 0}
				/>
			</div>
		</div>
	);
}
