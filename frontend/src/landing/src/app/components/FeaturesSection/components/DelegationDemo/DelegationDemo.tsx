"use client";

import { domAnimation, LazyMotion, m } from "motion/react";
import {
	BellRing,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	CircleAlert,
	Folder,
	LayoutGrid,
	Maximize2,
	MoreVertical,
	Network,
	PanelLeft,
	Pin,
	Plus,
	Search,
	Settings,
	Trash2,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

/* App-window palette — mirrors the desktop renderer, not the browser preview shell. */
const APP = {
	bg: "#0f0f12",
	panel: "#141417",
	elev: "#1d1d22",
	fg: "#ececef",
	mut: "#8b8b94",
	faint: "#5f5f68",
	line: "rgba(255,255,255,0.07)",
	line2: "rgba(255,255,255,0.045)",
	blue: "#2f6bff",
} as const;

const ST = {
	working: "#36c2b4",
	needs: "#f2b84b",
	review: "#5b8def",
	ready: "#9ad97a",
	idle: "#8e96a3",
	exit: "#ee6a6a",
} as const;

const TC = {
	mut: APP.mut,
	fg: APP.fg,
	blue: "#4d86ff",
	teal: ST.working,
	rev: ST.review,
	amber: ST.needs,
	faint: APP.faint,
} as const;

const PROJECT_NAME = "solkit-ui";

type Line = { id: string; node: ReactNode };
type OrcLine = Line & { spawn?: string };

type Worker = {
	id: string;
	task: string;
	prov: string;
	branch: string;
	statusLabel: string;
	color: string;
	breathe: boolean;
	lines: Line[];
};

const s = (color: string, text: ReactNode) => <span style={{ color }}>{text}</span>;

const ORC_LINES: OrcLine[] = [
	{
		id: "splash",
		node: (
			<div className="mb-2 flex items-start gap-2.5">
				<img
					src="/app-icons/agents/claude-code.svg"
					alt=""
					className="mt-0.5 size-5 shrink-0 object-contain"
					draggable={false}
				/>
				<div className="min-w-0">
					<div style={{ color: TC.fg, fontWeight: 700 }}>
						Claude Code <span style={{ color: TC.mut, fontWeight: 400 }}>v2.1.204</span>
					</div>
					<div style={{ color: TC.mut }}>Opus 4.8 (1M context) · Claude Team</div>
					<div className="truncate" style={{ color: TC.faint }}>~/ao/solkit-ui/orchestrator</div>
				</div>
			</div>
		),
	},
	{
		id: "brief",
		node: (
			<>
				{s(TC.mut, "orchestrator")} {s(TC.blue, "❯")} Ship GitHub sign-in, cover the callback flow, update setup
				docs.
			</>
		),
	},
	{
		id: "plan",
		node: (
			<>
				{s(TC.mut, "·")} planning — splitting the outcome into <b>3 tracks</b>
			</>
		),
	},
	{
		id: "spawn-claude",
		spawn: "claude",
		node: (
			<>
				{s(TC.blue, "➜")} {s(TC.mut, "ao")} spawn --name {s(TC.fg, '"callback route"')} --prompt{" "}
				{s(TC.mut, '"build GitHub callback route"')}
			</>
		),
	},
	{
		id: "spawn-codex",
		spawn: "codex",
		node: (
			<>
				{s(TC.blue, "➜")} {s(TC.mut, "ao")} spawn --name {s(TC.fg, '"integration tests"')} --prompt{" "}
				{s(TC.mut, '"cover the callback flow"')}
			</>
		),
	},
	{
		id: "spawn-cursor",
		spawn: "cursor",
		node: (
			<>
				{s(TC.blue, "➜")} {s(TC.mut, "ao")} spawn --name {s(TC.fg, '"setup guide"')} --prompt{" "}
				{s(TC.mut, '"update the auth setup docs"')}
			</>
		),
	},
	{ id: "monitor", node: s(TC.mut, "· monitoring 3 workers…") },
];

const WORKERS: Worker[] = [
	{
		id: "claude",
		task: "Build callback route",
		prov: "claude-code",
		branch: "ao/ao-12/auth-callback",
		statusLabel: "Working",
		color: ST.working,
		breathe: true,
		lines: [
			{ id: "c0", node: s(TC.mut, "Claude Code v2.1.204 · Opus 4.8 (1M context) · ~/ao/ao-12/auth-callback") },
			{ id: "c1", node: <>{s(TC.blue, "❯")} build the GitHub OAuth callback route</> },
			{
				id: "c2",
				node: (
					<>
						{s(TC.fg, "●")} reading {s(TC.mut, "src/auth/*.ts")}
					</>
				),
			},
			{
				id: "c3",
				node: (
					<>
						{s(TC.fg, "●")} editing {s(TC.mut, "src/auth/callback.ts")} {s(TC.teal, "(+48 −2)")}
					</>
				),
			},
			{
				id: "c4",
				node: (
					<>
						{"  "}$ npm run typecheck {"  "}
						{s(TC.teal, "✓ no type errors")}
					</>
				),
			},
			{
				id: "c5",
				node: (
					<>
						{"  "}$ npm test -- auth/callback {"  "}
						{s(TC.teal, "✓ 6 passing")}
					</>
				),
			},
			{ id: "c6", node: <>{s(TC.teal, "●")} validating state param + redirect</> },
		],
	},
	{
		id: "codex",
		task: "Add integration tests",
		prov: "codex",
		branch: "ao/ao-12/auth-flow",
		statusLabel: "In review",
		color: ST.review,
		breathe: true,
		lines: [
			{ id: "x0", node: s(TC.mut, "codex · ~/ao/ao-12/auth-flow") },
			{ id: "x1", node: <>$ codex exec {s(TC.fg, '"add integration tests for the callback flow"')}</> },
			{
				id: "x2",
				node: (
					<>
						{s(TC.fg, "●")} creating {s(TC.mut, "tests/auth/callback.spec.ts")} {s(TC.teal, "✓ 12 passing")}
					</>
				),
			},
			{
				id: "x3",
				node: (
					<>
						$ gh pr create --fill {"  "}
						{s(TC.rev, "→ ✓ opened PR #52")}
					</>
				),
			},
			{
				id: "x4",
				node: (
					<>
						{s(TC.rev, "↻")} CI {"  "}build {s(TC.teal, "✓")} {"  "}lint {s(TC.teal, "✓")} {"  "}test{" "}
						{s(TC.teal, "✓")}
					</>
				),
			},
		],
	},
	{
		id: "cursor",
		task: "Update setup guide",
		prov: "cursor",
		branch: "ao/ao-12/auth-docs",
		statusLabel: "Input needed",
		color: ST.needs,
		breathe: true,
		lines: [
			{ id: "u0", node: s(TC.mut, "cursor-agent · ~/ao/ao-12/auth-docs") },
			{
				id: "u1",
				node: (
					<>
						{s(TC.fg, "●")} updating {s(TC.mut, "docs/auth/setup.md")}
					</>
				),
			},
			{
				id: "u2",
				node: (
					<>
						{s(TC.fg, "●")} added {s(TC.mut, '"Configure GitHub OAuth"')} section
					</>
				),
			},
			{
				id: "u3",
				node: (
					<>
						{s(TC.amber, "▲")} decision needed: document <b>PKCE</b> or the <b>implicit</b> flow?
					</>
				),
			},
			{ id: "u4", node: s(TC.faint, "waiting for the orchestrator…") },
		],
	},
	{
		id: "login",
		task: "Fix login redirect",
		prov: "codex",
		branch: "fix/auth-redirect",
		statusLabel: "Idle",
		color: ST.idle,
		breathe: false,
		lines: [
			{ id: "l0", node: s(TC.mut, "codex · ~/solkit-ui/fix/auth-redirect") },
			{ id: "l1", node: <>$ codex exec {s(TC.fg, '"fix the login redirect loop"')}</> },
			{
				id: "l2",
				node: (
					<>
						{s(TC.fg, "●")} tracing {s(TC.mut, "middleware/auth.ts")}
					</>
				),
			},
			{ id: "l3", node: <>{s(TC.teal, "✓")} redirect preserves the requested destination</> },
		],
	},
	{
		id: "readme",
		task: "Tidy readme",
		prov: "claude-code",
		branch: "docs/readme-cleanup",
		statusLabel: "Idle",
		color: ST.idle,
		breathe: false,
		lines: [
			{ id: "r0", node: s(TC.mut, "Claude Code · ~/solkit-ui/docs/readme-cleanup") },
			{ id: "r1", node: <>{s(TC.blue, "❯")} tighten the installation guide</> },
			{
				id: "r2",
				node: (
					<>
						{s(TC.fg, "●")} editing {s(TC.mut, "README.md")} {s(TC.teal, "(+22 −14)")}
					</>
				),
			},
			{ id: "r3", node: <>$ markdownlint README.md {s(TC.teal, "✓ clean")}</> },
		],
	},
];

const OTHER: { name: string; sessions: string[] }[] = [{ name: "sandbox", sessions: [] }];

const MINI_BOARD_LANES = [
	{ label: "Working", color: ST.working, id: "claude" },
	{ label: "Needs you", color: ST.needs, id: "cursor" },
	{ label: "In review", color: ST.review, id: "codex" },
] as const;

const byId = (id: string) => WORKERS.find((w) => w.id === id);

function Dot({ color, breathe, size = 7 }: { color: string; breathe?: boolean; size?: number }) {
	return (
		<span
			className={breathe ? "animate-pulse" : undefined}
			style={{ width: size, height: size, borderRadius: 999, background: color, flex: "none" }}
		/>
	);
}

function Cursor() {
	return (
		<m.span
			aria-hidden
			style={{ display: "inline-block", width: 6, height: 12, background: APP.fg, verticalAlign: -2 }}
			animate={{ opacity: [1, 1, 0, 0] }}
			transition={{ repeat: Infinity, duration: 1, times: [0, 0.5, 0.5, 1], ease: "linear" }}
		/>
	);
}

function ShellNav({
	canGoForward,
	onBack,
	onForward,
	onSidebar,
}: {
	canGoForward: boolean;
	onBack: () => void;
	onForward: () => void;
	onSidebar: () => void;
}) {
	return (
		<div className="absolute left-2 top-1.5 z-20 flex items-center gap-1">
			<button
				type="button"
				aria-label="Toggle sidebar"
				onClick={onSidebar}
				className="grid size-6 place-items-center rounded-md hover:bg-white/5"
			>
				<PanelLeft size={14} style={{ color: APP.mut }} />
			</button>
			<button
				type="button"
				aria-label="Go back"
				onClick={onBack}
				className="grid size-6 place-items-center rounded-md hover:bg-white/5"
			>
				<ChevronLeft size={14} style={{ color: APP.mut }} />
			</button>
			<button
				type="button"
				aria-label="Go forward"
				disabled={!canGoForward}
				onClick={onForward}
				className="grid size-6 place-items-center rounded-md hover:bg-white/5 disabled:opacity-35"
			>
				<ChevronRight size={14} style={{ color: APP.mut }} />
			</button>
		</div>
	);
}

function StatusChip({ isOrc, worker }: { isOrc: boolean; worker?: Worker }) {
	if (isOrc) {
		return (
			<span style={chipStyle}>
				<Network size={12} /> Orchestrator
			</span>
		);
	}
	return (
		<span style={chipStyle}>
		<Dot color={worker?.color ?? ST.idle} breathe={worker?.breathe} size={7} />
			{worker?.task}
		</span>
	);
}

function AppTopBar({
	isOrc,
	worker,
	onKill,
	onKanban,
	onNotifications,
	onOrchestrator,
	onRunDemo,
}: {
	isOrc: boolean;
	worker?: Worker;
	onKill: () => void;
	onKanban: () => void;
	onNotifications: () => void;
	onOrchestrator: () => void;
	onRunDemo: () => void;
}) {
	return (
		<div
			className="flex h-[40px] items-center gap-2 px-3"
			style={{ borderBottom: `1px solid ${APP.line}`, background: APP.panel }}
		>
			{isOrc ? (
				<div className="hidden min-w-0 items-center gap-2 sm:flex" style={{ fontSize: 11, color: APP.mut }}>
					<span className="max-w-[106px] truncate" style={{ color: APP.fg, fontWeight: 600 }}>
						{PROJECT_NAME}
					</span>
					<span style={{ color: APP.faint }}>·</span>
					<StatusChip isOrc worker={worker} />
				</div>
			) : (
				<div className="flex min-w-0 items-center gap-2" style={{ color: APP.mut }}>
					<StatusChip isOrc={false} worker={worker} />
				</div>
			)}
			<div className="ml-auto flex shrink-0 items-center gap-[5px]">
				{!isOrc ? (
					<>
						<button type="button" onClick={onKill} style={killBtnStyle}>
							<Trash2 size={12} /> Kill
						</button>
						<button type="button" onClick={onOrchestrator} style={kanbanBtnStyle}>
							<Network size={12} /> Orchestrator
						</button>
					</>
				) : (
					<>
						<button type="button" aria-label="New task" onClick={onRunDemo} style={ghostBtnStyle}>
							<Plus size={13} /> <span className="hidden sm:inline">New task</span>
						</button>
						<button type="button" aria-label="Kanban" onClick={onKanban} style={kanbanBtnStyle}>
							<LayoutGrid size={13} /> <span className="hidden sm:inline">Kanban</span>
						</button>
					</>
				)}
				<button
					type="button"
					aria-label="Open notifications"
					onClick={onNotifications}
					className="relative grid size-6 place-items-center rounded-md hover:bg-white/5"
				>
					<BellRing size={15} fill="currentColor" style={{ color: APP.fg }} />
					<span
						className="absolute -right-1 -top-1 grid h-[14px] min-w-[14px] place-items-center rounded-full px-[3px] text-[8px] font-extrabold"
						style={{ background: APP.fg, color: APP.bg }}
					>
						7
					</span>
				</button>
			</div>
		</div>
	);
}

function ProjectRow({
	children,
	selected,
	onClick,
}: {
	children: ReactNode;
	selected?: boolean;
	onClick?: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="group flex items-center gap-[7px] rounded-md px-1.5 py-1.5 text-left text-[11px] font-semibold"
			style={{ color: selected ? APP.fg : APP.mut, background: selected ? APP.elev : "transparent" }}
		>
			<Folder size={14} style={{ color: APP.faint, flex: "none" }} />
			<span className="flex-1">{children}</span>
			<span
				className="flex gap-[5px] opacity-0 group-hover:opacity-100"
				style={{ color: APP.faint, opacity: selected ? 1 : undefined }}
			>
				<LayoutGrid size={13} />
				<Network size={13} />
				<MoreVertical size={13} />
			</span>
		</button>
	);
}

function SessionRow({ worker, active, onClick }: { worker: Worker; active: boolean; onClick: () => void }) {
	return (
		<m.button
			type="button"
			onClick={onClick}
			className="flex items-center gap-2 rounded-md py-[5px] pl-[22px] pr-1.5 text-left text-[10.5px]"
			style={{ color: active ? APP.fg : APP.mut, background: active ? APP.elev : "transparent" }}
		>
			<Dot color={worker.color} breathe={worker.breathe} />
			<span className="min-w-0 flex-1 truncate">{worker.task}</span>
		</m.button>
	);
}

function AppSidebar({
	active,
	query,
	setQuery,
	pinnedOpen,
	setPinnedOpen,
	filtered,
	onSelect,
}: {
	active: string;
	query: string;
	setQuery: (v: string) => void;
	pinnedOpen: boolean;
	setPinnedOpen: (fn: (v: boolean) => boolean) => void;
	filtered: string[];
	onSelect: (id: string) => void;
}) {
	return (
		<div className="flex min-w-0 flex-col" style={{ background: APP.panel }}>
			<div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2.5 scrollbar-hide">
				<div className="flex flex-nowrap items-center gap-2 px-1 pb-3">
					<img src="/ao-logo.svg" alt="" className="size-[18px] shrink-0" draggable={false} />
					<b className="hidden whitespace-nowrap text-[11px] font-bold tracking-[-0.2px] sm:block">
						Agent Orchestrator
					</b>
				</div>

				<div
					className="mx-0.5 mb-2 flex items-center gap-[7px] rounded-lg px-2.5 py-1.5 focus-within:border-white/25"
					style={{ background: APP.bg, border: `1px solid ${APP.line}` }}
				>
					<Search size={12} style={{ color: APP.faint }} />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search"
						aria-label="Search sessions"
						autoComplete="off"
						spellCheck={false}
						className="min-w-0 flex-1 border-none bg-transparent p-0 text-[10.5px] outline-none"
						style={{ color: APP.fg }}
					/>
				</div>

				<button
					type="button"
					onClick={() => setPinnedOpen((v) => !v)}
					className="flex items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-[10.5px] font-semibold hover:bg-white/5"
					style={{ color: APP.mut }}
				>
					<Pin size={12} />
					<span>Pinned</span>
					<ChevronDown
						size={12}
						className="ml-auto transition-transform"
						style={{ color: APP.faint, transform: pinnedOpen ? "rotate(180deg)" : undefined }}
					/>
				</button>
				{pinnedOpen && (
					<div className="px-1.5 py-1.5 pl-[22px] text-[10px]" style={{ color: APP.faint }}>
						No pinned sessions
					</div>
				)}

				<div
					className="flex items-center gap-1.5 px-1.5 pb-1 pt-2.5 text-[10px] font-semibold"
					style={{ color: APP.faint }}
				>
					<Folder size={12} />
					<span>Projects</span>
					<ChevronDown size={11} />
					<Plus size={12} className="ml-auto" />
				</div>

				<ProjectRow
					selected={["orc", "claude", "codex", "cursor"].includes(active)}
					onClick={() => onSelect("orc")}
				>
					{PROJECT_NAME}
				</ProjectRow>

				{filtered.map((id) => {
					const w = byId(id);
					if (!w) return null;
					return <SessionRow key={id} worker={w} active={active === id} onClick={() => onSelect(id)} />;
				})}
				{query && filtered.length === 0 && (
					<div className="py-[5px] pl-[22px] text-[10px]" style={{ color: APP.faint }}>
						No matches
					</div>
				)}

				{OTHER.map((p) => (
					<div key={p.name}>
						<ProjectRow
							selected={p.sessions.includes(active)}
							onClick={() => p.sessions[0] && onSelect(p.sessions[0])}
						>
							{p.name}
						</ProjectRow>
						{p.sessions.map((id) => {
							const session = byId(id);
							return session ? (
								<SessionRow
									key={id}
									worker={session}
									active={active === id}
									onClick={() => onSelect(id)}
								/>
							) : null;
						})}
					</div>
				))}
			</div>
			<div
				className="flex items-center gap-2 px-3 py-3 text-[10.5px]"
				style={{ color: APP.mut, borderTop: `1px solid ${APP.line}` }}
			>
				<Settings size={14} />
				<span>Settings</span>
			</div>
		</div>
	);
}

function AppTerminal({
	isOrc,
	orcLines,
	orcDone,
	worker,
}: {
	isOrc: boolean;
	orcLines: OrcLine[];
	orcDone: boolean;
	worker?: Worker;
}) {
	return (
		<div className="flex min-w-0 flex-col">
			<div className="flex h-[34px] items-center gap-2.5 px-3" style={{ borderBottom: `1px solid ${APP.line2}` }}>
				<span className="text-[9px] font-extrabold tracking-[0.8px]" style={{ color: APP.faint }}>
					TERMINAL
				</span>
				<span style={{ ...chipStyle, padding: "3px 9px", fontSize: 10 }}>
					{isOrc ? (
						<>
							<Network size={12} /> Orchestrator
						</>
					) : (
						worker?.task
					)}
				</span>
			</div>
			<div
				className="relative min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-3.5 py-3 font-mono leading-[1.66] scrollbar-hide"
				style={{ background: APP.bg, fontSize: 10.5 }}
			>
				<div className="absolute right-2 top-1.5 z-10 flex items-center gap-1 font-mono text-[9.5px]" style={{ color: APP.faint }}>
					<button type="button" className="grid size-5 place-items-center rounded hover:bg-white/5">−</button>
					<span className="w-6 text-center">11px</span>
					<button type="button" className="grid size-5 place-items-center rounded hover:bg-white/5">+</button>
					<button type="button" className="ml-0.5 grid size-5 place-items-center rounded hover:bg-white/5" aria-label="Fullscreen terminal">
						<Maximize2 size={12} />
					</button>
				</div>
				{isOrc ? (
					<>
						{orcLines.map((l) => (
							<div key={l.id} className="mb-px">
								{l.node}
							</div>
						))}
						<div className="mb-px">
							{orcDone ? <>{s(APP.mut, "· ")}</> : null}
							<Cursor />
						</div>
					</>
				) : (
					<>
						{worker?.lines.map((l, index) => (
							<m.div
								key={l.id}
								className="mb-px"
								initial={{ opacity: 0, y: 2 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ delay: index * 0.16, duration: 0.2 }}
							>
								{l.node}
							</m.div>
						))}
						<div className="mb-px">
							{worker?.color === ST.working ? <>{s(worker.color, "● ")}</> : null}
							<Cursor />
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function MiniBoard({ spawned, onSelect }: { spawned: string[]; onSelect: (id: string) => void }) {
	return (
		<div className="grid min-w-0 grid-cols-3" style={{ background: APP.bg }}>
			{MINI_BOARD_LANES.map((lane) => {
				const worker = byId(lane.id);
				return (
					<div key={lane.id} className="border-r p-2 last:border-r-0" style={{ borderColor: APP.line }}>
						<div
							className="mb-2 flex items-center gap-1.5 text-[8.5px] font-semibold"
							style={{ color: APP.mut }}
						>
							<Dot color={lane.color} size={6} />
							{lane.label}
						</div>
						{worker && spawned.includes(lane.id) ? (
							<button
								type="button"
								onClick={() => onSelect(lane.id)}
								className="w-full rounded-md border p-2 text-left hover:bg-white/5"
								style={{ borderColor: APP.line, background: APP.panel }}
							>
								<span className="block text-[9px] font-semibold">{worker.task}</span>
								<span
									className="mt-1 block truncate font-mono text-[7.5px]"
									style={{ color: APP.faint }}
								>
									{worker.branch}
								</span>
							</button>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

function NotificationPreview({ onOpen }: { onOpen: () => void }) {
	return (
		<m.div
			initial={{ opacity: 0, y: -4 }}
			animate={{ opacity: 1, y: 0 }}
			className="absolute right-2 top-10 z-20 w-[270px] overflow-hidden rounded-xl border text-left shadow-2xl"
			style={{ background: APP.panel, borderColor: APP.line }}
		>
			<div className="border-b px-3.5 py-3" style={{ background: APP.elev, borderColor: APP.line }}>
				<p className="text-[13px] font-semibold tracking-tight">Notifications</p>
			</div>
			<div className="flex items-center gap-1.5 px-3.5 pb-1 pt-2 text-[9px] font-medium uppercase tracking-wide" style={{ color: APP.faint }}>
				Unseen
				<span className="grid min-w-4 place-items-center rounded-full px-1 font-mono leading-4" style={{ background: APP.elev, color: APP.mut }}>
					1
				</span>
			</div>
			<button
				type="button"
				onClick={onOpen}
				className="group grid w-full grid-cols-[26px_minmax(0,1fr)] gap-2.5 px-3.5 py-2.5 text-left hover:bg-white/5"
			>
				<span className="mt-0.5 grid size-[26px] place-items-center rounded-md" style={{ background: APP.elev, color: ST.needs }}>
					<CircleAlert size={14} />
				</span>
				<span className="min-w-0">
					<span className="flex min-w-0 items-start gap-2">
						<span className="min-w-0 flex-1 text-[11px] font-medium leading-snug">Setup guide needs input</span>
						<time className="shrink-0 font-mono text-[8px]" style={{ color: APP.faint }}>now</time>
					</span>
					<span className="mt-0.5 block text-[10px] leading-snug" style={{ color: APP.mut }}>
						Choose whether the guide should document PKCE or the implicit flow.
					</span>
				</span>
			</button>
		</m.div>
	);
}

export function DelegationDemo() {
	const [spawned, setSpawned] = useState<string[]>(["orc"]);
	const [orcCount, setOrcCount] = useState(3);
	const [active, setActive] = useState("orc");
	const [query, setQuery] = useState("");
	const [pinnedOpen, setPinnedOpen] = useState(false);
	const [boardOpen, setBoardOpen] = useState(false);
	const [notificationsOpen, setNotificationsOpen] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const startedRef = useRef(false);
	const timerRef = useRef<number | undefined>(undefined);
	const rootRef = useRef<HTMLDivElement>(null);

	const start = useCallback(() => {
		if (startedRef.current) return;
		startedRef.current = true;
		const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (reduce) {
			setSpawned(["orc", "claude", "codex", "cursor"]);
			setOrcCount(ORC_LINES.length);
			return;
		}
		let i = 3;
		const tick = () => {
			i += 1;
			const line = ORC_LINES[i - 1];
			setOrcCount(i);
			if (line?.spawn) {
				const id = line.spawn;
				setSpawned((prev) => (prev.includes(id) ? prev : [...prev, id]));
			}
			if (i < ORC_LINES.length) {
				timerRef.current = window.setTimeout(tick, 560);
			} else {
				const focusOrder = ["claude", "codex", "cursor"];
				let focusIndex = 0;
				const focusNext = () => {
					if (focusIndex < focusOrder.length) {
						setActive(focusOrder[focusIndex]);
						setBoardOpen(false);
						focusIndex += 1;
						timerRef.current = window.setTimeout(focusNext, 1500);
						return;
					}
					timerRef.current = window.setTimeout(() => {
						setActive("orc");
						setBoardOpen(false);
						setSpawned(["orc"]);
						setOrcCount(3);
						i = 3;
						timerRef.current = window.setTimeout(tick, 700);
					}, 900);
				};
				timerRef.current = window.setTimeout(focusNext, 700);
			}
		};
		tick();
	}, []);

	useEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		const onVisible = () => {
			const r = el.getBoundingClientRect();
			const vh = window.innerHeight || 800;
			if (r.top < vh * 0.78 && r.bottom > vh * 0.22) start();
		};
		let io: IntersectionObserver | undefined;
		try {
			io = new IntersectionObserver(
				(entries) =>
					entries.forEach((e) => {
						if (e.isIntersecting && e.intersectionRatio > 0.4) start();
					}),
				{ threshold: [0, 0.4, 0.7] },
			);
			io.observe(el);
		} catch {
			/* IntersectionObserver unavailable — the scroll listener covers it. */
		}
		window.addEventListener("scroll", onVisible, { passive: true });
		window.addEventListener("resize", onVisible, { passive: true });
		const t = window.setTimeout(onVisible, 350);
		return () => {
			io?.disconnect();
			window.removeEventListener("scroll", onVisible);
			window.removeEventListener("resize", onVisible);
			window.clearTimeout(t);
			if (timerRef.current) window.clearTimeout(timerRef.current);
			startedRef.current = false;
		};
	}, [start]);

	const isOrc = active === "orc";
	const worker = isOrc ? undefined : byId(active);
	const needle = query.toLowerCase();
	const filtered = spawned.filter((id) => id !== "orc" && (byId(id)?.task.toLowerCase().includes(needle) ?? false));

	const killActive = () => {
		if (isOrc) return;
		setSpawned((prev) => prev.filter((id) => id !== active));
		setActive("orc");
	};
	const selectSession = (id: string) => {
		setActive(id);
		setBoardOpen(false);
	};
	const restartDemo = () => {
		if (timerRef.current) window.clearTimeout(timerRef.current);
		startedRef.current = false;
		setActive("orc");
		setSpawned(["orc"]);
		setOrcCount(3);
		setBoardOpen(false);
		timerRef.current = window.setTimeout(start, 120);
	};

	return (
		<LazyMotion features={domAnimation}>
			<div
				ref={rootRef}
				className="relative mx-auto w-full min-w-0 max-w-[620px] overflow-hidden rounded-xl border font-sans antialiased shadow-[0_28px_74px_-22px_rgba(0,0,0,0.86)]"
				style={{ background: APP.panel, color: APP.fg, borderColor: APP.line, fontSize: 12 }}
			>
				<ShellNav
					canGoForward={spawned.length > 1}
					onBack={() => selectSession("orc")}
					onForward={() => selectSession(spawned.find((id) => id !== "orc") ?? "orc")}
					onSidebar={() => setSidebarOpen((open) => !open)}
				/>
				{notificationsOpen ? (
					<NotificationPreview
						onOpen={() => {
							selectSession("cursor");
							setNotificationsOpen(false);
						}}
					/>
				) : null}
				<div
					className={`grid ${sidebarOpen ? "grid-cols-[132px_minmax(0,1fr)] sm:grid-cols-[180px_minmax(0,1fr)]" : "grid-cols-1"}`}
					style={{ height: 386 }}
				>
					{sidebarOpen ? (
						<div className="flex min-h-0 pt-9">
							<AppSidebar
								active={active}
								query={query}
								setQuery={setQuery}
								pinnedOpen={pinnedOpen}
								setPinnedOpen={setPinnedOpen}
								filtered={filtered}
								onSelect={selectSession}
							/>
						</div>
					) : null}
					<div
						className={`m-1 flex min-w-0 flex-col overflow-hidden rounded-lg border ${sidebarOpen ? "ml-0" : "ml-24"}`}
						style={{ background: APP.bg, borderColor: APP.line }}
					>
						<AppTopBar
							isOrc={isOrc}
							worker={worker}
							onKill={killActive}
							onKanban={() => setBoardOpen(true)}
							onNotifications={() => setNotificationsOpen((open) => !open)}
							onOrchestrator={() => selectSession("orc")}
							onRunDemo={restartDemo}
						/>
						{boardOpen ? (
							<MiniBoard spawned={spawned} onSelect={selectSession} />
						) : (
							<AppTerminal
								isOrc={isOrc}
								orcLines={ORC_LINES.slice(0, orcCount)}
								orcDone={orcCount >= ORC_LINES.length}
								worker={worker}
							/>
						)}
					</div>
				</div>
			</div>
		</LazyMotion>
	);
}

const chipStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	padding: "4px 9px",
	borderRadius: 8,
	background: APP.elev,
	border: `1px solid ${APP.line}`,
	fontSize: 10.5,
	fontWeight: 600,
	color: APP.fg,
	whiteSpace: "nowrap",
};

const baseTopBtn: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	height: 28,
	padding: "0 11px",
	borderRadius: 8,
	fontSize: 11,
	fontWeight: 650,
	whiteSpace: "nowrap",
	flexShrink: 0,
	cursor: "pointer",
	borderWidth: 1,
	borderStyle: "solid",
	borderColor: "transparent",
	background: "transparent",
	color: APP.fg,
};
const ghostBtnStyle: CSSProperties = {
	...baseTopBtn,
	padding: "0 9px",
	fontSize: 10.5,
	background: APP.elev,
	borderColor: APP.line,
};
const kanbanBtnStyle: CSSProperties = {
	...baseTopBtn,
	padding: "0 9px",
	fontSize: 10.5,
	background: APP.blue,
	color: "#fff",
};
const killBtnStyle: CSSProperties = {
	...baseTopBtn,
	color: "color-mix(in srgb, #ee6a6a 82%, #fff)",
	borderColor: "color-mix(in srgb, #ee6a6a 30%, transparent)",
};
