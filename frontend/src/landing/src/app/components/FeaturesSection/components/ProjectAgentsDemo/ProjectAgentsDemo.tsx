"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, FolderGit2, FolderOpen, GitBranch, GitPullRequest, Info, LayoutDashboard, MoreVertical, Network, PanelLeft, Pin, Plus, Search, Settings, X } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { cursorPositionForRects, PROJECT_AGENT_SCENES, sceneClockKey, type CursorTarget, type ProjectAgentsScene } from "./ProjectAgentsDemo.scenes";

/* ------------------------------------------------------------------ */
/* Visual tokens — resolved from the desktop app's dark theme          */
/* (frontend/src/styles/tokens.css).                                   */
/* ------------------------------------------------------------------ */
const T = {
	bg: "oklch(0.185 0.006 285.885)", // --background
	sidebar: "oklch(0.155 0.005 285.823)", // --sidebar
	card: "oklch(0.24 0.008 285.885)", // --card / --color-bg-agents-sheet
	popover: "oklch(0.24 0.008 285.885)", // --popover
	fg: "oklch(0.985 0 0)", // --foreground
	mut: "oklch(0.705 0.015 286.067)", // --muted-foreground
	faint: "oklch(0.442 0.017 285.786)", // --color-text-passive
	blue: "#4f8afa", // primary action (matches the shipped modal)
	line: "oklch(1 0 0 / 7%)", // --border
	line2: "oklch(1 0 0 / 4%)", // --input / --color-border-strong
	input: "oklch(1 0 0 / 4%)", // --input / sheet control bg
	hover: "color-mix(in oklch, oklch(0.985 0 0) 4%, transparent)", // interactive-hover
	selected: "oklch(0.274 0.006 286.033)", // --sidebar-accent
	success: "#4ade80",
	warning: "#fb923c",
	scrim: "color-mix(in oklch, oklch(0.185 0.006 285.885) 85%, transparent)", // --color-scrim
} as const;

/* ------------------------------------------------------------------ */
/* Agent catalog — ranked like buildRankedAgentOptions(): authorized   */
/* first (priority order), unauthorized last and disabled.             */
/* ------------------------------------------------------------------ */
type AgentDef = {
	id: string;
	label: string;
	icon: string;
	status: "" | "Needs auth";
};

const AGENTS: readonly AgentDef[] = [
	{ id: "claude-code", label: "Claude Code", icon: "/app-icons/coverage-claude-code.svg", status: "" },
	{ id: "codex", label: "Codex", icon: "/app-icons/coverage-codex.svg", status: "" },
	{ id: "cursor", label: "Cursor", icon: "/app-icons/coverage-cursor.svg", status: "" },
	{ id: "opencode", label: "OpenCode", icon: "/app-icons/coverage-opencode.svg", status: "" },
	{ id: "aider", label: "Aider", icon: "/app-icons/coverage-aider.png", status: "" },
	{ id: "goose", label: "Goose", icon: "/app-icons/coverage-goose.svg", status: "Needs auth" },
] as const;

function agentById(id: string): AgentDef {
	return AGENTS.find((a) => a.id === id) ?? AGENTS[1]!;
}

/* ------------------------------------------------------------------ */
/* Scene machine — the whole showcase is driven from this table.       */
/* Cursor coordinates are % of the demo surface (≈570 × 360).          */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Small presentational pieces                                         */
/* ------------------------------------------------------------------ */
function AgentIcon({ src, size = 15 }: { src: string; size?: number }) {
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

/* Boxed select trigger — the create-sheet "stacked" variant. */
function AgentSelectTrigger({ agentId, active, target }: { agentId: string; active: boolean; target: CursorTarget }) {
	const agent = agentById(agentId);
	return (
		<div
			data-cursor-target={target}
			className="flex h-8 w-full items-center gap-2 rounded-md px-2.5"
			style={{
				background: T.input,
				border: `1px solid ${active ? "rgba(255,255,255,0.22)" : T.line}`,
				boxShadow: active ? "0 0 0 3px rgba(255,255,255,0.08)" : "none",
			}}
		>
			<AgentIcon src={agent.icon} />
			<span className="min-w-0 flex-1 truncate text-left text-[12px]" style={{ color: T.fg }}>
				{agent.label}
			</span>
			<ChevronDown className="size-[13px] shrink-0 opacity-60" style={{ color: T.mut }} aria-hidden="true" />
		</div>
	);
}

function AgentMenu({ currentValue, hoverId, side, targetAgent }: { currentValue: string; hoverId: string | null | undefined; side: "left" | "right"; targetAgent: "cursor" | "claude-code" }) {
	return (
		<motion.div
			initial={{ opacity: 0, y: -4, scale: 0.98 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			exit={{ opacity: 0, y: -3, scale: 0.98 }}
			transition={{ duration: 0.12, ease: [0.2, 0, 0, 1] }}
			className="absolute top-[72px] z-30 w-[calc(50%-30px)] overflow-hidden rounded-[9px] p-1"
			style={{
				[side]: 20,
				background: T.popover,
				border: `1px solid ${T.line2}`,
				boxShadow: "0 12px 32px rgba(0,0,0,0.48), 0 0 0 1px rgba(255,255,255,0.025)",
			}}
		>
			{AGENTS.map((agent) => {
				const selected = agent.id === currentValue;
				const hovered = agent.id === hoverId;
				const disabled = agent.status !== "";
				return (
					<div
						key={agent.id}
						data-cursor-target={agent.id === targetAgent ? (targetAgent === "cursor" ? "worker-cursor" : "orchestrator-claude") : undefined}
						className="flex h-6 items-center gap-2 rounded-[6px] px-2"
						style={{
							background: hovered ? T.selected : selected ? T.hover : "transparent",
							opacity: disabled ? 0.5 : 1,
						}}
					>
						<AgentIcon src={agent.icon} />
						<span
							className="min-w-0 flex-1 truncate text-[11.5px] leading-none"
							style={{ color: hovered || selected ? T.fg : T.mut }}
						>
							{agent.label}
						</span>
						{agent.status ? (
							<span className="shrink-0 rounded-full px-1.5 py-0.5 text-[8px] leading-none" style={{ color: T.warning, background: "rgba(251,146,60,0.1)" }}>
								{agent.status}
							</span>
						) : null}
					</div>
				);
			})}
		</motion.div>
	);
}

function DemoCursor({ x, y, pressed, clickId }: { x: number; y: number; pressed: boolean; clickId: number }) {
	return (
		<motion.div
			className="pointer-events-none absolute z-40"
			initial={false}
			animate={{ left: `${x}%`, top: `${y}%` }}
			transition={{ type: "spring", stiffness: 380, damping: 34, mass: 0.65 }}
			style={{ width: 0, height: 0 }}
		>
			<motion.div animate={{ scale: pressed ? 0.76 : 1 }} transition={{ duration: 0.1 }}>
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
						animate={{ opacity: 0, scale: 1.8 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.5, ease: "easeOut" }}
						className="absolute -left-[14px] -top-[14px] size-7 rounded-full"
						style={{ border: `2px solid ${T.fg}`, boxShadow: "0 0 0 4px rgba(255,255,255,0.16)" }}
					/>
				) : null}
			</AnimatePresence>
		</motion.div>
	);
}

/* ------------------------------------------------------------------ */
/* Board (always mounted underneath — the modal overlays it, exactly   */
/* like the real dialog over the app).                                 */
/* ------------------------------------------------------------------ */
function LegacyBoardView({ plusHover, started }: { plusHover: boolean; started: boolean }) {
	return (
		<div className="flex h-full">
			{/* Sidebar */}
			<div className="flex w-[158px] shrink-0 flex-col gap-1 border-r px-2 py-2.5" style={{ borderColor: T.line, background: T.sidebar }}>
				<div className="flex items-center justify-between px-1.5 pb-1">
					<span className="text-[9px] font-semibold uppercase tracking-[0.08em]" style={{ color: T.faint }}>
						Projects
					</span>
					<span
						className="grid size-[18px] place-items-center rounded"
						style={{ background: plusHover ? T.hover : "transparent", color: plusHover ? T.fg : T.mut }}
					>
						<Plus className="size-3" aria-hidden="true" />
					</span>
				</div>
				<div className="flex items-center gap-2 rounded-md px-1.5 py-[7px]" style={{ background: T.selected }}>
					<FolderGit2 className="size-[13px] shrink-0" style={{ color: T.mut }} aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate text-[11.5px] font-medium" style={{ color: T.fg }}>
						agent-orchestrator
					</span>
				</div>
				<div className="ml-4 flex items-center gap-2 rounded-md px-1.5 py-[5px]">
					<span className="size-1.5 rounded-full" style={{ background: T.success }} />
					<span className="truncate text-[10.5px]" style={{ color: T.mut }}>
						orchestrator
					</span>
				</div>
				<div className="flex items-center gap-2 rounded-md px-1.5 py-[7px] opacity-45">
					<FolderGit2 className="size-[13px] shrink-0" style={{ color: T.mut }} aria-hidden="true" />
					<span className="truncate text-[11.5px]" style={{ color: T.mut }}>
						landing-site
					</span>
				</div>
				{/* Newly created project appears after "Create and start". */}
				<AnimatePresence>
					{started ? (
						<motion.div
							initial={{ opacity: 0, y: -4 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0 }}
							transition={{ duration: 0.35, ease: [0.2, 0, 0, 1] }}
						>
							<div className="flex items-center gap-2 rounded-md px-1.5 py-[7px]" style={{ background: T.hover }}>
								<FolderGit2 className="size-[13px] shrink-0" style={{ color: T.mut }} aria-hidden="true" />
								<span className="min-w-0 flex-1 truncate text-[11.5px] font-medium" style={{ color: T.fg }}>
									test-component
								</span>
							</div>
							<div className="ml-4 flex items-center gap-2 rounded-md px-1.5 py-[5px]">
								<span className="relative flex size-1.5">
									<span className="absolute inline-flex size-full animate-ping rounded-full opacity-40" style={{ background: T.success }} />
									<span className="relative inline-flex size-1.5 rounded-full" style={{ background: T.success }} />
								</span>
								<span className="truncate text-[10.5px]" style={{ color: T.mut }}>
									orchestrator · starting
								</span>
							</div>
						</motion.div>
					) : null}
				</AnimatePresence>
			</div>

			{/* Board columns */}
			<div className="relative min-w-0 flex-1 p-3" style={{ background: T.bg }}>
				<div className="grid h-full grid-cols-2 gap-2.5">
					{[
						{ title: "Working", cards: ["fix: session restore", "feat: kanban filters"] },
						{ title: "In review", cards: ["PR #3406 · linux-rpm"] },
					].map((col) => (
						<div key={col.title} className="flex min-h-0 flex-col gap-2">
							<span className="text-[9px] font-semibold uppercase tracking-[0.08em]" style={{ color: T.faint }}>
								{col.title}
							</span>
							{col.cards.map((card) => (
								<div
									key={card}
									className="rounded-[10px] px-2.5 py-2 text-[10.5px]"
									style={{ background: T.card, border: `1px solid ${T.line2}`, color: T.mut, opacity: 0.7 }}
								>
									{card}
								</div>
							))}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/* Project agents modal — faithful to CreateProjectAgentSheet.         */
/* ------------------------------------------------------------------ */
function BoardView({ scene }: { scene: ProjectAgentsScene }) {
	return (
		<div className="flex h-full overflow-hidden rounded-[18px] border" style={{ borderColor: T.line, background: T.sidebar }}>
			<aside className="relative flex w-[184px] shrink-0 flex-col text-[11px]" style={{ background: T.sidebar, color: T.mut }}>
				<div className="flex h-8 items-center gap-2 px-3">
					<div className="flex items-center gap-1.5 pr-1"><span className="size-2.5 rounded-full bg-[#ff5f57]" /><span className="size-2.5 rounded-full bg-[#ffbd2e]" /><span className="size-2.5 rounded-full bg-[#28c840]" /></div>
					<PanelLeft className="size-3.5" style={{ color: T.faint }} aria-hidden="true" />
					<ArrowLeft className="size-3.5 opacity-40" style={{ color: T.faint }} aria-hidden="true" />
					<ArrowRight className="size-3.5 opacity-40" style={{ color: T.faint }} aria-hidden="true" />
				</div>
				<div className="flex items-center gap-1.5 px-3 pb-2">
					<img src="/ao-logo.svg" alt="" className="size-5 rounded-md" draggable="false" />
					<span className="truncate text-[12px] font-bold tracking-tight" style={{ color: T.fg }}>Agent Orchestrator</span>
				</div>
				<div className="px-2">
					<div className="mb-1.5 flex h-7 items-center gap-2 rounded-lg px-2.5" style={{ background: T.selected, color: T.mut }}>
						<Search className="size-3 opacity-80" aria-hidden="true" /><span>Search</span>
					</div>
					<div className="flex h-7 items-center gap-1.5 rounded-md px-2 font-medium" style={{ color: T.faint }}>
						<Pin className="size-3.5" aria-hidden="true" /><span>Pinned</span><ChevronRight className="size-3" aria-hidden="true" />
					</div>
					<div className="mt-0.5 flex h-7 items-center gap-1.5 rounded-md px-2 pr-1 font-medium" style={{ color: T.faint }}>
						<FolderOpen className="size-3.5" aria-hidden="true" /><span className="flex-1">Projects</span>
						<span data-cursor-target="new-project" className="grid size-5 place-items-center rounded-md" style={{ color: scene.newProjectHover ? T.fg : T.faint, background: scene.newProjectHover ? T.hover : "transparent" }}><Plus className="size-3.5" aria-hidden="true" /></span>
					</div>
				</div>
				<div className="relative mx-2 flex h-9 items-center gap-2 rounded-lg px-2 pr-[78px] font-medium" style={{ background: T.selected, color: T.fg }}>
					<FolderOpen className="size-4" strokeWidth={1.75} aria-hidden="true" /><span className="truncate">agent-orchestrator</span>
					<div className="absolute inset-y-0 right-1 flex items-center gap-px">
						<span className="grid size-6 place-items-center rounded-md"><LayoutDashboard className="size-3.5" aria-hidden="true" /></span>
						<span className="grid size-6 place-items-center rounded-md"><Network className="size-3.5" aria-hidden="true" /></span>
						<span className="grid size-6 place-items-center rounded-md"><MoreVertical className="size-3.5" aria-hidden="true" /></span>
					</div>
				</div>
				<div className="ml-4 flex h-7 items-center gap-2 px-3"><span className="size-1.5 rounded-full bg-[#60a5fa]" /><span className="truncate">stale icons</span></div>
				<div className="ml-4 flex h-7 items-center gap-2 px-3"><span className="size-1.5 rounded-full bg-[#fb923c]" /><span className="truncate">window border</span></div>
				<AnimatePresence>
					{scene.created ? (
						<motion.div data-cursor-target="new-project-row" initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} className="mx-2 mt-1 rounded-lg" style={{ background: T.hover }}>
							<div className="flex h-8 items-center gap-2 px-2 font-medium" style={{ color: T.fg }}><FolderOpen className="size-4" /><span className="truncate">test-component</span></div>
							<div className="ml-2 flex h-6 items-center gap-2 px-2"><span className="size-1.5 rounded-full bg-[#4ade80]" /><span className="truncate">orchestrator · ready</span></div>
						</motion.div>
					) : null}
				</AnimatePresence>
			</aside>
			<div className="min-w-0 flex-1 p-[2px]" style={{ background: T.sidebar }}>
				<div className="flex h-full flex-col overflow-hidden rounded-[16px]" style={{ background: T.bg }}>
					<div className="flex h-10 items-center gap-2 border-b px-3" style={{ borderColor: T.line2 }}>
						<span className="text-[12px] font-semibold" style={{ color: T.fg }}>agent-orchestrator</span>
					</div>
					<div data-cursor-target="board-idle" className="grid min-h-0 flex-1 grid-cols-2">
						<div className="flex min-w-0 flex-col gap-2 border-r p-3" style={{ borderColor: T.line2 }}>
							<div className="flex items-center gap-2 text-[9px] font-medium" style={{ color: T.mut }}><span className="size-1.5 rounded-full bg-[#60a5fa]" />Pending Work<span className="ml-auto" style={{ color: T.faint }}>1</span></div>
							<div className="overflow-hidden rounded-lg border shadow-[0_1px_1px_rgba(0,0,0,0.05)]" style={{ background: T.card, borderColor: T.line }}>
								<div className="flex items-start gap-2 px-3 pb-2 pt-3"><AgentIcon src="/app-icons/coverage-opencode.svg" size={14} /><div className="text-[10px] font-semibold leading-tight" style={{ color: T.fg }}>Remove stale generated icon imports</div></div>
								<div className="flex items-center gap-1.5 px-3 pb-2 font-mono text-[8px]" style={{ color: T.mut }}><GitBranch className="size-3 shrink-0" /><span className="truncate">cleanup/stale-icon-imports</span></div>
								<div className="flex items-center border-t px-3 py-2 text-[8px]" style={{ borderColor: T.line, color: T.mut }}><span className="mr-1.5 size-3 rounded-full border border-[#475569]" />Deleting file<span className="ml-auto">14m ago</span></div>
							</div>
						</div>
						<div className="flex min-w-0 flex-col gap-2 p-3">
							<div className="flex items-center gap-2 text-[9px] font-medium" style={{ color: T.mut }}><span className="size-1.5 rounded-full bg-[#fb923c]" />Iterating<span className="ml-auto" style={{ color: T.faint }}>1</span></div>
							<div className="overflow-hidden rounded-lg border shadow-[0_1px_1px_rgba(0,0,0,0.05)]" style={{ background: T.card, borderColor: T.line }}>
								<div className="flex items-start gap-2 px-3 pb-2 pt-3"><AgentIcon src="/app-icons/coverage-claude-code.svg" size={14} /><div className="text-[10px] font-semibold leading-tight" style={{ color: T.fg }}>Tighten hero window border alignment</div></div>
								<div className="space-y-1 px-3 pb-2 text-[8px]" style={{ color: T.mut }}><div className="flex items-center gap-1.5 font-mono"><GitBranch className="size-3 shrink-0" /><span className="truncate">landing/window-border-pass</span></div><div className="flex items-center gap-1.5"><GitPullRequest className="size-3 shrink-0" /><span className="font-mono">#320</span><span>open</span></div></div>
								<div className="flex items-center border-t px-3 py-2 text-[8px]" style={{ borderColor: T.line, color: T.mut }}><span className="mr-1.5 size-3 rounded-full border border-[#475569] border-r-[#fb923c]" />14/44 passed<span className="ml-auto">1h ago</span></div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function ProjectKindDialog({ projectActive }: { projectActive: boolean }) {
	return (
		<motion.div className="absolute inset-0 z-20" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
			<div className="absolute inset-0" style={{ background: T.scrim, backdropFilter: "blur(4px)" }} />
			<motion.div
				data-cursor-target="mode-picker"
				initial={{ opacity: 0, scale: 0.96 }}
				animate={{ opacity: 1, scale: 1 }}
				className="absolute left-1/2 top-1/2 flex w-[min(410px,calc(100%-28px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-[14px] border p-5"
				style={{ background: T.card, borderColor: T.line, boxShadow: "0 18px 50px rgba(0,0,0,.48)" }}
			>
				<div className="relative pr-7">
					<div className="text-[15px] font-semibold" style={{ color: T.fg }}>Import to Agent Orchestrator</div>
					<div className="mt-1 text-[10.5px]" style={{ color: T.mut }}>What would you like to import?</div>
					<X className="absolute right-0 top-0 size-4" style={{ color: T.mut }} />
				</div>
				<div className="grid grid-cols-2 gap-3">
					<div className="flex min-h-[116px] flex-col rounded-[12px] border p-3" style={{ background: T.input, borderColor: T.line, color: T.fg }}><div className="rounded-md border border-dashed p-2" style={{ borderColor: T.line }}><div className="flex items-center gap-1.5 text-[8px]" style={{ color: T.mut }}><FolderOpen className="size-3" />my-workspace/</div><div className="mt-1.5 flex gap-1"><span className="rounded px-1.5 py-1 text-[7px]" style={{ background: T.selected }}>web-app</span><span className="rounded px-1.5 py-1 text-[7px]" style={{ background: T.selected }}>api</span></div></div><div className="mt-auto pt-2 text-[12px] font-semibold">Workspace</div><div className="mt-0.5 text-[8.5px]" style={{ color: T.mut }}>A folder containing projects.</div></div>
					<div data-cursor-target="project-kind" className="flex min-h-[116px] flex-col rounded-[12px] border p-3" style={{ background: projectActive ? T.selected : T.input, borderColor: T.line, color: T.fg }}><div className="flex h-10 items-center justify-center"><span className="flex items-center rounded-md border px-2.5 py-2 text-[9px]" style={{ borderColor: T.line, background: T.selected }}><span className="mr-1.5 size-1.5 rounded-full bg-[#60a5fa]" />web-app <span className="ml-1" style={{ color: T.mut }}>· main</span></span></div><div className="mt-auto pt-2 text-[12px] font-semibold">Project</div><div className="mt-0.5 text-[8.5px]" style={{ color: T.mut }}>A single Git repository.</div></div>
				</div>
			</motion.div>
		</motion.div>
	);
}

function ProjectAgentsModal({
	worker,
	orch,
	intake,
	assignee,
	busy,
	openMenu,
	menuHover,
}: {
	worker: string;
	orch: string;
	intake: boolean;
	assignee: string;
	busy: boolean;
	openMenu: "worker" | "orch" | null | undefined;
	menuHover: string | null | undefined;
}) {
	return (
		<motion.div className="absolute inset-0 z-20" initial={false}>
			{/* Scrim */}
			<motion.div
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				transition={{ duration: 0.15 }}
				className="absolute inset-0"
				style={{ background: T.scrim, backdropFilter: "blur(4px)" }}
			/>
			{/* Panel */}
			<motion.div
				data-cursor-target="modal"
				initial={{ opacity: 0, scale: 0.95 }}
				animate={{ opacity: 1, scale: 1 }}
				exit={{ opacity: 0, scale: 0.97 }}
				transition={{ duration: 0.15, ease: [0.2, 0, 0, 1] }}
				className="absolute left-1/2 top-1/2 w-[min(440px,calc(100%-24px))] -translate-x-1/2 -translate-y-1/2 rounded-[14px]"
				style={{
					background: T.card,
					border: `1px solid ${T.line}`,
					boxShadow: "0 0 0 1px rgba(255,255,255,0.04), 0 8px 24px rgba(0,0,0,0.4)",
				}}
			>
				{/* Header */}
				<div className="flex items-start justify-between gap-3 border-b px-5 py-3.5" style={{ borderColor: T.line }}>
					<div className="min-w-0">
						<div className="text-[14px] font-semibold" style={{ color: T.fg }}>
							Project agents
						</div>
						<div className="mt-0.5 truncate text-[11px]" style={{ color: T.mut }}>
							/Users/abc/Downloads/test-component
						</div>
					</div>
					<span
						className="grid size-6 shrink-0 place-items-center rounded-md"
						style={{ color: T.mut, opacity: busy ? 0.5 : 1 }}
					>
						<X className="size-4" aria-hidden="true" />
					</span>
				</div>

				{/* Form */}
				<div className="relative flex flex-col gap-3 px-5 py-3.5">
					{/* Agent fields */}
					<div className="grid grid-cols-2 gap-3">
						<div className="flex flex-col gap-1.5">
							<span className="text-[11px] font-medium" style={{ color: T.fg }}>
								Worker agent
							</span>
							<AgentSelectTrigger agentId={worker} active={openMenu === "worker"} target="worker-trigger" />
						</div>
						<div className="flex flex-col gap-1.5">
							<span className="text-[11px] font-medium" style={{ color: T.fg }}>
								Orchestrator agent
							</span>
							<AgentSelectTrigger agentId={orch} active={openMenu === "orch"} target="orchestrator-trigger" />
						</div>
					</div>

					{/* Cache / refresh row */}
					<div className="flex items-center justify-between text-[11px]">
						<span style={{ color: T.mut }}>Agent availability is cached.</span>
						<span style={{ color: T.fg }}>Refresh agents</span>
					</div>

					{/* Issue intake */}
					<div className="hidden border-t pt-3.5" style={{ borderColor: T.line }}>
						<div className="flex items-center gap-2">
							<span
								data-cursor-target="intake-toggle"
								className="grid size-4 place-items-center rounded-[4px]"
								style={{
									background: intake ? T.blue : "transparent",
									border: `1.5px solid ${intake ? T.blue : "rgba(255,255,255,0.28)"}`,
								}}
							>
								{intake ? <Check className="size-2.5 text-white" strokeWidth={3.5} aria-hidden="true" /> : null}
							</span>
							<span className="text-[12px]" style={{ color: T.fg }}>
								Enable issue intake
							</span>
							<Info className="size-3" style={{ color: T.mut }} aria-hidden="true" />
						</div>
						<AnimatePresence initial={false}>
							{intake ? (
								<motion.div
									initial={{ opacity: 0, height: 0 }}
									animate={{ opacity: 1, height: "auto" }}
									exit={{ opacity: 0, height: 0 }}
									transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
									className="overflow-hidden"
								>
									<div className="flex flex-col gap-1.5 pt-2.5">
										<span className="text-[11px] font-medium" style={{ color: T.fg }}>
											Assignee
										</span>
										<div
											data-cursor-target="assignee"
											className="flex h-[30px] items-center rounded-md px-2.5 text-[12px]"
											style={{ background: "transparent", border: `1px solid ${T.line}`, color: T.fg }}
										>
											{assignee}
											<span className="ml-px inline-block h-3.5 w-px animate-pulse" style={{ background: T.fg }} />
										</div>
									</div>
								</motion.div>
							) : null}
						</AnimatePresence>
					</div>

					{/* Footer */}
					<div className="mt-0.5 flex items-center justify-end gap-2 border-t pt-3.5" style={{ borderColor: T.line }}>
						<span
							className="ml-auto inline-flex h-[30px] items-center rounded-md px-3 text-[12px]"
							style={{ background: "transparent", border: `1px solid ${T.line}`, color: T.fg, opacity: busy ? 0.5 : 1 }}
						>
							Cancel
						</span>
						<span
							data-cursor-target="create-and-start"
							className="inline-flex h-[30px] items-center rounded-md px-3 text-[12px] font-medium text-white"
							style={{ background: T.blue, opacity: busy ? 0.65 : 1 }}
						>
							{busy ? "Creating…" : "Create and start"}
						</span>
					</div>

					{/* Dropdowns — rendered inside the panel so they scale with it */}
					<AnimatePresence>
						{openMenu === "worker" ? (
							<AgentMenu key="worker" currentValue={worker} hoverId={menuHover} side="left" targetAgent="cursor" />
						) : openMenu === "orch" ? (
							<AgentMenu key="orch" currentValue={orch} hoverId={menuHover} side="right" targetAgent="claude-code" />
						) : null}
					</AnimatePresence>
				</div>
			</motion.div>
		</motion.div>
	);
}

/* ------------------------------------------------------------------ */
/* Main demo                                                           */
/* ------------------------------------------------------------------ */
export function ProjectAgentsDemo() {
	const rootRef = useRef<HTMLDivElement>(null);
	const inViewRef = useRef(true);
	const [sceneIndex, setSceneIndex] = useState(0);
	const [cursor, setCursor] = useState({ x: 70, y: 52 });
	const [reducedMotion] = useState(
		() =>
			typeof window !== "undefined" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	const scene = PROJECT_AGENT_SCENES[sceneIndex] ?? PROJECT_AGENT_SCENES[0]!;
	const clockKey = sceneClockKey(scene);

	/* Run the scene clock only while the card is on screen. */
	useEffect(() => {
		const node = rootRef.current;
		if (!node || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			([entry]) => {
				inViewRef.current = entry?.isIntersecting ?? true;
			},
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

	/* Static reduced-motion frame: the filled modal. */
	if (reducedMotion) {
		return (
				<div
					className="relative h-[352px] w-full overflow-hidden rounded-[18px] sm:h-[380px]"
					role="img"
					aria-label="Project agents dialog with Cursor as worker agent and Claude Code as orchestrator agent."
				>
					<BoardView scene={PROJECT_AGENT_SCENES[0]!} />
					<ProjectAgentsModal
						worker="cursor"
						orch="claude-code"
						intake={false}
						assignee=""
						busy={false}
						openMenu={null}
						menuHover={null}
					/>
				</div>
		);
	}

	return (
			<div
				ref={rootRef}
				className="relative h-[352px] w-full overflow-hidden rounded-[18px] font-sans select-none sm:h-[380px]"
				role="img"
				aria-label="Demo: creating a new project and selecting its worker and orchestrator agents."
			>
				<div className="pointer-events-none absolute inset-0">
					<BoardView scene={scene} />
					<AnimatePresence>
						{scene.modePicker ? <ProjectKindDialog key="project-kind" projectActive={scene.target === "project-kind"} /> : null}
						{scene.modal ? (
							<ProjectAgentsModal
								key="modal"
								worker={scene.worker}
								orch={scene.orch}
								intake={false}
								assignee=""
								busy={scene.busy === true}
								openMenu={scene.openMenu}
								menuHover={scene.menuHover}
							/>
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
	);
}
