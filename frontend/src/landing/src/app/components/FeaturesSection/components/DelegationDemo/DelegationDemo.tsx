"use client";

import { domAnimation, LazyMotion, m } from "motion/react";
import {
	Bell,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Folder,
	LayoutGrid,
	Maximize2,
	Minus,
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
			<div className="flex items-start gap-3" style={{ margin: "2px 0 8px" }}>
				<span
					style={{
						width: 32,
						height: 32,
						borderRadius: 8,
						background: "rgba(217,119,87,0.14)",
						display: "grid",
						placeItems: "center",
						flex: "none",
					}}
				>
					<img
						src="/app-icons/coverage-claude-code.svg"
						alt=""
						style={{ width: 20, height: 20 }}
						draggable={false}
					/>
				</span>
				<div>
					<div style={{ color: TC.fg, fontWeight: 700 }}>
						Claude Code <span style={{ color: TC.mut, fontWeight: 400 }}>v2.1.204</span>
					</div>
					<div style={{ color: TC.mut }}>Opus 4.8 (1M context) with medium effort · Claude Team</div>
					<div style={{ color: TC.faint }}>~/.ao/data/worktrees/ao/orchestrator/ao-orchestrator</div>
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
		id: "worker-claude",
		node: (
			<>
				{"  "}
				{s(TC.teal, "✓")} worker <b>Claude</b> · {s(TC.mut, "ao/ao-12/auth-callback")}
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
		id: "worker-codex",
		node: (
			<>
				{"  "}
				{s(TC.teal, "✓")} worker <b>Codex</b> · {s(TC.mut, "ao/ao-12/auth-flow")}
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
	{
		id: "worker-cursor",
		node: (
			<>
				{"  "}
				{s(TC.teal, "✓")} worker <b>Cursor</b> · {s(TC.mut, "ao/ao-12/auth-docs")}
			</>
		),
	},
	{
		id: "route",
		node: (
			<>
				{s(TC.rev, "↻")} {s(TC.mut, 'ao send --session ao-12/auth-flow "rebase on the callback route"')}
			</>
		),
	},
	{
		id: "escalate",
		node: (
			<>
				{s(TC.amber, "▲")} {s(TC.mut, "ao/ao-12/auth-callback — needs a decision, escalated to you")}
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
			{ id: "c2", node: <>{s(TC.fg, "●")} reading {s(TC.mut, "src/auth/*.ts")}</> },
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
		breathe: false,
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
		breathe: false,
		lines: [
			{ id: "u0", node: s(TC.mut, "cursor-agent · ~/ao/ao-12/auth-docs") },
			{ id: "u1", node: <>{s(TC.fg, "●")} updating {s(TC.mut, "docs/auth/setup.md")}</> },
			{ id: "u2", node: <>{s(TC.fg, "●")} added {s(TC.mut, '"Configure GitHub OAuth"')} section</> },
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
];

const OTHER: { name: string; sessions: string[] }[] = [
	{ name: "sandbox", sessions: ["fix login redirect", "tidy readme"] },
	{ name: "scratch", sessions: [] },
];

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

function IconBtn({ children }: { children: ReactNode }) {
	return (
		<button type="button" className="grid size-6 place-items-center rounded-md hover:bg-white/5">
			{children}
		</button>
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

function AppTopBar({ isOrc, worker, onKill }: { isOrc: boolean; worker?: Worker; onKill: () => void }) {
	return (
		<div
			className="flex h-[42px] items-center gap-2 px-2.5"
			style={{ borderBottom: `1px solid ${APP.line}`, background: APP.panel }}
		>
			<div className="mr-1 flex gap-[7px]" aria-hidden>
				<span className="size-[11px] rounded-full" style={{ background: "#ff5f57" }} />
				<span className="size-[11px] rounded-full" style={{ background: "#febc2e" }} />
				<span className="size-[11px] rounded-full" style={{ background: "#28c840" }} />
			</div>
			<IconBtn>
				<PanelLeft size={15} style={{ color: APP.mut }} />
			</IconBtn>
			<IconBtn>
				<ChevronLeft size={15} style={{ color: APP.mut }} />
			</IconBtn>
			<IconBtn>
				<ChevronRight size={15} style={{ color: APP.mut }} />
			</IconBtn>
			<div className="flex min-w-0 items-center gap-2" style={{ fontSize: 11, color: APP.mut }}>
				<span style={{ color: APP.fg, fontWeight: 600 }}>demo</span>
				<span style={{ color: APP.faint }}>·</span>
				<StatusChip isOrc={isOrc} worker={worker} />
			</div>
			<div className="ml-auto flex items-center gap-[7px]">
				{!isOrc && (
					<button type="button" onClick={onKill} style={killBtnStyle}>
						<Trash2 size={12} /> Kill
					</button>
				)}
				<button type="button" style={ghostBtnStyle}>
					<Plus size={13} /> New task
				</button>
				<button type="button" style={kanbanBtnStyle}>
					<LayoutGrid size={13} /> Kanban
				</button>
				<button type="button" className="relative grid size-6 place-items-center rounded-md">
					<Bell size={15} style={{ color: APP.mut }} />
					<span
						className="absolute -right-1 -top-1 grid h-[14px] min-w-[14px] place-items-center rounded-full px-[3px] text-[8px] font-extrabold text-white"
						style={{ background: APP.blue }}
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
			initial={{ opacity: 0, x: -6 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
			className="flex items-center gap-2 rounded-md py-[5px] pl-[22px] pr-1.5 text-left text-[10.5px]"
			style={{ color: active ? APP.fg : APP.mut, background: active ? APP.elev : "transparent" }}
		>
			<Dot color={worker.color} breathe={worker.breathe} />
			<span className="min-w-0 flex-1 truncate">{worker.task}</span>
		</m.button>
	);
}

function AppSidebar({
	isOrc,
	active,
	query,
	setQuery,
	pinnedOpen,
	setPinnedOpen,
	filtered,
	onSelect,
}: {
	isOrc: boolean;
	active: string;
	query: string;
	setQuery: (v: string) => void;
	pinnedOpen: boolean;
	setPinnedOpen: (fn: (v: boolean) => boolean) => void;
	filtered: string[];
	onSelect: (id: string) => void;
}) {
	return (
		<div
			className="flex min-w-0 flex-col"
			style={{ background: APP.panel, borderRight: `1px solid ${APP.line}` }}
		>
			<div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2.5 scrollbar-hide">
				<div className="flex flex-nowrap items-center gap-2 px-1 pb-3">
					<img src="/ao-logo.svg" alt="" className="size-[18px] shrink-0" draggable={false} />
					<b className="whitespace-nowrap text-[11px] font-bold tracking-[-0.2px]">Agent Orchestrator</b>
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
					className="flex items-center gap-1.5 px-1.5 pb-1 pt-2.5 text-[9px] font-bold tracking-[0.9px]"
					style={{ color: APP.faint }}
				>
					<span>PROJECTS</span>
					<Plus size={12} className="ml-auto" />
				</div>

				<ProjectRow selected={isOrc} onClick={() => onSelect("orc")}>
					demo
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
						<ProjectRow>{p.name}</ProjectRow>
						{p.sessions.map((t) => (
							<div
								key={t}
								className="flex items-center gap-2 rounded-md py-[5px] pl-[22px] pr-1.5 text-[10.5px]"
								style={{ color: APP.mut }}
							>
								<Dot color={ST.idle} />
								<span className="min-w-0 flex-1 truncate">{t}</span>
							</div>
						))}
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
				<span className="ml-auto flex items-center gap-2 text-[9.5px]" style={{ color: APP.faint }}>
					<Minus size={12} />
					<span>11px</span>
					<Plus size={12} />
					<Maximize2 size={12} className="ml-0.5" />
				</span>
			</div>
			<div
				className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-3.5 py-3 font-mono leading-[1.66] scrollbar-hide"
				style={{ background: APP.bg, fontSize: 10.5 }}
			>
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
						{worker?.lines.map((l) => (
							<div key={l.id} className="mb-px">
								{l.node}
							</div>
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

export function DelegationDemo() {
	const [spawned, setSpawned] = useState<string[]>(["orc"]);
	const [orcCount, setOrcCount] = useState(0);
	const [active, setActive] = useState("orc");
	const [query, setQuery] = useState("");
	const [pinnedOpen, setPinnedOpen] = useState(false);
	const startedRef = useRef(false);
	const timerRef = useRef<number | undefined>(undefined);
	const rootRef = useRef<HTMLDivElement>(null);

	const start = useCallback(() => {
		if (startedRef.current) return;
		startedRef.current = true;
		const reduce =
			typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (reduce) {
			setSpawned(["orc", "claude", "codex", "cursor"]);
			setOrcCount(ORC_LINES.length);
			return;
		}
		let i = 0;
		const tick = () => {
			i += 1;
			const line = ORC_LINES[i - 1];
			setOrcCount(i);
			if (line?.spawn) {
				const id = line.spawn;
				setSpawned((prev) => (prev.includes(id) ? prev : [...prev, id]));
			}
			if (i < ORC_LINES.length) timerRef.current = window.setTimeout(tick, 560);
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
		};
	}, [start]);

	const isOrc = active === "orc";
	const worker = isOrc ? undefined : byId(active);
	const needle = query.toLowerCase();
	const filtered = spawned.filter(
		(id) => id !== "orc" && (byId(id)?.task.toLowerCase().includes(needle) ?? false),
	);

	const killActive = () => {
		if (isOrc) return;
		setSpawned((prev) => prev.filter((id) => id !== active));
		setActive("orc");
	};

	return (
		<LazyMotion features={domAnimation}>
			<div
				ref={rootRef}
				className="mx-auto w-full min-w-0 max-w-[620px] overflow-hidden rounded-xl border font-sans antialiased shadow-[0_28px_74px_-22px_rgba(0,0,0,0.86)]"
				style={{ background: APP.bg, color: APP.fg, borderColor: APP.line, fontSize: 12 }}
			>
				<AppTopBar isOrc={isOrc} worker={worker} onKill={killActive} />
				<div className="grid" style={{ gridTemplateColumns: "180px 1fr", height: 344 }}>
					<AppSidebar
						isOrc={isOrc}
						active={active}
						query={query}
						setQuery={setQuery}
						pinnedOpen={pinnedOpen}
						setPinnedOpen={setPinnedOpen}
						filtered={filtered}
						onSelect={setActive}
					/>
					<AppTerminal
						isOrc={isOrc}
						orcLines={ORC_LINES.slice(0, orcCount)}
						orcDone={orcCount >= ORC_LINES.length}
						worker={worker}
					/>
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
	cursor: "pointer",
	border: "1px solid transparent",
	background: "transparent",
	color: APP.fg,
};
const ghostBtnStyle: CSSProperties = { ...baseTopBtn, background: APP.elev, borderColor: APP.line };
const kanbanBtnStyle: CSSProperties = { ...baseTopBtn, background: APP.blue, color: "#fff" };
const killBtnStyle: CSSProperties = {
	...baseTopBtn,
	color: "color-mix(in srgb, #ee6a6a 82%, #fff)",
	borderColor: "color-mix(in srgb, #ee6a6a 30%, transparent)",
};
