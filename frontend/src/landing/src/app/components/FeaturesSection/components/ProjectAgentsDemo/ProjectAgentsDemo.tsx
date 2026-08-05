"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, FolderOpen, GitBranch, GitPullRequest, Info, LayoutDashboard, MoreVertical, Network, PanelLeft, Pin, Plus, Search, X } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { featurePreviewTokens } from "../FeaturePreviewShell";
import { cursorPositionForRects, PROJECT_AGENT_SCENES, sceneClockKey, type CursorTarget, type ProjectAgentsScene } from "./ProjectAgentsDemo.scenes";
import { PROJECT_AGENT_MENU_OPTIONS, PROJECT_AGENTS_VISUAL_CONTRACT, type ProjectAgentMenuOption } from "./ProjectAgentsDemo.visual";

/* ------------------------------------------------------------------ */
/* Visual tokens — resolved from the desktop app's dark theme          */
/* (frontend/src/styles/tokens.css).                                   */
/* ------------------------------------------------------------------ */
const T = {
	bg: "var(--preview-background)",
	sidebar: "var(--preview-sidebar)",
	card: "var(--preview-card)",
	popover: "var(--preview-card)",
	fg: "var(--preview-foreground)",
	mut: "var(--preview-muted-foreground)",
	faint: "var(--preview-passive)",
	blue: "var(--preview-primary)",
	primaryFg: "var(--preview-primary-foreground)",
	line: "var(--preview-border)",
	line2: "var(--preview-border-strong)",
	input: "var(--preview-input)",
	hover: "var(--preview-sidebar-hover)",
	selected: "var(--preview-sidebar-accent)",
	success: "#4ade80",
	warning: "#fb923c",
	scrim: "color-mix(in oklch, var(--preview-background) 85%, transparent)",
} as const;

const V = PROJECT_AGENTS_VISUAL_CONTRACT;

/* ------------------------------------------------------------------ */
/* Agent catalog — ranked like buildRankedAgentOptions(): authorized   */
/* first (priority order), unauthorized last and disabled.             */
/* ------------------------------------------------------------------ */
const AGENTS = PROJECT_AGENT_MENU_OPTIONS;

function agentById(id: string): ProjectAgentMenuOption {
	return AGENTS.find((agent) => agent.id === id) ?? AGENTS[1]!;
}

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

function AgentSelectTrigger({ agentId, active, target }: { agentId: string; active: boolean; target: CursorTarget }) {
	const agent = agentById(agentId);
	return (
		<div
			data-cursor-target={target}
			className="flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-[12px]"
			style={{
				height: V.agentSelect.triggerHeight,
				background: T.input,
				borderColor: T.line,
				boxShadow: V.agentSelect.activeTriggerGlow && active ? "0 0 0 2px color-mix(in oklch, var(--preview-primary) 24%, transparent)" : "none",
			}}
		>
			<AgentIcon src={agent.icon} />
			<span className="min-w-0 flex-1 truncate text-left font-medium" style={{ color: T.fg }}>{agent.label}</span>
			<ChevronDown className="size-[13px] shrink-0 opacity-50" style={{ color: T.mut }} aria-hidden="true" />
		</div>
	);
}

function AgentMenu({ currentValue, hoverId, side, targetAgent }: { currentValue: string; hoverId: string | null | undefined; side: "left" | "right"; targetAgent: "codex" | "claude-code" }) {
	return (
		<motion.div
			initial={{ opacity: 0, y: -4, scale: 0.98 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			exit={{ opacity: 0, y: -3, scale: 0.98 }}
			transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
			className="absolute z-30 flex flex-col overflow-hidden rounded-lg border"
			style={{
				[side]: 24,
				top: V.agentSelect.menuTop,
				width: "calc((100% - 64px) / 2)",
				maxHeight: V.agentSelect.menuMaxHeight,
				background: T.card,
				borderColor: T.line,
				boxShadow: "0 12px 30px rgba(0,0,0,0.42)",
			}}
		>
			<div className="min-h-0 flex-1 overflow-hidden p-1">
				{AGENTS.map((agent) => {
					const selected = agent.id === currentValue;
					const hovered = agent.id === hoverId;
					const statusColor = agent.statusTone === "warning" ? T.warning : T.faint;
					return (
						<div
							key={agent.id}
							data-cursor-target={agent.id === targetAgent ? (targetAgent === "codex" ? "worker-cursor" : "orchestrator-claude") : undefined}
							className="flex w-full items-center rounded-md text-[11px] leading-4 outline-none"
							style={{
								background: hovered ? T.hover : selected ? T.selected : "transparent",
								opacity: agent.disabled ? 0.42 : 1,
								padding: `${V.agentSelect.itemPaddingY}px ${V.agentSelect.itemPaddingX}px`,
							}}
						>
							<span className="flex min-w-0 w-full items-center" style={{ gap: V.agentSelect.contentGap }}>
								<AgentIcon src={agent.icon} size={V.agentSelect.menuIconSize} />
								<span className="min-w-0 flex-1 truncate" style={{ color: selected || hovered ? T.fg : T.mut }}>{agent.label}</span>
								<span className="flex shrink-0 justify-end" style={{ width: V.agentSelect.trailingColumnWidth }}>
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
				{V.agentSelect.clickFeedback && clickId > 0 ? (
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
/* Project agents modal — faithful to CreateProjectAgentSheet.         */
/* ------------------------------------------------------------------ */
function BoardView({ scene }: { scene: ProjectAgentsScene }) {
	return (
		<div className="flex h-full overflow-hidden" style={{ background: T.sidebar }}>
			<aside className="relative flex w-[184px] shrink-0 flex-col text-[11px]" style={{ background: T.sidebar, color: T.mut }}>
				<div
					className="flex shrink-0 items-center gap-2 px-3"
					style={{ height: V.agentSelect.sidebarChromeHeight, color: T.faint }}
				>
					<div className="flex items-center gap-1.5" aria-hidden="true">
						<span className="size-2.5 rounded-full bg-[#ff5f57]" />
						<span className="size-2.5 rounded-full bg-[#ffbd2e]" />
						<span className="size-2.5 rounded-full bg-[#28c840]" />
					</div>
					<PanelLeft className="ml-1 size-3.5" aria-hidden="true" />
					<ArrowLeft className="ml-2 size-3 opacity-40" aria-hidden="true" />
					<ArrowRight className="size-3 opacity-40" aria-hidden="true" />
				</div>
				<div className="flex shrink-0 items-center gap-1.5 px-3" style={{ height: V.agentSelect.sidebarBrandRowHeight }}>
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
					<div
						className="flex shrink-0 items-center gap-2 border-b px-3"
						style={{ height: V.agentSelect.contentHeaderHeight, borderColor: T.line2 }}
					>
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

function ProjectKindDialog() {
	return (
		<motion.div className="absolute inset-0 z-20" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
			<div className="absolute inset-0" style={{ background: T.scrim, backdropFilter: "blur(4px)" }} />
			<motion.div
				data-cursor-target="mode-picker"
				initial={{ opacity: 0, scale: 0.96 }}
				animate={{ opacity: 1, scale: 1 }}
				className="absolute left-1/2 top-1/2 flex max-w-[calc(100%-24px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[12px] border"
				style={{
					width: V.importPicker.width,
					padding: V.importPicker.panelPadding,
					gap: V.importPicker.panelGap,
					background: T.popover,
					borderColor: T.line,
					boxShadow: "0 0 0 1px var(--preview-border), 0 12px 32px rgba(0,0,0,.42)",
				}}
			>
				<div className="relative pr-7">
					<div className="text-[15px] font-bold leading-5" style={{ color: T.fg }}>Import to Agent Orchestrator</div>
					<div className="mt-1 text-[11px] leading-4" style={{ color: T.mut }}>What are you importing?</div>
					<X className="absolute right-0 top-0 size-4" style={{ color: T.mut }} />
				</div>
				<div className="grid grid-cols-2" style={{ gap: V.importPicker.cardGap }}>
					<div
						className="flex flex-col rounded-[12px] border"
						style={{ minHeight: V.importPicker.cardMinHeight, padding: V.importPicker.cardPadding, paddingBottom: V.importPicker.cardPaddingBottom, gap: V.importPicker.cardGap, background: T.selected, borderColor: T.line, color: T.fg }}
					>
						<div className="flex w-full flex-col items-start gap-2 rounded-lg border border-dashed px-2.5 pt-2.5" style={{ height: V.importPicker.illustrationHeight, paddingBottom: V.agentSelect.workspaceIllustrationPaddingBottom, background: T.popover, borderColor: T.line }}>
							<div className="flex items-center gap-1.5 text-[10px]" style={{ color: T.mut }}><FolderOpen className="size-3" />my-workspace/</div>
							<div className="flex w-full flex-col" style={{ gap: V.agentSelect.workspaceRepoListGap }}>
								{["web-app", "api-server", "shared-libs"].map((repo) => (
									<span key={repo} className="flex w-full items-center rounded px-2 text-[8px] font-semibold" style={{ paddingTop: V.agentSelect.workspaceRepoRowPaddingY, paddingBottom: V.agentSelect.workspaceRepoRowPaddingY, background: T.selected }}>
										<span className="mr-1.5 size-1 rounded-full" style={{ background: T.fg }} />{repo}
									</span>
								))}
							</div>
						</div>
						<div className="mt-auto flex flex-col items-start gap-1">
							<div className="text-[13px] font-bold">Workspace</div>
							<div className="text-[10px] leading-[14px]" style={{ minHeight: V.importPicker.descriptionMinHeight, color: T.mut }}>Several Git repos that live under one parent folder.</div>
						</div>
					</div>
					<div
						data-cursor-target="project-kind"
						className="flex flex-col rounded-[12px] border"
						style={{ minHeight: V.importPicker.cardMinHeight, padding: V.importPicker.cardPadding, paddingBottom: V.importPicker.cardPaddingBottom, gap: V.importPicker.cardGap, background: T.selected, borderColor: T.line, color: T.fg }}
					>
						<div className="flex items-center justify-center" style={{ height: V.importPicker.illustrationHeight }}>
							<span className="flex h-[31px] items-center rounded-lg border px-2.5 text-[10px]" style={{ borderColor: T.line, background: T.selected }}>
								<span className="mr-1.5 size-1.5 rounded-full" style={{ background: T.fg }} /><strong>web-app</strong><span className="ml-1" style={{ color: T.mut }}>&middot; main</span>
							</span>
						</div>
						<div className="mt-auto flex flex-col items-start gap-1 text-left">
							<div className="text-[13px] font-bold">Project</div>
							<div className="text-[10px] leading-[14px]" style={{ minHeight: V.importPicker.descriptionMinHeight, color: T.mut }}>A single Git repository - tracked in a single codebase.</div>
						</div>
					</div>
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
				className="absolute left-1/2 top-1/2 min-h-[280px] w-[min(480px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 rounded-[12px]"
				style={{
					background: T.card,
					border: `1px solid ${T.line}`,
					boxShadow: "0 0 0 1px rgba(255,255,255,0.04), 0 18px 52px rgba(0,0,0,0.48)",
				}}
			>
				{/* Header */}
				<div className="flex items-start justify-between gap-4 border-b px-6 py-5" style={{ borderColor: T.line }}>
					<div className="min-w-0">
						<div className="text-[15px] font-semibold" style={{ color: T.fg }}>
							Project agents
						</div>
						<div className="mt-1 break-all text-[12px]" style={{ color: T.mut }}>
							~/Projects/agent-orchestrator
						</div>
					</div>
					<span
						className="grid size-7 shrink-0 place-items-center rounded-md"
						style={{ color: T.mut, opacity: busy ? 0.5 : 1 }}
					>
						<X className="size-4" aria-hidden="true" />
					</span>
				</div>

				{/* Form */}
				<div className="relative flex flex-col gap-5 px-6 py-5">
					{/* Agent fields */}
					<div className="grid grid-cols-2 gap-4">
						<div className="flex flex-col gap-1.5">
							<span className="text-[11px] font-medium" style={{ color: T.mut }}>
								Worker agent
							</span>
							<AgentSelectTrigger agentId={worker} active={openMenu === "worker"} target="worker-trigger" />
						</div>
						<div className="flex flex-col gap-1.5">
							<span className="text-[11px] font-medium" style={{ color: T.mut }}>
								Orchestrator agent
							</span>
							<AgentSelectTrigger agentId={orch} active={openMenu === "orch"} target="orchestrator-trigger" />
						</div>
					</div>

					{/* Cache / refresh row */}
					<div className="flex items-center justify-end border-b pb-5 text-[11px]" style={{ borderColor: T.line }}>
						<span className="font-medium" style={{ color: T.fg }}>Refresh agents</span>
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
										<span className="text-[11px] font-medium" style={{ color: T.mut }}>
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
					<div className="mt-8 flex items-center justify-end gap-2">
						<span
							className="ml-auto inline-flex h-[30px] items-center rounded-md px-3 text-[12px]"
							style={{ background: "transparent", color: T.fg, opacity: busy ? 0.5 : 1 }}
						>
							Cancel
						</span>
						<span
							data-cursor-target="create-and-start"
							className="inline-flex h-[30px] items-center rounded-md px-3 text-[12px] font-medium text-white"
							style={{ background: T.fg, color: T.bg, opacity: busy ? 0.65 : 1 }}
						>
							{busy ? "Creating..." : "Create and start"}
						</span>
					</div>

					{/* Dropdowns — rendered inside the panel so they scale with it */}
					<AnimatePresence>
						{openMenu === "worker" ? (
							<AgentMenu key="worker" currentValue={worker} hoverId={menuHover} side="left" targetAgent="codex" />
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
					style={featurePreviewTokens}
					role="img"
					aria-label="Project agents dialog with Codex as worker agent and Claude Code as orchestrator agent."
				>
					<BoardView scene={PROJECT_AGENT_SCENES[0]!} />
					<ProjectAgentsModal
						worker="codex"
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
				style={featurePreviewTokens}
				role="img"
				aria-label="Demo: creating a new project and selecting its worker and orchestrator agents."
			>
				<div className="pointer-events-none absolute inset-0">
					<BoardView scene={scene} />
					<AnimatePresence>
						{scene.modePicker ? <ProjectKindDialog key="project-kind" /> : null}
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
