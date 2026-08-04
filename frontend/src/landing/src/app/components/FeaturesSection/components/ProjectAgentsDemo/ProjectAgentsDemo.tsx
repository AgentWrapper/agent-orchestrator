"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, FolderGit2, Info, Plus, X } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { FeaturePreviewShell } from "../FeaturePreviewShell";

/* ------------------------------------------------------------------ */
/* Visual tokens — resolved from the desktop app's dark theme          */
/* (frontend/src/styles/tokens.css).                                   */
/* ------------------------------------------------------------------ */
const T = {
	bg: "#1a1a20", // --background
	card: "#23232b", // --card / --color-bg-agents-sheet
	popover: "#282831", // --popover
	fg: "#fafafa", // --foreground
	mut: "#a4a4af", // --muted-foreground
	faint: "#6d6d78",
	blue: "#4f8afa", // primary action (matches the shipped modal)
	line: "rgba(255,255,255,0.07)", // --border
	line2: "rgba(255,255,255,0.045)",
	input: "rgba(255,255,255,0.04)", // --input / sheet control bg
	hover: "rgba(255,255,255,0.06)", // interactive-hover
	selected: "rgba(255,255,255,0.09)",
	success: "#74b98a",
	warning: "#e8c14a",
	scrim: "rgba(10,10,13,0.82)", // --color-scrim (background @ 85%)
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
type Scene = {
	id: string;
	dur: number;
	cursor: { x: number; y: number };
	click?: boolean;
	plusHover?: boolean;
	modal?: boolean;
	openMenu?: "worker" | "orch" | null;
	menuHover?: string | null;
	worker: string;
	orch: string;
	intake?: boolean;
	assignee?: string;
	busy?: boolean;
	started?: boolean;
	reset?: boolean;
};

const IDLE = { worker: "codex", orch: "codex" } as const;

const SCENES: readonly Scene[] = [
	{ id: "board-idle", dur: 1400, cursor: { x: 66, y: 50 }, ...IDLE },
	{ id: "to-plus", dur: 800, cursor: { x: 24.5, y: 5.5 }, plusHover: true, ...IDLE },
	{ id: "plus-click", dur: 550, cursor: { x: 24.5, y: 5.5 }, plusHover: true, click: true, ...IDLE },
	{ id: "modal-open", dur: 1300, cursor: { x: 50, y: 52 }, modal: true, ...IDLE },
	{ id: "worker-open", dur: 850, cursor: { x: 31.5, y: 37 }, modal: true, click: true, openMenu: "worker", ...IDLE },
	{ id: "worker-hover", dur: 950, cursor: { x: 30, y: 63 }, modal: true, openMenu: "worker", menuHover: "cursor", ...IDLE },
	{ id: "worker-pick", dur: 650, cursor: { x: 30, y: 63 }, modal: true, click: true, worker: "cursor", orch: "codex" },
	{ id: "orch-open", dur: 900, cursor: { x: 68.5, y: 37 }, modal: true, click: true, openMenu: "orch", worker: "cursor", orch: "codex" },
	{ id: "orch-hover", dur: 950, cursor: { x: 67, y: 48 }, modal: true, openMenu: "orch", menuHover: "claude-code", worker: "cursor", orch: "codex" },
	{ id: "orch-pick", dur: 650, cursor: { x: 67, y: 48 }, modal: true, click: true, worker: "cursor", orch: "claude-code" },
	{ id: "intake", dur: 1000, cursor: { x: 18.5, y: 66 }, modal: true, click: true, worker: "cursor", orch: "claude-code", intake: true },
	{ id: "type-1", dur: 260, cursor: { x: 24, y: 76.5 }, modal: true, worker: "cursor", orch: "claude-code", intake: true, assignee: "@" },
	{ id: "type-2", dur: 220, cursor: { x: 26, y: 76.5 }, modal: true, worker: "cursor", orch: "claude-code", intake: true, assignee: "@ja" },
	{ id: "type-3", dur: 500, cursor: { x: 28, y: 76.5 }, modal: true, worker: "cursor", orch: "claude-code", intake: true, assignee: "@jay" },
	{ id: "to-create", dur: 850, cursor: { x: 77, y: 90 }, modal: true, worker: "cursor", orch: "claude-code", intake: true, assignee: "@jay" },
	{ id: "creating", dur: 1400, cursor: { x: 77, y: 90 }, modal: true, click: true, busy: true, worker: "cursor", orch: "claude-code", intake: true, assignee: "@jay" },
	{ id: "started", dur: 2500, cursor: { x: 66, y: 50 }, worker: "cursor", orch: "claude-code", started: true },
	{ id: "reset", dur: 700, cursor: { x: 66, y: 50 }, ...IDLE, reset: true },
] as const;

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
function AgentSelectTrigger({ agentId, active }: { agentId: string; active: boolean }) {
	const agent = agentById(agentId);
	return (
		<div
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
			<Check className="size-3 shrink-0" style={{ color: T.mut }} aria-hidden="true" />
			<ChevronDown className="size-[13px] shrink-0 opacity-60" style={{ color: T.mut }} aria-hidden="true" />
		</div>
	);
}

function AgentMenu({ currentValue, hoverId, side }: { currentValue: string; hoverId: string | null | undefined; side: "left" | "right" }) {
	return (
		<motion.div
			initial={{ opacity: 0, y: -4, scale: 0.98 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			exit={{ opacity: 0, y: -3, scale: 0.98 }}
			transition={{ duration: 0.12, ease: [0.2, 0, 0, 1] }}
			className="absolute top-[72px] z-30 w-[calc(50%-30px)] overflow-hidden rounded-[10px] p-1"
			style={{
				[side]: 20,
				background: T.card,
				border: `1px solid ${T.line}`,
				boxShadow: "0 1px 0 rgba(0,0,0,0.2), 0 20px 50px rgba(0,0,0,0.55)",
			}}
		>
			{AGENTS.map((agent) => {
				const selected = agent.id === currentValue;
				const hovered = agent.id === hoverId;
				const disabled = agent.status !== "";
				return (
					<div
						key={agent.id}
						className="flex h-[26px] items-center gap-2 rounded-md px-2"
						style={{
							background: hovered ? T.hover : "transparent",
							opacity: disabled ? 0.45 : 1,
						}}
					>
						<AgentIcon src={agent.icon} />
						<span
							className="min-w-0 flex-1 truncate text-[12px]"
							style={{ color: hovered || selected ? T.fg : T.mut }}
						>
							{agent.label}
						</span>
						{agent.status ? (
							<span className="shrink-0 text-[9.5px]" style={{ color: T.warning }}>
								{agent.status}
							</span>
						) : null}
						{selected ? (
							<Check className="size-3 shrink-0" style={{ color: T.fg }} aria-hidden="true" />
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
			<motion.div animate={{ scale: pressed ? 0.82 : 1 }} transition={{ duration: 0.12 }}>
				<svg
					width="15"
					height="15"
					viewBox="0 0 24 24"
					className="-translate-x-[2px] -translate-y-[1px] drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]"
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
						initial={{ opacity: 0.5, scale: 0.3 }}
						animate={{ opacity: 0, scale: 1.7 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.45, ease: "easeOut" }}
						className="absolute -left-[8px] -top-[8px] size-[16px] rounded-full"
						style={{ border: `1.5px solid ${T.fg}` }}
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
function BoardView({ plusHover, started }: { plusHover: boolean; started: boolean }) {
	return (
		<div className="flex h-full">
			{/* Sidebar */}
			<div className="flex w-[158px] shrink-0 flex-col gap-1 border-r px-2 py-2.5" style={{ borderColor: T.line, background: T.bg }}>
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
				style={{ background: T.scrim, backdropFilter: "blur(1px)" }}
			/>
			{/* Panel */}
			<motion.div
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
							~/Downloads/test-component
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
							<AgentSelectTrigger agentId={worker} active={openMenu === "worker"} />
						</div>
						<div className="flex flex-col gap-1.5">
							<span className="text-[11px] font-medium" style={{ color: T.fg }}>
								Orchestrator agent
							</span>
							<AgentSelectTrigger agentId={orch} active={openMenu === "orch"} />
						</div>
					</div>

					{/* Cache / refresh row */}
					<div className="flex items-center justify-between text-[11px]">
						<span style={{ color: T.mut }}>Agent availability is cached.</span>
						<span style={{ color: T.fg }}>Refresh agents</span>
					</div>

					{/* Issue intake */}
					<div className="border-t pt-3.5" style={{ borderColor: T.line }}>
						<div className="flex items-center gap-2">
							<span
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
					<div className="flex items-center justify-end gap-2 pt-0.5">
						<span
							className="inline-flex h-8 items-center rounded-[10px] px-3.5 text-[12px]"
							style={{ border: `1px solid ${T.line}`, color: T.fg, opacity: busy ? 0.5 : 1 }}
						>
							Cancel
						</span>
						<span
							className="inline-flex h-8 items-center rounded-[10px] px-3.5 text-[12px] font-medium text-white"
							style={{ background: T.blue, opacity: busy ? 0.65 : 1 }}
						>
							{busy ? "Creating…" : "Create and start"}
						</span>
					</div>

					{/* Dropdowns — rendered inside the panel so they scale with it */}
					<AnimatePresence>
						{openMenu === "worker" ? (
							<AgentMenu key="worker" currentValue={worker} hoverId={menuHover} side="left" />
						) : openMenu === "orch" ? (
							<AgentMenu key="orch" currentValue={orch} hoverId={menuHover} side="right" />
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
	const [reducedMotion] = useState(
		() =>
			typeof window !== "undefined" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	);

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
			setSceneIndex((i) => (i + 1) % SCENES.length);
		};
		timer = window.setTimeout(tick, SCENES[sceneIndex]?.dur ?? 1000);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [sceneIndex, reducedMotion]);

	const scene = SCENES[sceneIndex] ?? SCENES[0]!;

	/* Static reduced-motion frame: the filled modal. */
	if (reducedMotion) {
		return (
			<FeaturePreviewShell title="Agent Orchestrator">
				<div
					className="relative h-[352px] overflow-hidden sm:h-[380px]"
					role="img"
					aria-label="Project agents dialog with Cursor as worker agent, Claude Code as orchestrator agent, and issue intake enabled."
				>
					<BoardView plusHover={false} started={false} />
					<ProjectAgentsModal
						worker="cursor"
						orch="claude-code"
						intake
						assignee="@jay"
						busy={false}
						openMenu={null}
						menuHover={null}
					/>
				</div>
			</FeaturePreviewShell>
		);
	}

	return (
		<FeaturePreviewShell title="Agent Orchestrator">
			<div
				ref={rootRef}
				className="relative h-[352px] overflow-hidden font-sans select-none sm:h-[380px]"
				role="img"
				aria-label="Demo: creating a project with Cursor as the worker agent, Claude Code as the orchestrator agent, and issue intake enabled."
			>
				<motion.div
					className="pointer-events-none absolute inset-0"
					animate={{ opacity: scene.reset ? 0 : 1 }}
					transition={{ duration: 0.3 }}
				>
					<BoardView plusHover={scene.plusHover === true} started={scene.started === true} />
					<AnimatePresence>
						{scene.modal ? (
							<ProjectAgentsModal
								key="modal"
								worker={scene.worker}
								orch={scene.orch}
								intake={scene.intake === true}
								assignee={scene.assignee ?? ""}
								busy={scene.busy === true}
								openMenu={scene.openMenu}
								menuHover={scene.menuHover}
							/>
						) : null}
					</AnimatePresence>
				</motion.div>
				<DemoCursor
					x={scene.cursor.x}
					y={scene.cursor.y}
					pressed={scene.click === true}
					clickId={scene.click ? sceneIndex : 0}
				/>
			</div>
		</FeaturePreviewShell>
	);
}
